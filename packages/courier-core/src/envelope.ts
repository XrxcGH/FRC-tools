/**
 * COSE_Sign1 envelope (RFC 9052 §4.2), tagged #6.18.
 *
 * The signature covers the WHOLE canonical record via the RFC 9052
 * Sig_structure — not just the body bytes. The draft's code sample signed only
 * the body, which would have left event key, match, team, scout pseudonym and
 * schema id freely tamperable while still verifying (D-10).
 */

import {
  encode,
  decode,
  encodeTagged,
  decodeTagged,
  expectMap,
  expectArray,
  expectBytes,
  CborError,
  type CborKey,
  type CborValue,
} from './cbor.ts';
import { decodeRecord, encodeRecord, recordId, type CourierRecord } from './record.ts';
import { hash256, toHex, KEY_ID_BYTES } from './hash.ts';
import { deriveKeyId, sign, verify, type DeviceKeyPair } from './keys.ts';

export const COSE_SIGN1_TAG = 18;
export const ALG_EDDSA = -8;

/** COSE header labels. 1 = alg, 4 = kid (RFC 9052 §3.1). */
const H_ALG = 1;
const H_KID = 4;

export const SIGNATURE_BYTES = 64;

export class EnvelopeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EnvelopeError';
  }
}

export interface OpenedEnvelope {
  readonly record: CourierRecord;
  readonly recordId: Uint8Array;
  readonly kid: Uint8Array;
}

/** Resolve a key id to the public key that may sign with it, or undefined if unknown. */
export type KeyResolver = (kid: Uint8Array) => Uint8Array | undefined;

function protectedHeader(kid: Uint8Array): Uint8Array {
  if (kid.length !== KEY_ID_BYTES) {
    throw new EnvelopeError(`kid must be ${KEY_ID_BYTES} bytes, got ${kid.length}`);
  }
  return encode(
    new Map<CborKey, CborValue>([
      [H_ALG, ALG_EDDSA],
      [H_KID, kid],
    ]),
  );
}

/**
 * Sig_structure = ["Signature1", body_protected, external_aad, payload].
 * external_aad is empty: there is no channel binding in v1, because v1 has no
 * session layer to bind to (D-24).
 */
function sigStructure(protectedBytes: Uint8Array, payload: Uint8Array): Uint8Array {
  return encode(['Signature1', protectedBytes, new Uint8Array(0), payload]);
}

export function sealRecord(record: CourierRecord, key: DeviceKeyPair): Uint8Array {
  const payload = encodeRecord(record);
  const prot = protectedHeader(key.kid);
  const signature = sign(sigStructure(prot, payload), key.secretKey);
  return encodeTagged(COSE_SIGN1_TAG, [
    prot,
    new Map<CborKey, CborValue>(),
    payload,
    signature,
  ]);
}

/**
 * Parse and verify an envelope.
 *
 * Throws on anything that is not a well-formed, correctly-signed v1 envelope
 * from a key the resolver recognises. A caller that wants to quarantine rather
 * than reject unknown-key envelopes should catch `EnvelopeError` and inspect
 * `peekKeyId` first.
 */
export function openEnvelope(bytes: Uint8Array, resolveKey: KeyResolver): OpenedEnvelope {
  // Any CBOR-level failure anywhere below is a malformed envelope from this
  // caller's point of view. Leaking CborError would make every caller catch two
  // error types to handle one condition.
  try {
    return openEnvelopeInner(bytes, resolveKey);
  } catch (err) {
    if (err instanceof CborError) throw new EnvelopeError(`malformed envelope: ${err.message}`);
    throw err;
  }
}

