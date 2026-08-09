/**
 * Conformance against the committed vectors in spec/vectors/.
 *
 * These do NOT regenerate. They compare the implementation against files that
 * are checked in, which is the entire point: a change that alters the wire
 * format fails here loudly instead of quietly moving the vectors with it.
 *
 * If one of these fails, exactly one of two things is true. Either the change
 * was unintended and is a compatibility break, or it was intended — in which
 * case the format version must move and every other implementation needs
 * telling. There is no third option where you just re-run the generator.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  encode,
  decode,
  toHex,
  fromHex,
  utf8,
  parseMatchKey,
  formatMatchKey,
  deviceKeyFromSecret,
  mintScoutPseudonym,
  makeRecord,
  encodeRecord,
  recordId,
  sealRecord,
  openEnvelope,
  encodeSyncMessage,
  rangeDigest,
  type CborKey,
  type CborValue,
} from '../src/index.ts';

const load = <T>(name: string): T =>
  JSON.parse(
    readFileSync(fileURLToPath(new URL(`../../../spec/vectors/${name}`, import.meta.url)), 'utf8'),
  ) as T;

/** Inverse of the generator's `describe`, so vectors stay human-readable on disk. */
function rehydrate(v: unknown): CborValue {
  if (v === null || typeof v === 'number' || typeof v === 'boolean' || typeof v === 'string') {
    return v;
  }
  if (Array.isArray(v)) return v.map(rehydrate);
  const o = v as { $bytes?: string; $map?: Array<[CborKey, unknown]> };
  if (typeof o.$bytes === 'string') return fromHex(o.$bytes);
  if (Array.isArray(o.$map)) {
    return new Map<CborKey, CborValue>(o.$map.map(([k, val]) => [k, rehydrate(val)]));
  }
  throw new Error(`cannot rehydrate ${JSON.stringify(v)}`);
}

/* ------------------------------------------------------------------ CBOR -- */

test('CBOR encoding matches the committed vectors', () => {
  const { cases } = load<{ cases: Array<{ name: string; value: unknown; hex: string }> }>('cbor.json');
  assert.ok(cases.length >= 20, 'the vector set should be substantial');

  for (const c of cases) {
    const value = rehydrate(c.value);
    assert.equal(toHex(encode(value)), c.hex, `encode: ${c.name}`);
  }
});

test('CBOR decoding round-trips every committed vector', () => {
  const { cases } = load<{ cases: Array<{ name: string; hex: string }> }>('cbor.json');
  for (const c of cases) {
    const bytes = fromHex(c.hex);
    // Decoding then re-encoding must be the identity. If it is not, two byte
    // strings share one meaning and record-id stops being well defined.
    assert.equal(toHex(encode(decode(bytes))), c.hex, `round-trip: ${c.name}`);
  }
});

test('map key ordering is by encoded bytes, as the vectors pin', () => {
  // The generator supplies these deliberately out of order.
  const { cases } = load<{ cases: Array<{ name: string; value: unknown; hex: string }> }>('cbor.json');
  const outOfOrder = cases.find((c) => c.name.includes('out of order'))!;
  assert.ok(outOfOrder, 'the out-of-order map case must exist');
  assert.equal(toHex(encode(rehydrate(outOfOrder.value))), outOfOrder.hex);
});

/* ------------------------------------------------------------ match keys -- */

test('match packing matches the committed vectors, and round-trips', () => {
  const { cases } = load<{
    cases: Array<{ key: string; eventKey: string; packed: number; roundTrip: string }>;
  }>('match-packing.json');

  for (const c of cases) {
    const { eventKey, packed } = parseMatchKey(c.key);
    assert.equal(eventKey, c.eventKey, `event key of ${c.key}`);
    assert.equal(packed, c.packed, `packed value of ${c.key}`);
    assert.equal(formatMatchKey(eventKey, packed), c.roundTrip, `round-trip of ${c.key}`);
    assert.equal(c.roundTrip, c.key, 'the vector itself must round-trip');
  }
});

/* ------------------------------------------------------------ pseudonyms -- */

test('scout pseudonyms match the committed vectors', () => {
  const v = load<{
    meshKeyHex: string;
    cases: Array<{ scout: string; eventKey: string; pseudonymHex: string }>;
  }>('scout-pseudonym.json');
  const meshKey = fromHex(v.meshKeyHex);

  for (const c of v.cases) {
    assert.equal(
      toHex(mintScoutPseudonym(c.scout, c.eventKey, meshKey)),
      c.pseudonymHex,
      `${c.scout}@${c.eventKey}`,
    );
  }
});

