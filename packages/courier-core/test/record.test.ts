import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  makeRecord,
  supersede,
  encodeRecord,
  decodeRecord,
  recordId,
  recordIdHex,
  compareRecords,
  sealRecord,
  openEnvelope,
  peekKeyId,
  envelopeSize,
  parseMatchKey,
  formatMatchKey,
  packMatch,
  unpackMatch,
  matchLabel,
  generateDeviceKey,
  mintScoutPseudonym,
  generateMeshKey,
  toHex,
  utf8,
  RecordError,
  EnvelopeError,
  MatchKeyError,
} from '../src/index.ts';
import { TestMesh } from './helpers.ts';

const BODY = utf8('{"auto":3,"teleop":11,"climb":"deep"}');

test('match keys round-trip through packing for every FRC format', () => {
  const keys = [
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
  for (const k of keys) {
    const { eventKey, packed } = parseMatchKey(k);
    assert.equal(formatMatchKey(eventKey, packed), k, `round-trip ${k}`);
  }
});

test('match packing rejects malformed and out-of-range input', () => {
  assert.throws(() => parseMatchKey('2027mose'), MatchKeyError);
  assert.throws(() => parseMatchKey('2027mose_zz1'), MatchKeyError);
  assert.throws(() => parseMatchKey('2027mose_qm0'), MatchKeyError);
  // qualification matches have no set
  assert.throws(() => packMatch({ level: 'qm', set: 2, number: 1 }), MatchKeyError);
  // elimination matches are in a 1-based set
  assert.throws(() => packMatch({ level: 'sf', set: 0, number: 1 }), MatchKeyError);
  assert.throws(() => packMatch({ level: 'qm', set: 0, number: 4096 }), MatchKeyError);
});

test('match labels are short enough for a stands UI', () => {
  assert.equal(matchLabel(packMatch({ level: 'qm', set: 0, number: 42 })), 'Q42');
  assert.equal(matchLabel(packMatch({ level: 'sf', set: 1, number: 2 })), 'SF1-2');
  assert.equal(matchLabel(packMatch({ level: 'f', set: 1, number: 3 })), 'F3');
  assert.deepEqual(unpackMatch(packMatch({ level: 'qf', set: 3, number: 2 })), {
    level: 'qf',
    set: 3,
    number: 2,
  });
});

test('records round-trip through the canonical encoding', () => {
  const mesh = new TestMesh();
  const { packed } = parseMatchKey('2027mose_qm42');
  const r = makeRecord({
    eventKey: '2027mose',
    match: packed,
    team: 8793,
    scout: mesh.scout('ada', '2027mose'),
    schema: 'demo.scout.v1',
    body: BODY,
    sealedAt: 1_800_000_000_000,
  });
  const decoded = decodeRecord(encodeRecord(r));
  assert.deepEqual(decoded, r);
  assert.equal(recordIdHex(decoded), recordIdHex(r));
});

test('encoding is byte-stable across independent constructions', () => {
  const mesh = new TestMesh();
  const mk = () =>
    makeRecord({
      eventKey: '2027mose',
      match: parseMatchKey('2027mose_qm42').packed,
      team: 8793,
      scout: mesh.scout('ada', '2027mose'),
      schema: 'demo.scout.v1',
      body: BODY.slice(),
      sealedAt: 1_800_000_000_000,
    });
  assert.equal(toHex(encodeRecord(mk())), toHex(encodeRecord(mk())));
});

/* ------------------------------------------------------------------ D-2 ---- */

test('two scouts with byte-identical bodies produce DIFFERENT record ids', () => {
  // This is the property the whole dedup design turns on. Deduplicating on body
  // hash would drop one of these and silently destroy the deliberate
  // double-scouting that scout-reliability estimation depends on.
  const mesh = new TestMesh();
  const common = {
    eventKey: '2027mose',
    match: parseMatchKey('2027mose_qm42').packed,
    team: 8793,
    schema: 'demo.scout.v1',
    body: BODY,
    sealedAt: 1_800_000_000_000,
  };
  const ada = makeRecord({ ...common, scout: mesh.scout('ada', '2027mose') });
  const bo = makeRecord({ ...common, scout: mesh.scout('bo', '2027mose') });

  assert.equal(toHex(ada.bodyHash), toHex(bo.bodyHash), 'bodies are byte-identical');
  assert.notEqual(recordIdHex(ada), recordIdHex(bo), 'but record ids must differ');
});

test('the same scout at two events is unlinkable', () => {
  const mesh = new TestMesh();
  assert.notEqual(
    toHex(mesh.scout('ada', '2027mose')),
    toHex(mesh.scout('ada', '2027wamo')),
    'per-event pseudonyms must not correlate across events',
  );
});

test('scout pseudonyms differ across meshes for the same person', () => {
  const eventKey = '2027mose';
  const a = mintScoutPseudonym('ada', eventKey, generateMeshKey());
  const b = mintScoutPseudonym('ada', eventKey, generateMeshKey());
  assert.notEqual(toHex(a), toHex(b));
});

test('pseudonym inputs are length-prefixed so parts cannot be confused', () => {
  const mesh = generateMeshKey();
  assert.notEqual(
    toHex(mintScoutPseudonym('ab', 'c027', mesh)),
    toHex(mintScoutPseudonym('a', 'bc027', mesh)),
  );
});

/* ------------------------------------------------------- validation -------- */

test('records with integrity fields that disagree with the body are rejected', () => {
  const mesh = new TestMesh();
  const r = makeRecord({
    eventKey: '2027mose',
    match: parseMatchKey('2027mose_qm1').packed,
    team: 8793,
    scout: mesh.scout('ada', '2027mose'),
    schema: 'demo.scout.v1',
    body: BODY,
  });
  assert.throws(() => decodeRecord(encodeRecord({ ...r, bodySize: r.bodySize + 1 })), RecordError);
  const wrongHash = new Uint8Array(r.bodyHash);
  wrongHash[0]! ^= 0xff;
  assert.throws(() => encodeRecord({ ...r, bodyHash: wrongHash }), /body hash/);
});

test('out-of-range field values are rejected', () => {
  const mesh = new TestMesh();
  const base = {
    eventKey: '2027mose',
    match: parseMatchKey('2027mose_qm1').packed,
    team: 8793,
    scout: mesh.scout('ada', '2027mose'),
    schema: 'demo.scout.v1',
    body: BODY,
  };
  assert.throws(() => makeRecord({ ...base, eventKey: 'abc' }), /event key/);
  assert.throws(() => makeRecord({ ...base, team: 0 }), /team/);
  assert.throws(() => makeRecord({ ...base, team: 100000 }), /team/);
  assert.throws(() => makeRecord({ ...base, schema: '' }), /schema/);
  assert.throws(() => makeRecord({ ...base, schema: 'x'.repeat(65) }), /schema/);
  assert.throws(() => makeRecord({ ...base, body: new Uint8Array(65537) }), /body/);
  assert.throws(() => makeRecord({ ...base, revision: 70000 }), /revision/);
});

test('reserved v2 fields are rejected in a v1 record', () => {
  // Hand-build a record map carrying field 13 (hlc), which v1 must refuse
  // rather than silently ignore.
  const mesh = new TestMesh();
  const r = makeRecord({
    eventKey: '2027mose',
    match: parseMatchKey('2027mose_qm1').packed,
    team: 8793,
    scout: mesh.scout('ada', '2027mose'),
    schema: 'demo.scout.v1',
    body: BODY,
  });
  const bytes = encodeRecord(r);
  // Splice: bump the map header from 12 to 13 entries and append field 13.
  assert.equal(bytes[0], 0xac); // map(12)
  const extra = new Uint8Array([0x0d, 0x00]); // key 13 => 0
  const tampered = new Uint8Array(bytes.length + extra.length);
  tampered.set(bytes);
  tampered.set(extra, bytes.length);
  tampered[0] = 0xad; // map(13)
  assert.throws(() => decodeRecord(tampered), /reserved/);
});

/* ------------------------------------------------------- supersession ------ */

test('corrections append rather than overwrite, and order deterministically', () => {
  const mesh = new TestMesh();
  const first = makeRecord({
    eventKey: '2027mose',
    match: parseMatchKey('2027mose_qm42').packed,
    team: 8793,
    scout: mesh.scout('ada', '2027mose'),
    schema: 'demo.scout.v1',
    body: utf8('{"teleop":11}'),
    sealedAt: 1_800_000_000_000,
  });
  const second = supersede(first, utf8('{"teleop":13}'), 1_800_000_060_000);

  assert.equal(second.revision, 1);
  assert.equal(toHex(second.supersedes!), recordIdHex(first));
  assert.notEqual(recordIdHex(first), recordIdHex(second));
  assert.ok(compareRecords(second, first) > 0, 'higher revision sorts later');
});

test('a supersedes pointer without a revision bump is refused', () => {
  const mesh = new TestMesh();
  const id = new Uint8Array(32).fill(7);
  assert.throws(
    () =>
      makeRecord({
        eventKey: '2027mose',
        match: parseMatchKey('2027mose_qm1').packed,
        team: 8793,
        scout: mesh.scout('ada', '2027mose'),
        schema: 'demo.scout.v1',
        body: BODY,
        supersedes: id,
        revision: 0,
      }),
    /revision/,
  );
});

test('concurrent corrections at the same revision break ties deterministically', () => {
  const mesh = new TestMesh();
  const base = {
    eventKey: '2027mose',
    match: parseMatchKey('2027mose_qm42').packed,
    team: 8793,
    scout: mesh.scout('ada', '2027mose'),
    schema: 'demo.scout.v1',
    revision: 0,
    sealedAt: 1_800_000_000_000,
  };
  const a = makeRecord({ ...base, body: utf8('a') });
  const b = makeRecord({ ...base, body: utf8('b') });
  const ab = compareRecords(a, b);
  const ba = compareRecords(b, a);
  assert.notEqual(ab, 0, 'distinct records must not compare equal');
  assert.equal(Math.sign(ab), -Math.sign(ba), 'ordering is antisymmetric');
  // and stable across repeated evaluation
  assert.equal(Math.sign(compareRecords(a, b)), Math.sign(ab));
});

/* ------------------------------------------------------- envelope ---------- */

test('envelopes seal and open, and the signature covers the whole record', () => {
  const mesh = new TestMesh();
  const { envelope, record } = mesh.seal({
    device: 'tablet-1',
    scout: 'ada',
    matchKey: '2027mose_qm42',
    team: 8793,
    body: BODY,
  });
  const opened = openEnvelope(envelope, mesh.resolver);
  assert.deepEqual(opened.record, record);
  assert.equal(toHex(opened.recordId), recordIdHex(record));
  assert.equal(toHex(opened.kid), toHex(mesh.device('tablet-1').kid));
});

test('tampering with ANY signed field is detected — not just the body', () => {
  const mesh = new TestMesh();
  const { envelope } = mesh.seal({
    device: 'tablet-1',
    scout: 'ada',
    matchKey: '2027mose_qm42',
    team: 8793,
    body: BODY,
  });

  // Flipping any single byte of the envelope must break verification. This is
  // the property the draft's "sign the body bytes" sample did NOT have: it
  // would have left event key, match, team, scout and schema forgeable.
  let detected = 0;
  for (let i = 0; i < envelope.length; i++) {
    const t = envelope.slice();
    t[i]! ^= 0x01;
    try {
      openEnvelope(t, mesh.resolver);
    } catch (err) {
      assert.ok(err instanceof EnvelopeError || err instanceof RecordError, `byte ${i}: ${err}`);
      detected++;
    }
  }
  assert.equal(detected, envelope.length, 'every single-byte mutation must be rejected');
});

test('an envelope from an unknown key is rejected but its kid is still readable', () => {
  const mesh = new TestMesh();
  const stranger = generateDeviceKey();
  const { record } = mesh.seal({
    device: 'tablet-1',
    scout: 'ada',
    matchKey: '2027mose_qm42',
    team: 8793,
    body: BODY,
  });
  const forged = sealRecord(record, stranger);

  assert.throws(() => openEnvelope(forged, mesh.resolver), /unknown key id/);
  // Quarantine UI needs the kid without trusting the envelope.
  assert.equal(toHex(peekKeyId(forged)!), toHex(stranger.kid));
});

test('a resolver returning a mismatched key is caught as a registry bug', () => {
  const mesh = new TestMesh();
  const other = generateDeviceKey();
  const { envelope } = mesh.seal({
    device: 'tablet-1',
    scout: 'ada',
    matchKey: '2027mose_qm42',
    team: 8793,
    body: BODY,
  });
  assert.throws(() => openEnvelope(envelope, () => other.publicKey), /whose id is not/);
});

test('envelope size stays inside the budget the spec claims', () => {
  const mesh = new TestMesh();
  const { record, envelope } = mesh.seal({
    device: 'tablet-1',
    scout: 'ada',
    matchKey: '2027mose_qm42',
    team: 8793,
    body: BODY,
  });
  assert.equal(envelopeSize(record), envelope.length, 'estimator must match reality');
  // spec/canonical-cbor.md §5 predicts ~224-304 bytes for a 40-120 byte body.
  assert.ok(
    envelope.length >= 200 && envelope.length <= 320,
    `envelope was ${envelope.length} bytes, outside the documented 200-320 range`,
  );
});
