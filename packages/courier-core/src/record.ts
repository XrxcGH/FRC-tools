/**
 * The Courier record — implementation of spec/courier-record.cddl.
 *
 * Courier never parses, validates, or logs `body`. It hashes it and moves it.
 * That opacity is the product thesis: every prior attempt to standardise
 * scouting SEMANTICS died, because teams have a positive incentive to diverge.
 * Standardising only the envelope asks nobody to give up their schema.
 */

import {
  encode,
  decode,
  expectMap,
  expectUint,
  expectText,
  expectBytes,
  CborError,
  type CborKey,
  type CborValue,
} from './cbor.ts';
import { hash256, timingSafeEqual, toHex, HASH_BYTES, SCOUT_PSEUDONYM_BYTES } from './hash.ts';

export const RECORD_VERSION = 1;

/** Field labels. These are wire constants — changing one is a format break. */
export const F = {
  VERSION: 1,
  EVENT_KEY: 2,
  MATCH: 3,
  TEAM: 4,
  SCOUT: 5,
  SCHEMA: 6,
  SEALED_AT: 7,
  REVISION: 8,
  BODY_HASH: 9,
  BODY_SIZE: 10,
  SUPERSEDES: 11,
  BODY: 12,
} as const;

/** Reserved in v1; a v2 record may carry these. Never reuse for anything else. */
export const RESERVED_FIELDS = new Set<number>([13 /* hlc */, 14 /* enc */]);

export const LIMITS = {
  EVENT_KEY_MIN: 4,
  EVENT_KEY_MAX: 16,
  TEAM_MAX: 99999,
  SCHEMA_MIN: 1,
  SCHEMA_MAX: 64,
  REVISION_MAX: 65535,
  BODY_MAX: 65536,
} as const;

export interface CourierRecord {
  readonly version: number;
  readonly eventKey: string;
  readonly match: number;
  readonly team: number;
  readonly scout: Uint8Array;
  readonly schema: string;
  readonly sealedAt: number;
  readonly revision: number;
  readonly bodyHash: Uint8Array;
  readonly bodySize: number;
  readonly supersedes: Uint8Array | null;
  readonly body: Uint8Array;
}

export class RecordError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RecordError';
  }
}

export interface NewRecordInput {
  eventKey: string;
  match: number;
  team: number;
  scout: Uint8Array;
  schema: string;
  body: Uint8Array;
  sealedAt?: number;
  revision?: number;
  supersedes?: Uint8Array | null;
}

/**
 * Build a record, deriving the integrity fields from the body so they cannot
 * disagree with it.
 *
 * `sealedAt` is accepted from the caller and defaults to now. It is retained
 * for display and staleness UI only and is explicitly NOT trusted for ordering
 * — a device with a wrong clock is a routine field condition, not an
 * exceptional one. Ordering uses `revision`, tie-broken on record-id.
 */
export function makeRecord(input: NewRecordInput): CourierRecord {
  const record: CourierRecord = {
    version: RECORD_VERSION,
    eventKey: input.eventKey,
    match: input.match,
    team: input.team,
    scout: input.scout,
    schema: input.schema,
    sealedAt: input.sealedAt ?? Date.now(),
    revision: input.revision ?? 0,
    bodyHash: hash256(input.body),
    bodySize: input.body.length,
    supersedes: input.supersedes ?? null,
    body: input.body,
  };
  validateRecord(record);
  return record;
}

/** Build the correction that supersedes an existing record. Append-only: the original survives. */
export function supersede(
  previous: CourierRecord,
  newBody: Uint8Array,
  sealedAt?: number,
): CourierRecord {
  return makeRecord({
    eventKey: previous.eventKey,
    match: previous.match,
    team: previous.team,
    scout: previous.scout,
    schema: previous.schema,
    body: newBody,
    revision: previous.revision + 1,
    supersedes: recordId(previous),
    sealedAt,
  });
}

export function validateRecord(r: CourierRecord): void {
  if (r.version !== RECORD_VERSION) {
    throw new RecordError(`unsupported record version ${r.version}`);
  }
  if (r.eventKey.length < LIMITS.EVENT_KEY_MIN || r.eventKey.length > LIMITS.EVENT_KEY_MAX) {
    throw new RecordError(
      `event key "${r.eventKey}" must be ${LIMITS.EVENT_KEY_MIN}..${LIMITS.EVENT_KEY_MAX} characters`,
    );
  }
  // Bounded at 32 bits by the packing scheme's shift widths (spec §2). Without
  // this the record type admits values the match unpacker cannot represent.
  if (!Number.isInteger(r.match) || r.match < 0 || r.match > 0xffffffff) {
    throw new RecordError(`packed match ${r.match} is not a 32-bit unsigned integer`);
  }
  if (!Number.isInteger(r.team) || r.team < 1 || r.team > LIMITS.TEAM_MAX) {
    throw new RecordError(`team ${r.team} out of range 1..${LIMITS.TEAM_MAX}`);
  }
  if (r.scout.length !== SCOUT_PSEUDONYM_BYTES) {
    throw new RecordError(`scout pseudonym must be ${SCOUT_PSEUDONYM_BYTES} bytes`);
  }
  if (r.schema.length < LIMITS.SCHEMA_MIN || r.schema.length > LIMITS.SCHEMA_MAX) {
    throw new RecordError(`schema id must be ${LIMITS.SCHEMA_MIN}..${LIMITS.SCHEMA_MAX} characters`);
  }
  if (!Number.isInteger(r.sealedAt) || r.sealedAt < 0) {
    throw new RecordError('sealedAt must be a non-negative integer');
  }
  if (!Number.isInteger(r.revision) || r.revision < 0 || r.revision > LIMITS.REVISION_MAX) {
    throw new RecordError(`revision ${r.revision} out of range 0..${LIMITS.REVISION_MAX}`);
  }
  if (r.bodyHash.length !== HASH_BYTES) {
    throw new RecordError(`body hash must be ${HASH_BYTES} bytes`);
  }
  if (r.body.length > LIMITS.BODY_MAX) {
    throw new RecordError(`body of ${r.body.length} bytes exceeds ${LIMITS.BODY_MAX}`);
  }
  if (r.supersedes !== null && r.supersedes.length !== HASH_BYTES) {
    throw new RecordError(`supersedes must be null or ${HASH_BYTES} bytes`);
  }
  if (r.supersedes !== null && r.revision === 0) {
    throw new RecordError('a record that supersedes another must have revision >= 1');
  }

  // The integrity fields must actually describe the body. Accepting them on
  // faith would make `body-hash` decorative and let a truncated body through.
  if (r.bodySize !== r.body.length) {
    throw new RecordError(`declared body size ${r.bodySize} != actual ${r.body.length}`);
  }
  if (!timingSafeEqual(r.bodyHash, hash256(r.body))) {
    throw new RecordError('declared body hash does not match the body');
  }
}