test('the vectors themselves demonstrate cross-event unlinkability', () => {
  // A property assertion about the pinned data, not just about the code: if
  // someone regenerates these and the property breaks, this catches it.
  const v = load<{ cases: Array<{ scout: string; eventKey: string; pseudonymHex: string }> }>(
    'scout-pseudonym.json',
  );
  const ada = v.cases.filter((c) => c.scout === 'ada');
  assert.ok(ada.length >= 2, 'the same scout must appear at two events');
  assert.notEqual(ada[0]!.pseudonymHex, ada[1]!.pseudonymHex, 'same person, different events');

  // And the length-prefixing case: ("ab","c027mose") vs ("a","bc027mose").
  const ab = v.cases.find((c) => c.scout === 'ab')!;
  const a = v.cases.find((c) => c.scout === 'a')!;
  assert.notEqual(ab.pseudonymHex, a.pseudonymHex, 'concatenation must not be ambiguous');
});

/* ---------------------------------------------------------------- record -- */

interface RecordVector {
  eventKey: string;
  match: number;
  team: number;
  scoutHex: string;
  schema: string;
  sealedAt: number;
  revision: number;
  bodyHashHex: string;
  bodySize: number;
  supersedesHex: string | null;
  bodyHex: string;
  canonicalHex: string;
  recordIdHex: string;
}

function rebuild(r: RecordVector) {
  return makeRecord({
    eventKey: r.eventKey,
    match: r.match,
    team: r.team,
    scout: fromHex(r.scoutHex),
    schema: r.schema,
    body: fromHex(r.bodyHex),
    sealedAt: r.sealedAt,
    revision: r.revision,
    supersedes: r.supersedesHex ? fromHex(r.supersedesHex) : null,
  });
}

test('record canonical encoding and record-id match the committed vectors', () => {
  const v = load<{ cases: Array<{ name: string; record: RecordVector }> }>('record.json');
  assert.equal(v.cases.length, 3);

  for (const c of v.cases) {
    const rebuilt = rebuild(c.record);
    assert.equal(toHex(encodeRecord(rebuilt)), c.record.canonicalHex, `canonical: ${c.name}`);
    assert.equal(toHex(recordId(rebuilt)), c.record.recordIdHex, `record-id: ${c.name}`);
    assert.equal(toHex(rebuilt.bodyHash), c.record.bodyHashHex, `body hash: ${c.name}`);
  }
});

test('the twin vector proves dedup must not key on the body hash', () => {
  // This is the property the whole deduplication design turns on, pinned as
  // data so no future implementation can quietly get it wrong.
  const v = load<{ cases: Array<{ name: string; record: RecordVector }> }>('record.json');
  const first = v.cases.find((c) => c.name.includes('first observation'))!.record;
  const twin = v.cases.find((c) => c.name.includes('twin'))!.record;

  assert.equal(twin.bodyHex, first.bodyHex, 'the bodies are byte-identical');
  assert.equal(twin.bodyHashHex, first.bodyHashHex, 'and so are their hashes');
  assert.notEqual(twin.recordIdHex, first.recordIdHex, 'but the record ids must differ');
  assert.notEqual(twin.scoutHex, first.scoutHex, 'because the scout differs');
});

test('the correction vector supersedes the first record by its real id', () => {
  const v = load<{ cases: Array<{ name: string; record: RecordVector }> }>('record.json');
  const first = v.cases.find((c) => c.name.includes('first observation'))!.record;
  const corrected = v.cases.find((c) => c.name.includes('correction'))!.record;

  assert.equal(corrected.supersedesHex, first.recordIdHex);
  assert.equal(corrected.revision, 1);
});

/* -------------------------------------------------------------- envelope -- */

