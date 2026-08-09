import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  loadProfileSet,
  detectProfile,
  matchingProfiles,
  assertUnambiguous,
  readField,
  ingestScan,
  ingestBatch,
  ScanSuppressor,
  ProfileError,
} from '../src/index.ts';
import {
  RecordStore,
  reconcile,
  storesConverged,
  generateDeviceKey,
  generateMeshKey,
  mintScoutPseudonym,
  openEnvelope,
  parseMatchKey,
  unpackMatch,
  toHex,
  type KeyResolver,
} from '@courier/core';

const load = (name: string) =>
  loadProfileSet(
    JSON.parse(readFileSync(fileURLToPath(new URL(`../profiles/${name}`, import.meta.url)), 'utf8')),
  );

const PROFILES = load('bridge_profiles.json');
const EXAMPLES = load('UNVERIFIED-examples.json');

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

/* ------------------------------------------------------- the shipped set --- */

test('the shipped profile set is mutually exclusive over a realistic corpus', () => {
  // Detection refuses ambiguity rather than resolving it, so a shipped set that
  // is not mutually exclusive would simply refuse ordinary payloads.
  assertUnambiguous(PROFILES, [
    tsv('ada', 1, 8793, 'x'),
    tsv('ada', 42, 8793, 3, 11, 'deep', 'none', 'note'),
    tsv('ada', '2027mose_sf1m2', 8793, 'x'),
    tsv('ada', '2027mose_qm7', 8793, 'x'),
    JSON.stringify({ scout: 'bo', match: 7, team: 9143, event: '2027mose' }),
    JSON.stringify({ scout: 'bo', match: 7, team: 9143 }),
  ]);
});

test('the shipped set contains only verified profiles', () => {
  for (const p of PROFILES.profiles) {
    assert.equal(p.verified, true, `${p.id} must be verified to ship active`);
  }
});

test('the unverified examples are shipped separately and say why', () => {
  for (const p of EXAMPLES.profiles) {
    assert.equal(p.verified, false);
    assert.match(p.id, /EXAMPLE/);
    assert.ok(p.notes && /confirm/i.test(p.notes));
    assert.ok(p.exactFields, `${p.id} needs an exactFields discriminator to be usable`);
  }
});

test('loading the examples alongside the shipped set creates the ambiguity they warn about', () => {
  // This is exactly why they are not shipped active: a 6-column TSV fits both a
  // generic profile and the QRScout example.
  const merged = { version: 2, profiles: [...PROFILES.profiles, ...EXAMPLES.profiles] };
  assert.throws(
    () => assertUnambiguous(merged, [tsv('ada', 12, 42, 8793, 'deep', 'note')]),
    /mutually exclusive/,
  );
});

/* --------------------------------------------------------- profile rules --- */

test('malformed profile sets are rejected with a specific reason', () => {
  assert.throws(() => loadProfileSet({}), /version/);
  assert.throws(() => loadProfileSet({ version: 1 }), /profiles array/);

  const base = {
    id: 'x',
    name: 'x',
    format: 'delimited',
    delimiter: '\t',
    fields: { scout: 0, match: 1, team: 2 },
    matchFormat: 'number',
    schemaId: 's',
    verified: true,
    scoutIdInBody: true,
  };
  const bad = (patch: Record<string, unknown>, re: RegExp) =>
    assert.throws(() => loadProfileSet({ version: 1, profiles: [{ ...base, ...patch }] }), re);

  bad({ fields: {} }, /missing field mapping/);
  bad({ verified: 'false' }, /"verified" must be a boolean/);
  bad({ scoutIdInBody: undefined }, /scoutIdInBody/);
  bad({ delimiter: ',' }, /not permitted/);
  bad({ minFields: 0 }, /positive integer/);
  bad({ fields: { scout: -1, match: 1, team: 2 } }, /non-negative integer/);
  bad({ format: 'json', fields: { scout: 0, match: 1, team: 2 } }, /key path/);
});

test('a comma delimiter is refused, because there is no quoting', () => {
  // "Doe, Jane",42,8793 would shift every column. Refusing the delimiter is the
  // only safe answer short of writing a second structural parser.
  assert.throws(
    () =>
      loadProfileSet({
        version: 1,
        profiles: [
          {
            id: 'csv',
            name: 'csv',
            format: 'delimited',
            delimiter: ',',
            fields: { scout: 0, match: 1, team: 2 },
            matchFormat: 'number',
            schemaId: 'csv',
            verified: true,
            scoutIdInBody: true,
          },
        ],
      }),
    ProfileError,
  );
});