function openEnvelopeInner(bytes: Uint8Array, resolveKey: KeyResolver): OpenedEnvelope {
  const arr = expectArray(decodeTagged(bytes, COSE_SIGN1_TAG), 'COSE_Sign1');
  if (arr.length !== 4) {
    throw new EnvelopeError(`COSE_Sign1 must have 4 elements, got ${arr.length}`);
  }

  const prot = expectBytes(arr[0], 'protected header');
  const unprot = expectMap(arr[1]!, 'unprotected header');
  const payload = expectBytes(arr[2], 'payload');
  const signature = expectBytes(arr[3], 'signature', SIGNATURE_BYTES);

  if (unprot.size !== 0) {
    // Anything outside the signature is attacker-controlled. v1 has no use for
    // it, so the only safe policy is to refuse it rather than ignore it.
    throw new EnvelopeError('unprotected header must be empty in v1');
  }

  const hdr = expectMap(decode(prot), 'protected header');
  if (hdr.size !== 2) throw new EnvelopeError('protected header must contain exactly alg and kid');
  if (hdr.get(H_ALG) !== ALG_EDDSA) {
    throw new EnvelopeError(`unsupported alg ${String(hdr.get(H_ALG))}; expected EdDSA (${ALG_EDDSA})`);
  }
  const kid = expectBytes(hdr.get(H_KID), 'kid', KEY_ID_BYTES);

  const publicKey = resolveKey(kid);
  if (!publicKey) {
    throw new EnvelopeError(`unknown key id ${toHex(kid)}`);
  }
  // The kid is a hash of the public key, so a resolver returning a mismatched
  // key is a registry bug — catch it here rather than failing signature
  // verification with a confusing message.
  if (toHex(deriveKeyId(publicKey)) !== toHex(kid)) {
    throw new EnvelopeError(`resolver returned a key whose id is not ${toHex(kid)}`);
  }

  if (!verify(signature, sigStructure(prot, payload), publicKey)) {
    throw new EnvelopeError(`signature verification failed for key ${toHex(kid)}`);
  }

  const record = decodeRecord(payload);

  // record-id is defined over the canonical record, so recompute it from the
  // decoded record rather than hashing the payload we were handed. If a
  // non-canonical payload somehow verified, these would differ — and the
  // canonical one is by definition the record's identity.
  const id = recordId(record);
  if (toHex(hash256(payload)) !== toHex(id)) {
    throw new EnvelopeError('payload is not the canonical encoding of the record it contains');
  }

  return { record, recordId: id, kid };
}

/** Read the key id without verifying. For quarantine UI and pairing prompts only. */
export function peekKeyId(bytes: Uint8Array): Uint8Array | null {
  try {
    const arr = expectArray(decodeTagged(bytes, COSE_SIGN1_TAG), 'COSE_Sign1');
    const hdr = expectMap(decode(expectBytes(arr[0], 'protected header')), 'protected header');
    return expectBytes(hdr.get(H_KID), 'kid', KEY_ID_BYTES);
  } catch {
    return null;
  }
}

function bstrHeadLen(n: number): number {
  if (n < 24) return 1;
  if (n < 256) return 2;
  if (n < 65536) return 3;
  return 5;
}

/**
 * Exact envelope size without signing — for transport budgeting.
 *
 * Derived rather than estimated, so it cannot drift from reality:
 *   tag(1) + array head(1) + protected bstr head(1) + protected(13)
 *   + empty unprotected map(1) + payload bstr head + payload
 *   + signature bstr head(2) + signature(64)
 *
 * The protected header is a fixed 13 bytes: map(2) + alg key/value(2) + kid
 * key(1) + bstr(8) head(1) + 8.
 */
export const PROTECTED_HEADER_BYTES = 13;

export function envelopeSize(record: CourierRecord): number {
  const payload = encodeRecord(record).length;
  return (
    1 + // COSE_Sign1 tag
    1 + // array(4) head
    1 +
    PROTECTED_HEADER_BYTES +
    1 + // empty unprotected map
    bstrHeadLen(payload) +
    payload +
    bstrHeadLen(SIGNATURE_BYTES) +
    SIGNATURE_BYTES
  );
}