test('signed envelopes match the committed vectors byte for byte', () => {
  // Ed25519 is deterministic (RFC 8032), so this pins the signature too — which
  // means it also pins that the signature covers the whole record rather than
  // just the body.
  const v = load<{
    secretKeyHex: string;
    publicKeyHex: string;
    kidHex: string;
    cases: Array<{ name: string; recordIdHex: string; envelopeHex: string }>;
  }>('envelope.json');

  const device = deviceKeyFromSecret(fromHex(v.secretKeyHex), 'software');
  assert.equal(toHex(device.publicKey), v.publicKeyHex, 'public key derivation');
  assert.equal(toHex(device.kid), v.kidHex, 'key id derivation');

  const records = load<{ cases: Array<{ name: string; record: RecordVector }> }>('record.json');
  const byName = new Map(records.cases.map((c) => [c.name, c.record]));

  for (const c of v.cases) {
    const source = c.name === 'correction' ? byName.get('correction superseding it')! : byName.get('first observation')!;
    const sealed = sealRecord(rebuild(source), device);
    assert.equal(toHex(sealed), c.envelopeHex, `envelope: ${c.name}`);
  }
});

test('a committed envelope opens and verifies against the committed key', () => {
  const v = load<{
    publicKeyHex: string;
    kidHex: string;
    cases: Array<{ name: string; recordIdHex: string; envelopeHex: string }>;
  }>('envelope.json');

  const publicKey = fromHex(v.publicKeyHex);
  const resolver = (kid: Uint8Array) => (toHex(kid) === v.kidHex ? publicKey : undefined);

  for (const c of v.cases) {
    const opened = openEnvelope(fromHex(c.envelopeHex), resolver);
    assert.equal(toHex(opened.recordId), c.recordIdHex, `record-id: ${c.name}`);
  }
});

test('a committed envelope with one flipped byte is rejected', () => {
  const v = load<{ publicKeyHex: string; kidHex: string; cases: Array<{ envelopeHex: string }> }>(
    'envelope.json',
  );
  const publicKey = fromHex(v.publicKeyHex);
  const resolver = (kid: Uint8Array) => (toHex(kid) === v.kidHex ? publicKey : undefined);

  const bytes = fromHex(v.cases[0]!.envelopeHex);
  for (const i of [5, 40, bytes.length - 5]) {
    const t = bytes.slice();
    t[i]! ^= 0x01;
    assert.throws(() => openEnvelope(t, resolver), `byte ${i} must be covered`);
  }
});

/* --------------------------------------------------------- sync messages -- */

test('sync message encoding matches the committed vectors', () => {
  const v = load<{ cases: Array<{ name: string; hex: string }> }>('sync-message.json');
  const records = load<{ cases: Array<{ record: RecordVector }> }>('record.json');
  const ids = records.cases
    .map((c) => fromHex(c.record.recordIdHex))
    .sort((a, b) => toHex(a).localeCompare(toHex(b)));

  const built = new Map<string, string>([
    ['root digest over three records', toHex(encodeSyncMessage({ digests: [rangeDigest(ids, '')] }))],
    ['empty digest (no records)', toHex(encodeSyncMessage({ digests: [rangeDigest([], '')] }))],
    [
      'want two truncated ids',
      toHex(encodeSyncMessage({ want: [ids[0]!.slice(0, 8), ids[1]!.slice(0, 8)] })),
    ],
    ['bare turn-return', toHex(encodeSyncMessage({ more: false }))],
  ]);

  for (const c of v.cases) {
    assert.equal(built.get(c.name), c.hex, `sync message: ${c.name}`);
  }
});

test('a bare turn-return is not the empty message', () => {
  // `{more: false}` keeps the conversation alive; an empty message ends it.
  // Pinning this stops a future encoder optimising the field away.
  const v = load<{ cases: Array<{ name: string; hex: string }> }>('sync-message.json');
  const turn = v.cases.find((c) => c.name === 'bare turn-return')!;
  assert.notEqual(turn.hex, toHex(encode(new Map<CborKey, CborValue>())));
  assert.ok(turn.hex.length > 2, 'it must carry the flag');
});

/* ------------------------------------------------------------------ meta -- */

test('every vector file carries a note explaining what it pins', () => {
  // A vector file without an explanation is a wall of hex that nobody can act
  // on when it fails.
  for (const name of [
    'cbor.json',
    'match-packing.json',
    'scout-pseudonym.json',
    'record.json',
    'envelope.json',
    'sync-message.json',
    'ble-framing.json',
  ]) {
    const v = load<{ note?: string }>(name);
    assert.ok(v.note && v.note.length > 60, `${name} needs a substantive note`);
  }
});

test('the committed key material is obviously fake', () => {
  // Nobody should ever be able to mistake a vector key for a real one.
  const v = load<{ secretKeyHex: string }>('envelope.json');
  assert.equal(v.secretKeyHex, '000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f');
  void utf8;
});
