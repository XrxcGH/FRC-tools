/**
 * Generate the conformance vectors in spec/vectors/.
 *
 *   node spec/generate-vectors.ts
 *
 * The vectors are COMMITTED, and `conformance.test.ts` compares the
 * implementation against the committed files rather than regenerating them.
 * That is the entire point: if a change alters the wire format, the test fails
 * loudly instead of the vectors quietly moving with it.
 *
 * So: regenerating is a deliberate act. If this changes a vector, either you
 * meant to change the format — in which case the format version must move too —
 * or you have just broken compatibility with every other implementation.
 *
 * Every key here is FIXED, not random. Ed25519 is deterministic (RFC 8032), so
 * a fixed secret key gives a reproducible signature, which means even the
 * signed envelope can be pinned byte for byte.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  encode,
  toHex,
  utf8,
  hash256,
  packMatch,
  parseMatchKey,
  formatMatchKey,
  deviceKeyFromSecret,
  mintScoutPseudonym,
  makeRecord,
  encodeRecord,
  recordId,
  sealRecord,
  encodeSyncMessage,
  rangeDigest,
  type CborKey,
  type CborValue,
} from '../packages/courier-core/src/index.ts';
import { split } from '../packages/courier-ble/src/index.ts';

const OUT = fileURLToPath(new URL('./vectors/', import.meta.url));
mkdirSync(OUT, { recursive: true });

const write = (name: string, value: unknown): void => {
  writeFileSync(`${OUT}${name}`, JSON.stringify(value, null, 2) + '\n');
  console.log(`wrote vectors/${name}`);
};

/* ---------------------------------------------------------------- fixtures */

/** Fixed, obviously-fake key material. Never use these for anything real. */
const SECRET_KEY = new Uint8Array(32);
for (let i = 0; i < 32; i++) SECRET_KEY[i] = i;

const MESH_KEY = new Uint8Array(32);
for (let i = 0; i < 32; i++) MESH_KEY[i] = 0xa0 ^ i;

const DEVICE = deviceKeyFromSecret(SECRET_KEY, 'software');
const EVENT = '2027mose';
const SEALED_AT = 1_800_000_000_000;

/* ------------------------------------------------------------------- CBOR */

const cborCases: Array<{ name: string; value: CborValue }> = [
  { name: 'uint 0', value: 0 },
  { name: 'uint 23 (inline boundary)', value: 23 },
  { name: 'uint 24 (one-byte boundary)', value: 24 },
  { name: 'uint 255', value: 255 },
  { name: 'uint 256', value: 256 },
  { name: 'uint 65535', value: 65535 },
  { name: 'uint 65536', value: 65536 },
  { name: 'uint 4294967295', value: 4294967295 },
  { name: 'uint 4294967296', value: 4294967296 },
  { name: 'negint -1', value: -1 },
  { name: 'negint -256', value: -256 },
  { name: 'false', value: false },
  { name: 'true', value: true },
  { name: 'null', value: null },
  { name: 'empty text', value: '' },
  { name: 'ascii text', value: 'IETF' },
  { name: 'non-ascii text', value: 'ü' },
  { name: 'empty bytes', value: new Uint8Array(0) },
  { name: 'bytes 01020304', value: new Uint8Array([1, 2, 3, 4]) },
  { name: 'empty array', value: [] },
  { name: 'array [1,2,3]', value: [1, 2, 3] },
  { name: 'empty map', value: new Map() },
  {
    name: 'map with integer keys, out of order on input',
    value: new Map<CborKey, CborValue>([
      [10, 'ten'],
      [1, 'one'],
      [3, 'three'],
    ]),
  },
  {
    name: 'map mixing integer and text keys',
    value: new Map<CborKey, CborValue>([
      ['a', 1],
      [1, 2],
    ]),
  },
];

write('cbor.json', {
  note:
    'Deterministic CBOR per RFC 8949 §4.2.1, as constrained by spec/canonical-cbor.md. ' +
    'An implementation must produce exactly `hex` for each `value`, and must decode `hex` ' +
    'back to it. Map cases are given deliberately out of order: canonical encoding sorts ' +
    'keys by their ENCODED bytes, so input order must not matter.',
  cases: cborCases.map((c) => ({
    name: c.name,
    value: describe(c.value),
    hex: toHex(encode(c.value)),
  })),
});

