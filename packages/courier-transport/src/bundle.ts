/**
 * Sneakernet bundles — the USB path.
 *
 * DESIGN.md §0 D-9 makes USB mass storage the primary wired transport and
 * deletes USB tethering, which on iOS raises a Wi-Fi access point unless the
 * user manually disables it and would therefore ship an E301 violation as a
 * side effect. Mass storage has no rules surface at all, and it is what the
 * most sophisticated team in this space actually retreated to after building
 * custom sync hardware.
 *
 * A bundle is a file. Copy it to a flash drive, walk it to the pit, copy it
 * off. There is no protocol, no pairing, and no radio.
 *
 * The bundle itself is NOT signed, and that is a deliberate design point rather
 * than an omission: every record inside it is already independently signed and
 * verified on admission, so a bundle signature would authenticate the courier
 * rather than the cargo — and the courier is a FAT32 volume that anyone at the
 * event can write to. Tampering with a bundle can drop records or add ones that
 * will be rejected; it cannot forge one.
 */

import {
  encode,
  decode,
  expectMap,
  expectArray,
  expectBytes,
  expectText,
  expectUint,
  RecordStore,
  type CborKey,
  type CborValue,
  type KeyResolver,
} from '@courier/core';

export const BUNDLE_VERSION = 1;
/** Conventional file extension. A bundle is content-addressed by its own hash. */
export const BUNDLE_EXTENSION = '.courier';

const B_VERSION = 1;
const B_EVENT = 2;
const B_CREATED_AT = 3;
const B_ENVELOPES = 4;
const B_PRODUCER = 5;

export interface BundleMeta {
  readonly version: number;
  readonly eventKey: string;
  readonly createdAt: number;
  /** Opaque, operator-chosen label. Never a person's name (D-20). */
  readonly producer: string;
  readonly count: number;
}

export interface Bundle extends BundleMeta {
  readonly envelopes: readonly Uint8Array[];
}

export class BundleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BundleError';
  }
}

export interface WriteBundleOptions {
  readonly eventKey: string;
  readonly producer: string;
  readonly createdAt?: number;
  /** Omit records already known to the destination, when that is known. */
  readonly exclude?: (envelope: Uint8Array) => boolean;
}

export function writeBundle(store: RecordStore, opts: WriteBundleOptions): Uint8Array {
  const envelopes: Uint8Array[] = [];
  for (const id of store.sortedIds) {
    const stored = store.get(id);
    if (!stored) continue;
    if (stored.record.eventKey !== opts.eventKey) continue;
    if (opts.exclude?.(stored.envelope)) continue;
    envelopes.push(stored.envelope);
  }

  return encode(
    new Map<CborKey, CborValue>([
      [B_VERSION, BUNDLE_VERSION],
      [B_EVENT, opts.eventKey],
      [B_CREATED_AT, opts.createdAt ?? Date.now()],
      [B_ENVELOPES, envelopes as CborValue[]],
      [B_PRODUCER, opts.producer],
    ]),
  );
}

export function readBundle(bytes: Uint8Array): Bundle {
  let m: Map<CborKey, CborValue>;
  try {
    m = expectMap(decode(bytes), 'bundle');
  } catch (err) {
    throw new BundleError(`not a valid bundle: ${(err as Error).message}`);
  }

  const version = expectUint(m.get(B_VERSION), 'bundle version');
  if (version !== BUNDLE_VERSION) {
    throw new BundleError(`unsupported bundle version ${version}`);
  }

  const envelopes = expectArray(m.get(B_ENVELOPES), 'bundle envelopes').map((e) =>
    expectBytes(e, 'envelope'),
  );

  return {
    version,
    eventKey: expectText(m.get(B_EVENT), 'bundle event key'),
    createdAt: expectUint(m.get(B_CREATED_AT), 'bundle createdAt'),
    producer: expectText(m.get(B_PRODUCER), 'bundle producer'),
    count: envelopes.length,
    envelopes,
  };
}

/**
 * Read the header fields, for a "should I copy this?" prompt.
 *
 * NOT a cheap header-only decode, though it used to say it was: the body calls
 * `readBundle`, which CBOR-decodes the whole buffer and builds a Uint8Array per
 * record before this function throws the envelopes away. Cost is the same as
 * reading the bundle properly. Stated because the old comment sold the opposite
 * cost model, and a caller sizing a prompt around it would be wrong by the whole
 * file.
 */
export function peekBundle(bytes: Uint8Array): BundleMeta {
  const b = readBundle(bytes);
  return {
    version: b.version,
    eventKey: b.eventKey,
    createdAt: b.createdAt,
    producer: b.producer,
    count: b.count,
  };
}

export interface MergeResult {
  readonly admitted: number;
  readonly duplicates: number;
  readonly rejected: number;
  readonly wrongEvent: number;
  readonly reasons: readonly string[];
}

/**
 * Merge a bundle into a store.
 *
 * Every envelope is verified individually on admission, so a bundle from a
 * stranger's flash drive is exactly as safe as one from your own — which is the
 * property that makes sneakernet usable between teams in a scouting alliance
 * without anybody trusting anybody.
 */
export function mergeBundle(
  store: RecordStore,
  bytes: Uint8Array,
  resolveKey: KeyResolver,
  expectEventKey?: string,
): MergeResult {
  const bundle = readBundle(bytes);

  if (expectEventKey !== undefined && bundle.eventKey !== expectEventKey) {
    return {
      admitted: 0,
      duplicates: 0,
      rejected: 0,
      wrongEvent: bundle.count,
      reasons: [
        `bundle is for event "${bundle.eventKey}" but "${expectEventKey}" was expected; ` +
          `nothing merged`,
      ],
    };
  }

  let admitted = 0;
  let duplicates = 0;
  let rejected = 0;
  const reasons: string[] = [];

  for (const envelope of bundle.envelopes) {
    const r = store.admit(envelope, resolveKey);
    if (r.status === 'admitted') admitted++;
    else if (r.status === 'duplicate') duplicates++;
    else {
      rejected++;
      if (r.reason && reasons.length < 8) reasons.push(r.reason);
    }
  }

  return { admitted, duplicates, rejected, wrongEvent: 0, reasons };
}