/* -------------------------------------------------------------------------- */
/* Wire form                                                                   */
/* -------------------------------------------------------------------------- */

export function encodeRecord(r: CourierRecord): Uint8Array {
  validateRecord(r);
  const m = new Map<CborKey, CborValue>([
    [F.VERSION, r.version],
    [F.EVENT_KEY, r.eventKey],
    [F.MATCH, r.match],
    [F.TEAM, r.team],
    [F.SCOUT, r.scout],
    [F.SCHEMA, r.schema],
    [F.SEALED_AT, r.sealedAt],
    [F.REVISION, r.revision],
    [F.BODY_HASH, r.bodyHash],
    [F.BODY_SIZE, r.bodySize],
    [F.SUPERSEDES, r.supersedes],
    [F.BODY, r.body],
  ]);
  return encode(m);
}

export function decodeRecord(bytes: Uint8Array): CourierRecord {
  let m: Map<CborKey, CborValue>;
  try {
    m = expectMap(decode(bytes), 'record');
  } catch (err) {
    if (err instanceof CborError) throw new RecordError(`record is not canonical CBOR: ${err.message}`);
    throw err;
  }

  for (const k of m.keys()) {
    if (typeof k !== 'number') throw new RecordError('record keys must be integers');
    if (RESERVED_FIELDS.has(k)) {
      throw new RecordError(
        `field ${k} is reserved for a later format version and must not appear in a v1 record`,
      );
    }
    if (k < 1 || k > 12) throw new RecordError(`unknown record field ${k}`);
  }

  const sup = m.get(F.SUPERSEDES);
  if (sup !== null && sup !== undefined && !(sup instanceof Uint8Array)) {
    throw new RecordError('supersedes: expected a byte string or null');
  }

  const record: CourierRecord = {
    version: expectUint(m.get(F.VERSION), 'version'),
    eventKey: expectText(m.get(F.EVENT_KEY), 'event key'),
    match: expectUint(m.get(F.MATCH), 'match'),
    team: expectUint(m.get(F.TEAM), 'team'),
    scout: expectBytes(m.get(F.SCOUT), 'scout pseudonym', SCOUT_PSEUDONYM_BYTES),
    schema: expectText(m.get(F.SCHEMA), 'schema id'),
    sealedAt: expectUint(m.get(F.SEALED_AT), 'sealed at'),
    revision: expectUint(m.get(F.REVISION), 'revision'),
    bodyHash: expectBytes(m.get(F.BODY_HASH), 'body hash', HASH_BYTES),
    bodySize: expectUint(m.get(F.BODY_SIZE), 'body size'),
    supersedes: (sup as Uint8Array | null | undefined) ?? null,
    body: expectBytes(m.get(F.BODY), 'body'),
  };

  validateRecord(record);
  return record;
}

/**
 * record-id = BLAKE3-256(canonical-cbor(record)).
 *
 * The ONLY dedup key in the system (D-2). Note that the scout pseudonym is part
 * of the hashed input, which is exactly why two scouts producing byte-identical
 * BODIES for the same robot both survive: their records differ, so their ids
 * differ. Deduplicating on body hash would drop one of them and silently
 * destroy the double-scouting signal that scout-reliability estimation needs.
 */
export function recordId(r: CourierRecord): Uint8Array {
  return hash256(encodeRecord(r));
}

export function recordIdHex(r: CourierRecord): string {
  return toHex(recordId(r));
}

/**
 * Ordering for two records describing the same (event, match, team, scout).
 * `revision` wins; ties break bytewise on record-id. Deterministic, clock-free,
 * and the reason v1 needs no hybrid logical clock (D-24).
 */
export function compareRecords(a: CourierRecord, b: CourierRecord): number {
  if (a.revision !== b.revision) return a.revision - b.revision;
  const ia = recordId(a);
  const ib = recordId(b);
  for (let i = 0; i < HASH_BYTES; i++) {
    if (ia[i]! !== ib[i]!) return ia[i]! - ib[i]!;
  }
  return 0;
}

/** The observation a record is about, independent of who reported it or when. */
export function observationKey(r: CourierRecord): string {
  return `${r.eventKey}/${r.match}/${r.team}`;
}
