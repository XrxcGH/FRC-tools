import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  loadProfileSet,
  detectProfile,
  ingestScan,
  ingestBatch,
  ScanSuppressor,
  ProfileError,
} from '../src/index.ts';
import {
  RecordStore,
  generateDeviceKey,
  generateMeshKey,
  mintScoutPseudonym,
  openEnvelope,
  parseMatchKey,
  unpackMatch,
  toHex,
  utf8,
  type KeyResolver,
} from '@courier/core';

const PROFILES = loadProfileSet(
  JSON.parse(
    readFileSync(fileURLToPath(new URL('../profiles/bridge_profiles.json', import.meta.url)), 'utf8'),
  ),
);

const device = generateDeviceKey('software');
const meshKey = generateMeshKey();
const resolver: KeyResolver = (kid) => (toHex(kid) === toHex(device.kid) ? device.publicKey : undefined);

const ctx = {
  profiles: PROFILES,
  eventKey: '2027mose',
  meshKey,
  device,
  now: () => 1_800_000_000_000,
};

const tsv = (...f: (string | number)[]): string => f.join('\t');

test('the shipped profile set is valid and flags its own scaffolding', () => {
  assert.ok(PROFILES.profiles.length >= 3);
  const unverified = PROFILES.profiles.filter((p) => !p.verified);
  assert.ok(unverified.length > 0, 'scaffolding profiles exist');
  for (const p of unverified) {
    assert.match(p.id, /UNVERIFIED/, `${p.id} should announce that it is unverified in its id`);
    assert.ok(p.notes && /confirm/i.test(p.notes), `${p.id} should say how to confirm it`);
  }
});

test('malformed profile sets are rejected with a specific reason', () => {
  assert.throws(() => loadProfileSet({}), /version/);
  assert.throws(() => loadProfileSet({ version: 1 }), /profiles array/);
  assert.throws(
    () =>
      loadProfileSet({
        version: 1,
        profiles: [{ id: 'x', name: 'x', format: 'delimited', fields: {}, matchFormat: 'number', schemaId: 's' }],
      }),
    ProfileError,
  );
  assert.throws(
    () =>
      loadProfileSet({
        version: 1,
        profiles: [
          {
            id: 'dup',
            name: 'a',
            format: 'delimited',
            delimiter: '\t',
            fields: { scout: 0, match: 1, team: 2 },
            matchFormat: 'number',
            schemaId: 's',
            verified: true,
          },
          {
            id: 'dup',
            name: 'b',
            format: 'delimited',
            delimiter: '\t',
            fields: { scout: 0, match: 1, team: 2 },
            matchFormat: 'number',
            schemaId: 's',
            verified: true,
          },
        ],
      }),
    /duplicate profile id/,
  );
});

test('a tab-separated payload seals into a verifiable envelope', () => {
  const scan = tsv('ada', 42, 8793, '3', '11', 'deep', 'no-defense');
  const r = ingestScan(scan, ctx);

  assert.equal(r.status, 'sealed', r.reason);
  assert.equal(r.profileId, 'courier.generic.tsv.v1');
  assert.equal(r.unverifiedProfile, false);

  const opened = openEnvelope(r.envelope!, resolver);
  assert.equal(opened.record.eventKey, '2027mose');
  assert.equal(opened.record.team, 8793);
  assert.deepEqual(unpackMatch(opened.record.match), { level: 'qm', set: 0, number: 42 });
});

test('the body is the ORIGINAL payload, byte for byte', () => {
  const scan = tsv('ada', 42, 8793, '3', '11', 'deep', 'weird|charsé', '');
  const r = ingestScan(scan, ctx);
  assert.equal(r.status, 'sealed');
  // Courier must not normalise, re-encode, or reorder anything it does not
  // understand — a team's own decoder has to read back exactly what it wrote.
  assert.equal(new TextDecoder().decode(r.record!.body), scan);
});

test("the scout's raw identifier never reaches the record", () => {
  const scan = tsv('ada-lovelace', 42, 8793, '3');
  const r = ingestScan(scan, ctx);
  assert.equal(r.status, 'sealed');

  const scoutField = toHex(r.record!.scout);
  assert.equal(scoutField, toHex(mintScoutPseudonym('ada-lovelace', '2027mose', meshKey)));
  assert.ok(!scoutField.includes(Buffer.from('ada').toString('hex')));
  assert.equal(r.record!.scout.length, 8);
});

test('a JSON payload routes via key paths and honours its own event key', () => {
  const scan = JSON.stringify({ scout: 'bo', match: 7, team: 9143, event: '2027mose', auto: 3 });
  const r = ingestScan(scan, ctx);
  assert.equal(r.status, 'sealed', r.reason);
  assert.equal(r.profileId, 'courier.generic.json.v1');
  assert.equal(r.record!.team, 9143);
});

test('a payload for a different event is refused, not silently re-homed', () => {
  const scan = JSON.stringify({ scout: 'bo', match: 7, team: 9143, event: '2027wamo' });
  const r = ingestScan(scan, ctx);
  assert.equal(r.status, 'wrong-event');
  assert.match(r.reason!, /2027wamo/);
});

test('full match keys carry elimination matches through', () => {
  const scan = tsv('ada', '2027mose_sf1m2', 8793, 'x');
  const r = ingestScan(scan, ctx);
  assert.equal(r.status, 'sealed', r.reason);
  assert.equal(r.profileId, 'courier.generic.matchkey.tsv.v1');
  assert.deepEqual(unpackMatch(r.record!.match), { level: 'sf', set: 1, number: 2 });
});

