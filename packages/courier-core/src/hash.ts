/**
 * Hashing and byte helpers.
 *
 * BLAKE3-256 throughout, per spec/canonical-cbor.md §3. It is used for three
 * distinct purposes that must not be confused with one another:
 *
 *   record-id  — BLAKE3(canonical-cbor(record)). The ONLY dedup key (D-2).
 *   body-hash  — BLAKE3(body). Integrity only, so a receiver can detect a
 *                truncated body without parsing it. Also the duplicate-*scan*
 *                suppression key at the Bridge's QR ingest, which is a
 *                different layer from record-level dedup.
 *   key-id     — BLAKE3(publicKey)[0..8]. A short handle for a device key.
 */

import { blake3 } from '@noble/hashes/blake3.js';

export const HASH_BYTES = 32;
export const KEY_ID_BYTES = 8;
export const SCOUT_PSEUDONYM_BYTES = 8;

export function hash256(...parts: Uint8Array[]): Uint8Array {
  if (parts.length === 1) return blake3(parts[0]!, { dkLen: HASH_BYTES });
  return blake3(concat(...parts), { dkLen: HASH_BYTES });
}

export function concat(...parts: Uint8Array[]): Uint8Array {
  let n = 0;
  for (const p of parts) n += p.length;
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

const HEX = '0123456789abcdef';

export function toHex(b: Uint8Array): string {
  let s = '';
  for (const byte of b) s += HEX[byte >> 4]! + HEX[byte & 15]!;
  return s;
}

export function fromHex(s: string): Uint8Array {
  if (s.length % 2 !== 0) throw new Error('hex string has odd length');
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) {
    const b = Number.parseInt(s.slice(i * 2, i * 2 + 2), 16);
    if (Number.isNaN(b)) throw new Error(`invalid hex at offset ${i * 2}`);
    out[i] = b;
  }
  return out;
}

export const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);

/**
 * Constant-time equality. Used when comparing a received signature, hash, or
 * pairing confirmation value against an expected one — anywhere an attacker
 * could otherwise learn a prefix from timing.
 */
export function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}