test('readField addresses dotted keys via exact segments', () => {
  const payload = { meta: { 'team.number': '8793' }, plain: { team: '254' } };
  assert.equal(readField(payload, ['meta', 'team.number']), '8793');
  assert.equal(readField(payload, 'plain.team'), '254');
  // The dotted shorthand cannot reach a key containing a dot — hence the array.
  assert.equal(readField(payload, 'meta.team.number'), undefined);
});

/* ------------------------------------------------------------- detection --- */

test('a tab-separated payload seals into a verifiable envelope', () => {
  const r = ingestScan(tsv('ada', 42, 8793, '3', '11', 'deep', 'no-defense'), ctx);
  assert.equal(r.status, 'sealed', r.reason);
  assert.equal(r.profileId, 'courier.generic.tsv.v1');

  const opened = openEnvelope(r.envelope!, resolver);
  assert.equal(opened.record.eventKey, '2027mose');
  assert.equal(opened.record.team, 8793);
  assert.deepEqual(unpackMatch(opened.record.match), { level: 'qm', set: 0, number: 42 });
});

test('ambiguity is refused, never resolved by preferring a verified profile', () => {
  // "Verified" means a profile's indices are right for payloads FROM THAT APP.
  // It says nothing about whether THIS payload came from it, so preferring it
  // routes app-specific data through generic indices — silent mis-routing.
  const ambiguous = loadProfileSet({
    version: 2,
    profiles: [
      {
        id: 'generic',
        name: 'generic',
        format: 'delimited',
        delimiter: '\t',
        minFields: 3,
        fields: { scout: 0, match: 1, team: 2 },
        matchFormat: 'number',
        schemaId: 'generic',
        verified: true,
        scoutIdInBody: true,
      },
      {
        id: 'specific.EXAMPLE',
        name: 'specific',
        format: 'delimited',
        delimiter: '\t',
        minFields: 3,
        fields: { scout: 0, match: 2, team: 3 },
        matchFormat: 'number',
        schemaId: 'specific',
        verified: false,
        scoutIdInBody: true,
      },
    ],
  });

  const payload = tsv('ada', 12, 42, 8793, 'deep');
  assert.equal(matchingProfiles(ambiguous, payload).length, 2);
  assert.equal(detectProfile(ambiguous, payload), null, 'must refuse');

  const r = ingestScan(payload, { ...ctx, profiles: ambiguous });
  assert.equal(r.status, 'ambiguous');
  assert.match(r.reason!, /Refused rather than routed by guess/);
});

test('an empty leading column does not shift every field left', () => {
  // Tab is whitespace, so trimming the payload eats an empty first column — and
  // a scout leaving the name blank is routine. The honest outcome is refusal.
  const r = ingestScan(tsv('', 42, 879, 5, 'note'), ctx);
  assert.notEqual(r.status, 'sealed', 'must not seal with shifted columns');
});

test('leading and trailing line endings and a BOM survive detection', () => {
  const r = ingestScan('﻿' + tsv('ada', 42, 8793, 'x') + '\r\n', ctx);
  assert.equal(r.status, 'sealed', r.reason);
  assert.equal(r.record!.team, 8793);
});

/* ---------------------------------------------------------- event safety --- */

test('a JSON payload declaring another event is refused', () => {
  const r = ingestScan(JSON.stringify({ scout: 'bo', match: 7, team: 9143, event: '2027wamo' }), ctx);
  assert.equal(r.status, 'wrong-event');
  assert.match(r.reason!, /2027wamo/);
});

test('a malformed event key is refused, not silently re-homed', () => {
  for (const event of ['wk1', 'x']) {
    const r = ingestScan(JSON.stringify({ scout: 'bo', match: 7, team: 9143, event }), ctx);
    assert.equal(r.status, 'invalid', `event "${event}" must not seal`);
    assert.match(r.reason!, /too short/);
  }
});

test('an absent event key falls back to the configured event', () => {
  const r = ingestScan(JSON.stringify({ scout: 'bo', match: 7, team: 9143 }), ctx);
  assert.equal(r.status, 'sealed', r.reason);
  assert.equal(r.record!.eventKey, '2027mose');
});

test("a match key's own event is checked against the Bridge's", () => {
  // Dropping the event key embedded in a full match key lets last week's
  // practice event seal into this week's dataset with no signal at all.
  const foreign = ingestScan(tsv('ada', '2027wamo_sf1m2', 8793, 'x'), ctx);
  assert.equal(foreign.status, 'wrong-event', foreign.reason);
  assert.match(foreign.reason!, /2027wamo/);

  const ours = ingestScan(tsv('ada', '2027mose_sf1m2', 8793, 'x'), ctx);
  assert.equal(ours.status, 'sealed', ours.reason);
  assert.deepEqual(unpackMatch(ours.record!.match), { level: 'sf', set: 1, number: 2 });
});