/* ------------------------------------------------------------ match keys */

const matchKeys = [
  '2027mose_qm1',
  '2027mose_qm42',
  '2027mose_qm120',
  '2027mose_ef1m1',
  '2027mose_qf3m2',
  '2027mose_sf1m2',
  '2027mose_sf13m1',
  '2027mose_f1m1',
  '2027mose_f1m3',
];

write('match-packing.json', {
  note:
    'packed = (level << 24) | (set << 12) | number, with levels qm=1 ef=2 qf=3 sf=4 f=5 and ' +
    'set=0 for qualification. Round-tripping every key back to its original string is a ' +
    'conformance requirement, not an implementation detail.',
  cases: matchKeys.map((key) => {
    const { eventKey, packed } = parseMatchKey(key);
    return { key, eventKey, packed, roundTrip: formatMatchKey(eventKey, packed) };
  }),
});

/* -------------------------------------------------------------- pseudonyms */

write('scout-pseudonym.json', {
  note:
    'sid_event = BLAKE3(len32be(scoutId) ‖ len32be(eventKey) ‖ len32be(meshKey))[0..8]. Each ' +
    'part is length-prefixed so that ("ab","c") and ("a","bc") cannot collide. The same human ' +
    'at two events MUST produce different values — that is the unlinkability property.',
  meshKeyHex: toHex(MESH_KEY),
  cases: [
    ['ada', '2027mose'],
    ['ada', '2027wamo'],
    ['bo', '2027mose'],
    ['ab', 'c027mose'],
    ['a', 'bc027mose'],
    ['', '2027mose'],
  ].map(([scout, eventKey]) => ({
    scout,
    eventKey,
    pseudonymHex: toHex(mintScoutPseudonym(scout!, eventKey!, MESH_KEY)),
  })),
});

/* ------------------------------------------------------------------ record */

const body = utf8('{"auto":3,"teleop":11,"climb":"deep"}');
const record = makeRecord({
  eventKey: EVENT,
  match: parseMatchKey(`${EVENT}_qm42`).packed,
  team: 8793,
  scout: mintScoutPseudonym('ada', EVENT, MESH_KEY),
  schema: 'demo.scout.v1',
  body,
  sealedAt: SEALED_AT,
});

const corrected = makeRecord({
  eventKey: EVENT,
  match: parseMatchKey(`${EVENT}_qm42`).packed,
  team: 8793,
  scout: mintScoutPseudonym('ada', EVENT, MESH_KEY),
  schema: 'demo.scout.v1',
  body: utf8('{"auto":3,"teleop":13,"climb":"deep"}'),
  sealedAt: SEALED_AT + 60_000,
  revision: 1,
  supersedes: recordId(record),
});

/** A second scout, identical body — the property dedup turns on. */
const twin = makeRecord({
  eventKey: EVENT,
  match: parseMatchKey(`${EVENT}_qm42`).packed,
  team: 8793,
  scout: mintScoutPseudonym('bo', EVENT, MESH_KEY),
  schema: 'demo.scout.v1',
  body,
  sealedAt: SEALED_AT,
});

write('record.json', {
  note:
    'record-id = BLAKE3-256(canonical-cbor(record)). Note `twin`: a different scout with a ' +
    'BYTE-IDENTICAL body. Its bodyHash matches the first record and its recordId does not. An ' +
    'implementation that deduplicates on body hash will drop one of them and silently destroy ' +
    'the double-scouting the analytics layer depends on.',
  meshKeyHex: toHex(MESH_KEY),
  cases: [
    { name: 'first observation', record: describeRecord(record) },
    { name: 'correction superseding it', record: describeRecord(corrected) },
    { name: 'twin: different scout, identical body', record: describeRecord(twin) },
  ],
});

/* ---------------------------------------------------------------- envelope */

