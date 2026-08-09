/**
 * The pairing ceremony — how a device joins a team's mesh.
 *
 * DESIGN.md §0 D-16 requires exactly one ceremony, because the draft described
 * three mutually exclusive ones across three sections. This is it.
 *
 * ── Shape ───────────────────────────────────────────────────────────────────
 * Two QR codes, passed between two screens held by two people standing next to
 * each other. No radio, no network, no server, and nothing to configure.
 *
 *   1. The JOINER shows a request QR: an ephemeral X25519 key, its long-term
 *      Ed25519 device key, and how that key is backed.
 *   2. The ADMITTER scans it, does ECDH, and shows a grant QR: its own
 *      ephemeral key plus the mesh secret and current roster, encrypted.
 *   3. The joiner scans the grant and decrypts it. Both screens now show the
 *      same six-digit code. The two people compare it out loud.
 *
 * ── Why this shape ──────────────────────────────────────────────────────────
 * The mesh key is a secret, and a QR code on a screen is visible to anyone with
 * a camera — including the team sitting behind you in the stands. So the grant
 * cannot carry it in the clear. Encrypting to an ephemeral key the joiner just
 * generated means a photograph of either QR is worthless: the request carries
 * only public keys, and the grant is sealed to a secret that never left the
 * joiner's device.
 *
 * The spoken code is what makes substitution detectable. An attacker who
 * photographs the request and races to present their own request to the
 * admitter gets a grant — but their transcript differs from the real joiner's,
 * so the two screens disagree and the humans notice. Six digits is 20 bits,
 * which is weak against an offline attacker and entirely adequate against one
 * who has to win a race in front of two people who are looking at each other.
 *
 * ── What this is NOT ────────────────────────────────────────────────────────
 * It is not a session layer. v1 has no link encryption (D-24); records are
 * signed, not secret, and anti-entropy is symmetric, so anyone you sync with
 * learns your store. Pairing controls who you agree to sync WITH. It does not
 * make the sync itself confidential.
 */

import { x25519 } from '@noble/curves/ed25519.js';
import {
  encode,
  decode,
  expectMap,
  expectArray,
  expectBytes,
  expectText,
  expectUint,
  hash256,
  utf8,
  toHex,
  timingSafeEqual,
  deriveKeyId,
  CborError,
  type CborKey,
  type CborValue,
  type DeviceKeyPair,
  type KeyBacking,
} from '@courier/core';
import type { RegisteredKey } from './registry.ts';

export const PAIRING_VERSION = 1;
export const SAS_DIGITS = 6;
const NONCE_BYTES = 12;
const KDF_CONTEXT = 'courier-pair-v1';
const SAS_CONTEXT = 'courier-sas-v1';

export class PairingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PairingError';
  }
}

/* -------------------------------------------------------------------------- */
/* Wire shapes                                                                 */
/* -------------------------------------------------------------------------- */

const R_VERSION = 1;
const R_EPH = 2;
const R_DEVICE = 3;
const R_BACKING = 4;
const R_LABEL = 5;

const G_VERSION = 1;
const G_EPH = 2;
const G_NONCE = 3;
const G_CIPHERTEXT = 4;

export interface JoinRequest {
  readonly version: number;
  readonly ephemeralPublic: Uint8Array;
  readonly devicePublic: Uint8Array;
  readonly backing: KeyBacking;
  /** Operator-chosen, non-name label. Never a student's name (D-20). */
  readonly label: string;
}

export interface PendingJoin {
  /** The QR payload the joiner displays. */
  readonly requestBytes: Uint8Array;
  /** Held on the joiner's device until the grant arrives. Never transmitted. */
  readonly ephemeralSecret: Uint8Array;
}

export interface MeshCredentials {
  readonly meshKey: Uint8Array;
  readonly eventKey: string;
  readonly roster: readonly RegisteredKey[];
}

function backingFromCode(n: number): KeyBacking {
  if (n === 1) return 'hardware';
  if (n === 0) return 'software';
  throw new PairingError(`unknown key backing code ${n}`);
}

function randomBytes(n: number): Uint8Array {
  const b = new Uint8Array(n);
  globalThis.crypto.getRandomValues(b);
  return b;
}