/* ---------------------------------------------------------------- bodies --- */

test('the body is the ORIGINAL payload, byte for byte', () => {
  const scan = tsv('ada', 42, 8793, '3', '11', 'deep', 'weird|charsé', '');
  const r = ingestScan(scan, ctx);
  assert.equal(r.status, 'sealed');
  assert.equal(new TextDecoder().decode(r.record!.body), scan);
});

test('the raw scout identifier IS inside the body, and the result says so', () => {
  // Verbatim bodies and PII minimisation are in direct tension, and on the
  // Bridge path minimisation loses. The `scout` FIELD is a pseudonym, but the
  // cleartext name sits in the same signed record. Asserting the true state of
  // affairs here so no future change can quietly reintroduce the false claim.
  const r = ingestScan(tsv('ada-lovelace', 42, 8793, 'x'), ctx);
  assert.equal(r.status, 'sealed');
  assert.equal(r.scoutIdInBody, true, 'the result must declare this');

  const bodyText = new TextDecoder().decode(r.record!.body);
  assert.ok(bodyText.includes('ada-lovelace'), 'the raw identifier is recoverable from the body');

  // The pseudonym field is still a pseudonym, and still unlinkable across events.
  assert.equal(toHex(r.record!.scout), toHex(mintScoutPseudonym('ada-lovelace', '2027mose', meshKey)));
  assert.notEqual(
    toHex(r.record!.scout),
    toHex(mintScoutPseudonym('ada-lovelace', '2027wamo', meshKey)),
  );
});

/* ------------------------------------------------- the two dedup layers --- */

test('duplicate SCANS are suppressed, but double-SCOUTING survives', () => {
  const sup = new ScanSuppressor();
  const scan = tsv('ada', 42, 8793, '3', '11');
  assert.equal(ingestScan(scan, ctx, sup).status, 'sealed');
  assert.equal(ingestScan(scan, ctx, sup).status, 'duplicate-scan');

  const store = new RecordStore();
  const sup2 = new ScanSuppressor();
  const tail = tsv('', 42, 8793, '3', '11');
  const a = ingestScan('ada' + tail, ctx, sup2);
  const b = ingestScan('bo' + tail, ctx, sup2);
  assert.equal(store.admit(a.envelope!, resolver).status, 'admitted');
  assert.equal(store.admit(b.envelope!, resolver).status, 'admitted');
  assert.equal(store.size, 2);

  const { packed } = parseMatchKey('2027mose_qm42');
  assert.equal(store.currentForObservation('2027mose', packed, 8793).length, 2);
});

test('suppression is per-device only, and the summary sums to the input', () => {
  const scans = [
    tsv('ada', 1, 8793, 'x'),
    tsv('bo', 2, 9143, 'x'),
    tsv('ada', 1, 8793, 'x'), // duplicate scan
    'garbage',
    tsv('cy', 9999, 254, 'x'), // detects, then fails packing
    '',
    '   ',
  ];
  const s = ingestBatch(scans, ctx);

  assert.equal(s.sealed, 2);
  assert.equal(s.duplicateScan, 1);
  assert.equal(s.unmatched, 1);
  assert.equal(s.invalid, 1);
  assert.equal(s.blank, 2);
  assert.equal(
    s.sealed + s.duplicateScan + s.unmatched + s.ambiguous + s.invalid + s.wrongEvent + s.blank,
    scans.length,
    'every input must be accounted for',
  );
  assert.equal(s.scoutIdInBody, true);

  // A second Bridge has its own suppressor and does not know about the first.
  const other = ingestBatch([tsv('ada', 1, 8793, 'x')], ctx);
  assert.equal(other.sealed, 1, 'suppression does not span devices');
});

test('a Bridge-sealed record survives a full sync to a peer that never saw the QR', () => {
  const s = ingestBatch(
    Array.from({ length: 25 }, (_, i) => tsv(`scout-${i % 4}`, (i % 12) + 1, 8793 + (i % 3), i)),
    ctx,
  );
  assert.equal(s.sealed, 25);

  const bridgeStore = new RecordStore();
  for (const e of s.envelopes) bridgeStore.admit(e, resolver);

  const laptop = new RecordStore();
  const res = reconcile(bridgeStore, laptop, resolver);
  assert.equal(res.converged, true);
  assert.ok(storesConverged(bridgeStore, laptop));
  assert.equal(laptop.size, 25);
});