write('envelope.json', {
  note:
    'COSE_Sign1 (RFC 9052 §4.2) tagged #6.18 over the canonical record. Ed25519 is ' +
    'deterministic, so with the fixed secret key below the signature is reproducible byte for ' +
    'byte. The signature covers the WHOLE record via the Sig_structure, not just the body — an ' +
    'implementation that signs only body bytes will produce a different value here and will ' +
    'leave event, match, team, scout and schema forgeable.',
  secretKeyHex: toHex(SECRET_KEY),
  publicKeyHex: toHex(DEVICE.publicKey),
  kidHex: toHex(DEVICE.kid),
  cases: [
    {
      name: 'first observation',
      recordIdHex: toHex(recordId(record)),
      envelopeHex: toHex(sealRecord(record, DEVICE)),
    },
    {
      name: 'correction',
      recordIdHex: toHex(recordId(corrected)),
      envelopeHex: toHex(sealRecord(corrected, DEVICE)),
    },
  ],
});

/* ------------------------------------------------------------ sync message */

const ids = [record, corrected, twin].map((r) => recordId(r)).sort((a, b) => toHex(a).localeCompare(toHex(b)));

write('sync-message.json', {
  note:
    'Sync messages use the same canonical codec as records. Field 1 digests, 2 id lists, ' +
    '3 want, 4 records, 5 more. Digest xor is the bytewise XOR of every record-id in range, ' +
    'which is order-independent; count disambiguates the degenerate cases XOR alone misses.',
  cases: [
    {
      name: 'root digest over three records',
      hex: toHex(encodeSyncMessage({ digests: [rangeDigest(ids, '')] })),
    },
    {
      name: 'empty digest (no records)',
      hex: toHex(encodeSyncMessage({ digests: [rangeDigest([], '')] })),
    },
    {
      name: 'want two truncated ids',
      hex: toHex(encodeSyncMessage({ want: [ids[0]!.slice(0, 8), ids[1]!.slice(0, 8)] })),
    },
    {
      name: 'bare turn-return',
      hex: toHex(encodeSyncMessage({ more: false })),
    },
  ],
});

/* -------------------------------------------------------------- BLE framing */

const frame = new Uint8Array(300);
for (let i = 0; i < frame.length; i++) frame[i] = (i * 7) & 0xff;

write('ble-framing.json', {
  note:
    'Packet header is frameId(2) ‖ seq(2) ‖ flags(1), big endian, flags bit 0 = final. ' +
    'Sequence is 16-bit deliberately: at the unnegotiated 23-byte MTU an 8-bit sequence caps a ' +
    'frame at 256 packets, which is fewer than a routine sync frame needs.',
  frameHex: toHex(frame),
  cases: [23, 64, 247].map((mtu) => ({
    mtu,
    frameId: 7,
    packetsHex: split(frame, mtu, 7).map(toHex),
  })),
});

/* ------------------------------------------------------------------ helpers */

function describe(v: CborValue): unknown {
  if (v instanceof Uint8Array) return { $bytes: toHex(v) };
  if (v instanceof Map) return { $map: [...v].map(([k, val]) => [k, describe(val)]) };
  if (Array.isArray(v)) return v.map(describe);
  return v;
}

function describeRecord(r: typeof record): unknown {
  return {
    version: r.version,
    eventKey: r.eventKey,
    match: r.match,
    team: r.team,
    scoutHex: toHex(r.scout),
    schema: r.schema,
    sealedAt: r.sealedAt,
    revision: r.revision,
    bodyHashHex: toHex(r.bodyHash),
    bodySize: r.bodySize,
    supersedesHex: r.supersedes ? toHex(r.supersedes) : null,
    bodyHex: toHex(r.body),
    canonicalHex: toHex(encodeRecord(r)),
    recordIdHex: toHex(recordId(r)),
  };
}

// Sanity: the generator must agree with the primitives it is pinning.
if (toHex(hash256(utf8('abc'))) !== toHex(hash256(utf8('abc')))) {
  throw new Error('hash is not deterministic');
}
void encode(new Map<CborKey, CborValue>());
console.log('\nvectors written. These are COMMITTED — a change here is a wire-format change.');