function randomX25519Secret(): Uint8Array {
  const u = x25519.utils as unknown as {
    randomSecretKey?: () => Uint8Array;
    randomPrivateKey?: () => Uint8Array;
  };
  const fn = u.randomSecretKey ?? u.randomPrivateKey;
  if (fn) return fn.call(x25519.utils);
  return randomBytes(32);
}

/* -------------------------------------------------------------------------- */
/* Step 1 — the joiner asks                                                    */
/* -------------------------------------------------------------------------- */

export function createJoinRequest(device: DeviceKeyPair, label: string): PendingJoin {
  if (!label || label.length > 32) {
    throw new PairingError('label must be 1-32 characters, and must not be a person’s name');
  }
  const ephemeralSecret = randomX25519Secret();
  const requestBytes = encode(
    new Map<CborKey, CborValue>([
      [R_VERSION, PAIRING_VERSION],
      [R_EPH, x25519.getPublicKey(ephemeralSecret)],
      [R_DEVICE, device.publicKey],
      [R_BACKING, device.backing === 'hardware' ? 1 : 0],
      [R_LABEL, label],
    ]),
  );
  return { requestBytes, ephemeralSecret };
}

export function parseJoinRequest(bytes: Uint8Array): JoinRequest {
  let m;
  try {
    m = expectMap(decode(bytes), 'join request');
  } catch (err) {
    if (err instanceof CborError) throw new PairingError(`malformed join request: ${err.message}`);
    throw err;
  }
  const version = expectUint(m.get(R_VERSION), 'pairing version');
  if (version !== PAIRING_VERSION) {
    throw new PairingError(`unsupported pairing version ${version}`);
  }
  return {
    version,
    ephemeralPublic: expectBytes(m.get(R_EPH), 'ephemeral public key', 32),
    devicePublic: expectBytes(m.get(R_DEVICE), 'device public key', 32),
    backing: backingFromCode(expectUint(m.get(R_BACKING), 'key backing')),
    label: expectText(m.get(R_LABEL), 'label'),
  };
}

/* -------------------------------------------------------------------------- */
/* Key agreement                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Derive the wrapping key from the ECDH secret, bound to both ephemeral keys.
 *
 * Binding the transcript into the KDF means a grant produced for one request
 * cannot be replayed against another, even if the attacker somehow reuses the
 * shared secret.
 */
function deriveWrappingKey(
  shared: Uint8Array,
  requestEph: Uint8Array,
  grantEph: Uint8Array,
): Uint8Array {
  return hash256(utf8(KDF_CONTEXT), shared, requestEph, grantEph);
}

async function aesKey(raw: Uint8Array, usage: KeyUsage[]): Promise<CryptoKey> {
  return globalThis.crypto.subtle.importKey('raw', raw as BufferSource, 'AES-GCM', false, usage);
}

/**
 * Six digits derived from the full transcript, shown on both screens.
 *
 * Both sides hash the same two QR payloads, so any substitution anywhere in the
 * exchange changes the code on exactly one screen.
 */
export function shortAuthString(requestBytes: Uint8Array, grantBytes: Uint8Array): string {
  const h = hash256(utf8(SAS_CONTEXT), requestBytes, grantBytes);
  const n = ((h[0]! << 16) | (h[1]! << 8) | h[2]!) % 10 ** SAS_DIGITS;
  return String(n).padStart(SAS_DIGITS, '0');
}

/* -------------------------------------------------------------------------- */
/* Step 2 — the admitter grants                                                */
/* -------------------------------------------------------------------------- */

export interface GrantResult {
  /** The QR payload the admitter displays. */
  readonly grantBytes: Uint8Array;
  /** Show this on screen. The two operators must read it to each other. */
  readonly sas: string;
  /** The joining device, ready to be added to the registry once SAS matches. */
  readonly joiner: RegisteredKey;
}

