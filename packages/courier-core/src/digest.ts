/**
 * Hierarchical range digests over the record-id space — the set-reconciliation
 * mechanism (D-3).
 *
 * The draft mandated rateless IBLT set reconciliation in a functional
 * requirement while the architecture section explicitly rejected it, because
 * sizing an IBLT requires estimating the symmetric difference in advance — the
 * quantity you are trying to discover. Range digests need no such estimate:
 * peers compare a root digest, and where it differs they descend only into the
 * subtrees that disagree. Cost scales with the size of the difference, not the
 * size of the set.
 *
 * The digest of a range is (count, XOR of ids). XOR is order-independent, which
 * is exactly right for comparing sets, and record ids are unique within a store
 * so the usual "identical elements cancel" objection does not apply. `count`
 * disambiguates the degenerate cases XOR alone would miss.
 */

import { compareBytes } from './cbor.ts';
import { HASH_BYTES } from './hash.ts';

/** One hex nibble per level. 16^4 = 65536 buckets is ample for an event. */
export const DIGEST_FANOUT = 16;
const HEX = '0123456789abcdef';

export interface DigestNode {
  /** Hex prefix of the record-id range this node covers. '' is the root. */
  readonly prefix: string;
  readonly count: number;
  readonly xor: Uint8Array;
}

export function emptyDigest(prefix: string): DigestNode {
  return { prefix, count: 0, xor: new Uint8Array(HASH_BYTES) };
}

/** The nibble of `id` at hex position `i`. */
export function nibbleAt(id: Uint8Array, i: number): number {
  const byte = id[i >> 1];
  if (byte === undefined) return 0;
  return (i & 1) === 0 ? byte >> 4 : byte & 0x0f;
}

function hasPrefix(id: Uint8Array, prefix: string): boolean {
  for (let i = 0; i < prefix.length; i++) {
    if (HEX[nibbleAt(id, i)] !== prefix[i]) return false;
  }
  return true;
}

export function rangeDigest(ids: readonly Uint8Array[], prefix = ''): DigestNode {
  const xor = new Uint8Array(HASH_BYTES);
  let count = 0;
  for (const id of ids) {
    for (let i = 0; i < HASH_BYTES; i++) xor[i]! ^= id[i]!;
    count++;
  }
  return { prefix, count, xor };
}

export function digestsEqual(a: DigestNode, b: DigestNode): boolean {
  if (a.count !== b.count) return false;
  return compareBytes(a.xor, b.xor) === 0;
}

/**
 * Bounds of the sorted id range covered by `prefix`, via binary search.
 * Returns [lo, hi) indices into `sortedIds`.
 */
export function prefixRange(
  sortedIds: readonly Uint8Array[],
  prefix: string,
): [number, number] {
  if (prefix === '') return [0, sortedIds.length];

  const lower = new Uint8Array(HASH_BYTES);
  const upper = new Uint8Array(HASH_BYTES).fill(0xff);
  for (let i = 0; i < prefix.length; i++) {
    const v = HEX.indexOf(prefix[i]!);
    if (v < 0) throw new Error(`invalid hex prefix "${prefix}"`);
    const bi = i >> 1;
    if ((i & 1) === 0) {
      lower[bi] = (lower[bi]! & 0x0f) | (v << 4);
      upper[bi] = (upper[bi]! & 0x0f) | (v << 4);
    } else {
      lower[bi] = (lower[bi]! & 0xf0) | v;
      upper[bi] = (upper[bi]! & 0xf0) | v;
    }
  }

  const lo = lowerBound(sortedIds, lower);
  const hi = upperBound(sortedIds, upper);
  return [lo, hi];
}

function lowerBound(a: readonly Uint8Array[], key: Uint8Array): number {
  let lo = 0;
  let hi = a.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (compareBytes(a[mid]!, key) < 0) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function upperBound(a: readonly Uint8Array[], key: Uint8Array): number {
  let lo = 0;
  let hi = a.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (compareBytes(a[mid]!, key) <= 0) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * The 16 child digests of `prefix`.
 *
 * Empty children are included deliberately. If this peer has nothing in bucket
 * 3 and the other has five records there, omitting the zero node would leave
 * the difference invisible.
 */
export function childDigests(
  sortedIds: readonly Uint8Array[],
  prefix: string,
): DigestNode[] {
  const [lo, hi] = prefixRange(sortedIds, prefix);
  const buckets: Uint8Array[][] = Array.from({ length: DIGEST_FANOUT }, () => []);
  for (let i = lo; i < hi; i++) {
    buckets[nibbleAt(sortedIds[i]!, prefix.length)]!.push(sortedIds[i]!);
  }
  return buckets.map((ids, n) => rangeDigest(ids, prefix + HEX[n]));
}

export function idsWithPrefix(
  sortedIds: readonly Uint8Array[],
  prefix: string,
): Uint8Array[] {
  const [lo, hi] = prefixRange(sortedIds, prefix);
  return sortedIds.slice(lo, hi).filter((id) => hasPrefix(id, prefix));
}

/**
 * Precompute every node down to `depth`. Not used by the streaming protocol,
 * which computes children on demand, but useful for diagnostics and for
 * measuring digest sizes when planning a transport budget.
 */
export function buildDigestTree(
  sortedIds: readonly Uint8Array[],
  depth: number,
): Map<string, DigestNode> {
  const out = new Map<string, DigestNode>();
  const walk = (prefix: string, d: number): void => {
    out.set(prefix, rangeDigest(idsWithPrefix(sortedIds, prefix), prefix));
    if (d === 0) return;
    for (const child of childDigests(sortedIds, prefix)) {
      if (child.count > 0) walk(child.prefix, d - 1);
    }
  };
  walk('', depth);
  return out;
}