test('unrecognised payloads are refused rather than guessed at', () => {
  for (const junk of ['', 'hello world', '{"nope":1}', tsv('only', 'two')]) {
    const r = ingestScan(junk, ctx);
    assert.notEqual(r.status, 'sealed', `"${junk}" must not seal`);
  }
});

test('an ambiguous payload is refused rather than routed by coin flip', () => {
  // Two unverified profiles both fit a 6-column TSV with a numeric match.
  // Mis-routing to the wrong team is invisible; refusing is not.
  const ambiguous = loadProfileSet({
    version: 1,
    profiles: [
      {
        id: 'a.UNVERIFIED',
        name: 'a',
        format: 'delimited',
        delimiter: '\t',
        minFields: 3,
        fields: { scout: 0, match: 1, team: 2 },
        matchFormat: 'number',
        schemaId: 'a',
        verified: false,
      },
      {
        id: 'b.UNVERIFIED',
        name: 'b',
        format: 'delimited',
        delimiter: '\t',
        minFields: 3,
        fields: { scout: 0, match: 1, team: 2 },
        matchFormat: 'number',
        schemaId: 'b',
        verified: false,
      },
    ],
  });
  assert.equal(detectProfile(ambiguous, tsv('ada', 1, 8793)), null);
});

test('a verified profile wins over scaffolding when both fit', () => {
  const mixed = loadProfileSet({
    version: 1,
    profiles: [
      {
        id: 'good',
        name: 'good',
        format: 'delimited',
        delimiter: '\t',
        minFields: 3,
        fields: { scout: 0, match: 1, team: 2 },
        matchFormat: 'number',
        schemaId: 'good',
        verified: true,
      },
      {
        id: 'scaffold.UNVERIFIED',
        name: 'scaffold',
        format: 'delimited',
        delimiter: '\t',
        minFields: 3,
        fields: { scout: 0, match: 1, team: 2 },
        matchFormat: 'number',
        schemaId: 'scaffold',
        verified: false,
      },
    ],
  });
  assert.equal(detectProfile(mixed, tsv('ada', 1, 8793))!.profile.id, 'good');
});

/* ------------------------------------------------------- the two dedup layers */

test('duplicate SCANS are suppressed, but double-SCOUTING survives', () => {
  const sup = new ScanSuppressor();

  // Same physical QR scanned twice: suppress the second.
  const scan = tsv('ada', 42, 8793, '3', '11');
  assert.equal(ingestScan(scan, ctx, sup).status, 'sealed');
  assert.equal(ingestScan(scan, ctx, sup).status, 'duplicate-scan');

  // Two DIFFERENT scouts reporting byte-identical observations of the same
  // robot must both survive. This is the distinction the whole dedup design
  // rests on: scan suppression is a cleartext-body check at ingest; record
  // dedup is by record-id, which includes the scout pseudonym.
  const store = new RecordStore();
  const sup2 = new ScanSuppressor();
  const tail = tsv('', 42, 8793, '3', '11'); // identical observation columns
  const a = ingestScan('ada' + tail, ctx, sup2);
  const b = ingestScan('bo' + tail, ctx, sup2);
  assert.equal(a.status, 'sealed');
  assert.equal(b.status, 'sealed');
  assert.equal(store.admit(a.envelope!, resolver).status, 'admitted');
  assert.equal(store.admit(b.envelope!, resolver).status, 'admitted');
  assert.equal(store.size, 2, 'both scouts survive into the store');

  const { packed } = parseMatchKey('2027mose_qm42');
  assert.equal(store.currentForObservation('2027mose', packed, 8793).length, 2);
});

test('batch ingest summarises outcomes and surfaces unverified profile use', () => {
  const scans = [
    tsv('ada', 1, 8793, 'x'),
    tsv('bo', 2, 9143, 'x'),
    tsv('ada', 1, 8793, 'x'), // duplicate scan
    'garbage',
    tsv('cy', 9999, 254, 'x'), // detects fine, but 9999 exceeds the packed match field
    '',
  ];
  const s = ingestBatch(scans, ctx);

  assert.equal(s.sealed, 2);
  assert.equal(s.duplicateScan, 1);
  assert.equal(s.unmatched, 1, 'only the garbage line fails profile detection');
  assert.equal(s.invalid, 1, 'the out-of-range match detects, then fails packing');
  assert.match(s.reasons.join(' '), /9999/, 'the reason names the offending value');
  assert.equal(s.envelopes.length, 2);
  assert.equal(s.unverifiedProfilesUsed.size, 0);

  const store = new RecordStore();
  for (const e of s.envelopes) {
    assert.equal(store.admit(e, resolver).status, 'admitted');
  }
  assert.equal(store.size, 2);
});

test('a Bridge-sealed record survives a full sync to a peer that never saw the QR', () => {
  const s = ingestBatch(
    Array.from({ length: 25 }, (_, i) => tsv(`scout-${i % 4}`, (i % 12) + 1, 8793 + (i % 3), i)),
    ctx,
  );
  assert.equal(s.sealed, 25);

  const bridgeStore = new RecordStore();
  for (const e of s.envelopes) bridgeStore.admit(e, resolver);

  const picklistLaptop = new RecordStore();
  // Reuse the core reconcile driver across the two stores.
  return import('@courier/core').then(({ reconcile, storesConverged }) => {
    const res = reconcile(bridgeStore, picklistLaptop, resolver);
    assert.ok(res.converged);
    assert.ok(storesConverged(bridgeStore, picklistLaptop));
    assert.equal(picklistLaptop.size, 25);
  });
});