export async function grantJoin(
  requestBytes: Uint8Array,
  credentials: MeshCredentials,
  now: number = Date.now(),
): Promise<GrantResult> {
  const request = parseJoinRequest(requestBytes);

  const ephemeralSecret = randomX25519Secret();
  const grantEph = x25519.getPublicKey(ephemeralSecret);
  const shared = x25519.getSharedSecret(ephemeralSecret, request.ephemeralPublic);
  const wrapping = deriveWrappingKey(shared, request.ephemeralPublic, grantEph);

  const plaintext = encode(
    new Map<CborKey, CborValue>([
      [1, credentials.meshKey],
      [2, credentials.eventKey],
      [
        3,
        credentials.roster.map(
          (k) =>
            [k.publicKey, k.backing === 'hardware' ? 1 : 0, k.label, k.addedAt] as CborValue,
        ),
      ],
    ]),
  );

  const nonce = randomBytes(NONCE_BYTES);
  const ct = new Uint8Array(
    await globalThis.crypto.subtle.encrypt(
      { name: 'AES-GCM', iv: nonce as BufferSource },
      await aesKey(wrapping, ['encrypt']),
      plaintext as BufferSource,
    ),
  );

  const grantBytes = encode(
    new Map<CborKey, CborValue>([
      [G_VERSION, PAIRING_VERSION],
      [G_EPH, grantEph],
      [G_NONCE, nonce],
      [G_CIPHERTEXT, ct],
    ]),
  );

  return {
    grantBytes,
    sas: shortAuthString(requestBytes, grantBytes),
    joiner: {
      kid: deriveKeyId(request.devicePublic),
      publicKey: request.devicePublic,
      backing: request.backing,
      label: request.label,
      addedAt: now,
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Step 3 — the joiner accepts                                                 */
/* -------------------------------------------------------------------------- */

export interface AcceptResult extends MeshCredentials {
  /** Must match the admitter's screen before either operator taps confirm. */
  readonly sas: string;
}

export async function acceptGrant(
  grantBytes: Uint8Array,
  pending: PendingJoin,
): Promise<AcceptResult> {
  let m;
  try {
    m = expectMap(decode(grantBytes), 'join grant');
  } catch (err) {
    if (err instanceof CborError) throw new PairingError(`malformed join grant: ${err.message}`);
    throw err;
  }

  const version = expectUint(m.get(G_VERSION), 'pairing version');
  if (version !== PAIRING_VERSION) throw new PairingError(`unsupported pairing version ${version}`);

  const grantEph = expectBytes(m.get(G_EPH), 'ephemeral public key', 32);
  const nonce = expectBytes(m.get(G_NONCE), 'nonce', NONCE_BYTES);
  const ct = expectBytes(m.get(G_CIPHERTEXT), 'ciphertext');

  const request = parseJoinRequest(pending.requestBytes);
  const shared = x25519.getSharedSecret(pending.ephemeralSecret, grantEph);
  const wrapping = deriveWrappingKey(shared, request.ephemeralPublic, grantEph);

  let plaintext: Uint8Array;
  try {
    plaintext = new Uint8Array(
      await globalThis.crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: nonce as BufferSource },
        await aesKey(wrapping, ['decrypt']),
        ct as BufferSource,
      ),
    );
  } catch {
    // AES-GCM authentication failure. Either this grant was not meant for this
    // request, or someone altered it in flight.
    throw new PairingError(
      'could not decrypt the grant. It was issued for a different join request, or it has ' +
        'been tampered with. Start the ceremony again.',
    );
  }

  const p = expectMap(decode(plaintext), 'grant contents');
  const roster = expectArray(p.get(3), 'roster').map((entry) => {
    const e = expectArray(entry, 'roster entry');
    const publicKey = expectBytes(e[0], 'roster public key', 32);
    return {
      kid: deriveKeyId(publicKey),
      publicKey,
      backing: backingFromCode(expectUint(e[1], 'roster backing')),
      label: expectText(e[2], 'roster label'),
      addedAt: expectUint(e[3], 'roster addedAt'),
    } satisfies RegisteredKey;
  });

  return {
    meshKey: expectBytes(p.get(1), 'mesh key', 32),
    eventKey: expectText(p.get(2), 'event key'),
    roster,
    sas: shortAuthString(pending.requestBytes, grantBytes),
  };
}

/** Compare two short authentication strings without leaking a prefix by timing. */
export function sasMatches(a: string, b: string): boolean {
  return a.length === b.length && timingSafeEqual(utf8(a), utf8(b));
}

/** Diagnostics only — never a security boundary. */
export function describeRequest(bytes: Uint8Array): string {
  const r = parseJoinRequest(bytes);
  return `${r.label} (${toHex(deriveKeyId(r.devicePublic)).toUpperCase()}, ${r.backing}-backed)`;
}
