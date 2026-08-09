/**
 * Device keys, mesh keys, and scout pseudonyms.
 *
 * ── Deviation from the draft, recorded deliberately ──────────────────────────
 * DESIGN.md §0 D-10 says keys are "hardware-backed where the platform provides
 * it, software-backed otherwise, and the envelope records which."
 *
 * This implementation records the backing in the KEY REGISTRY (bound to the kid
 * at pairing time) rather than in every envelope. Reasons:
 *
 *   1. Backing is a property of the key, not of the record. Repeating it in all
 *      ~640 records of an event day is redundant.
 *   2. A record field is self-asserted per-record and trivially forged; a
 *      registry entry is asserted once, during a pairing ceremony where the
 *      operator is physically present and can see what device they are adding.
 *   3. The consumer of the fact is a UI warning ("this scout's key is software-
 *      backed on an unpatched Chromebook"), which needs it per-device.
 *
 * The requirement D-10 exists to serve — that the system never silently claims
 * a hardware guarantee it does not have — is satisfied, and satisfied more
 * honestly. See spec/courier-record.cddl for the wire-format consequence
 * (none: no field is added).
 */

import { ed25519 } from '@noble/curves/ed25519.js';
import { hash256, KEY_ID_BYTES, SCOUT_PSEUDONYM_BYTES, utf8, concat, toHex } from './hash.ts';

/**
 * Where a device's signing key actually lives.
 *
 * `hardware` requires a non-exportable platform keystore (Android Keystore with
 * StrongBox, iOS Secure Enclave). On ChromeOS and the web this is simply not
 * available — an AUE'd Chromebook has no WebCrypto Ed25519 at all — so those
 * devices are honestly `software` and the UI must say so rather than implying a
 * guarantee that does not exist.
 */
export type KeyBacking = 'hardware' | 'software';

export interface DeviceKeyPair {
  readonly secretKey: Uint8Array;
  readonly publicKey: Uint8Array;
  /** BLAKE3(publicKey)[0..8] — the short handle carried in the COSE header. */
  readonly kid: Uint8Array;
  readonly backing: KeyBacking;
}

// The registered-key type and the trust policy that goes with it live in
// @courier/pairing, which owns who a device accepts records from. Core owns the
// cryptography and stays out of the policy.

function randomSecretKey(): Uint8Array {
  const u = ed25519.utils as unknown as {
    randomSecretKey?: () => Uint8Array;
    randomPrivateKey?: () => Uint8Array;
  };
  const fn = u.randomSecretKey ?? u.randomPrivateKey;
  if (!fn) throw new Error('@noble/curves: no random secret key generator found');
  return fn.call(ed25519.utils);
}

export function deriveKeyId(publicKey: Uint8Array): Uint8Array {
  return hash256(publicKey).slice(0, KEY_ID_BYTES);
}

export function generateDeviceKey(backing: KeyBacking = 'software'): DeviceKeyPair {
  const secretKey = randomSecretKey();
  const publicKey = ed25519.getPublicKey(secretKey);
  return { secretKey, publicKey, kid: deriveKeyId(publicKey), backing };
}

export function deviceKeyFromSecret(
  secretKey: Uint8Array,
  backing: KeyBacking = 'software',
): DeviceKeyPair {
  const publicKey = ed25519.getPublicKey(secretKey);
  return { secretKey, publicKey, kid: deriveKeyId(publicKey), backing };
}

export function sign(message: Uint8Array, secretKey: Uint8Array): Uint8Array {
  return ed25519.sign(message, secretKey);
}

export function verify(
  signature: Uint8Array,
  message: Uint8Array,
  publicKey: Uint8Array,
): boolean {
  try {
    return ed25519.verify(signature, message, publicKey);
  } catch {
    // A malformed signature or point is a verification failure, not a crash.
    return false;
  }
}

/* -------------------------------------------------------------------------- */
/* Mesh key and scout pseudonyms                                              */
/* -------------------------------------------------------------------------- */

export const MESH_KEY_BYTES = 32;

/**
 * The per-mesh symmetric secret, established once during the pairing ceremony
 * and shared by every device on one team's mesh. In v1 its only job is to make
 * scout pseudonyms unlinkable across teams; it is not an encryption key,
 * because v1 has no body encryption (D-24).
 */
export function generateMeshKey(): Uint8Array {
  const k = new Uint8Array(MESH_KEY_BYTES);
  globalThis.crypto.getRandomValues(k);
  return k;
}

/**
 * Mint the per-event scout pseudonym carried in record field 5.
 *
 *   sid_event = BLAKE3(scoutId ‖ eventKey ‖ meshKey)[0..8]
 *
 * Minted at SEAL time and placed in the signed record from the start (D-6). The
 * draft proposed rewriting the scout id at egress instead; that is
 * mathematically impossible, because the id is inside the COSE_Sign1 payload —
 * rewriting it invalidates the signature and changes the record-id, so a
 * partner would receive an unverifiable record that double-counts against the
 * original if it ever loops back.
 *
 * Minting at seal time gets what egress rewriting was reaching for: the raw
 * scout id never leaves the device, and the same human at two different events
 * is unlinkable, by construction.
 */
export function mintScoutPseudonym(
  scoutId: Uint8Array | string,
  eventKey: string,
  meshKey: Uint8Array,
): Uint8Array {
  if (meshKey.length !== MESH_KEY_BYTES) {
    throw new Error(`mesh key must be ${MESH_KEY_BYTES} bytes, got ${meshKey.length}`);
  }
  const sid = typeof scoutId === 'string' ? utf8(scoutId) : scoutId;
  // Length-prefix each part so that ("ab","c") and ("a","bc") cannot collide.
  return hash256(
    lengthPrefixed(sid),
    lengthPrefixed(utf8(eventKey)),
    lengthPrefixed(meshKey),
  ).slice(0, SCOUT_PSEUDONYM_BYTES);
}

function lengthPrefixed(b: Uint8Array): Uint8Array {
  const n = new Uint8Array(4);
  new DataView(n.buffer).setUint32(0, b.length, false);
  return concat(n, b);
}

/** Short, human-readable device handle for pairing UI. Not a security boundary. */
export function kidLabel(kid: Uint8Array): string {
  return toHex(kid).slice(0, 8).toUpperCase();
}
