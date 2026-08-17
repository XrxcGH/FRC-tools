import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  decodeBody,
  validateSchema,
  loadSchema,
  DecoderRegistry,
  describeGaps,
  toScoutObservations,
  toAllianceObservations,
  BridgeSchemas,
  SchemaError,
  type BodySchema,
  type DecodedRecord,
} from '../src/index.ts';
import { blendWithOfficial, fitContributions } from '@courier/analytics';

const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);

const TSV: BodySchema = {
  schemaId: 'team8793.v1',
  format: 'delimited',
  delimiter: '\t',
  fields: [
    { name: 'auto', type: 'integer', source: 3, min: 0, max: 50 },
    { name: 'teleop', type: 'integer', source: 4, min: 0, max: 200 },
    { name: 'climbed', type: 'boolean', source: 5, trueValues: ['deep', 'shallow'] },
    { name: 'level', type: 'enum', source: 6, values: ['none', 'park', 'deep'] },
  ],
};

/* ---------------------------------------------------------------- schema --- */

test('a schema is checked before it can mis-decode anything', () => {
  assert.doesNotThrow(() => validateSchema(TSV));
  const bad = (patch: Partial<BodySchema>, re: RegExp): void =>
    assert.throws(() => validateSchema({ ...TSV, ...patch } as BodySchema), re);

  bad({ schemaId: '' }, /needs a schemaId/);
  bad({ fields: [] }, /no fields declared/);
  bad({ delimiter: ',' }, /not permitted/);
  bad({ fields: [{ name: 'a', type: 'integer', source: 'x' }] }, /needs a column index/);
  bad({ fields: [{ name: 'a', type: 'enum', source: 0 }] }, /must list its values/);
  bad(
    { fields: [{ name: 'a', type: 'integer', source: 0 }, { name: 'a', type: 'integer', source: 1 }] },
    /duplicate field/,
  );
  bad({ fields: [{ name: 'a', type: 'integer', source: 0, min: 5, max: 1 }] }, /min above max/);
  assert.throws(() => loadSchema({ schemaId: 'x' }), SchemaError);
});

/* -------------------------------------------------------------- decoding --- */

test('a well-formed body decodes to typed values', () => {
  const r = decodeBody(TSV, utf8('ada\t42\t8793\t3\t11\tdeep\tpark'));
  assert.equal(r.decoded, true);
  if (!r.decoded) return;
  assert.deepEqual(r.values, { auto: 3, teleop: 11, climbed: true, level: 'park' });
  assert.deepEqual(r.missing, []);
});

test('an unrecognised boolean is a failure, never a silent false', () => {
  // Treating "Deep" as false turns a climb into a no-climb, and nobody finds
  // out until the picklist is already wrong.
  const r = decodeBody(TSV, utf8('ada\t42\t8793\t3\t11\tmaybe\tpark'));
  assert.equal(r.decoded, false);
  if (r.decoded) return;
  assert.match(r.reason, /"climbed" could not be read as boolean/);

  // The declared true-values do work.
  const ok = decodeBody(TSV, utf8('ada\t42\t8793\t3\t11\tshallow\tpark'));
  assert.equal(ok.decoded, true);
});

test('a value outside the declared range is refused, not stored', () => {
  const r = decodeBody(TSV, utf8('ada\t42\t8793\t999\t11\tdeep\tpark'));
  assert.equal(r.decoded, false);
  if (r.decoded) return;
  assert.match(r.reason, /"auto" is 999, above the declared maximum 50/);
});

test('an enum value the team never declared is refused', () => {
  const r = decodeBody(TSV, utf8('ada\t42\t8793\t3\t11\tdeep\torbit'));
  assert.equal(r.decoded, false);
});

test('an absent trailing field is missing, not zero', () => {
  // Zero is a real score. Reporting a short row as zeros would quietly drag a
  // team's estimate down.
  const r = decodeBody(TSV, utf8('ada\t42\t8793\t3'));
  assert.equal(r.decoded, true);
  if (!r.decoded) return;
  assert.deepEqual(r.values, { auto: 3 });
  assert.deepEqual(r.missing.sort(), ['climbed', 'level', 'teleop']);
});

test('an empty leading column does not shift every field', () => {
  // Tab is whitespace; trimming the body would eat the empty scout column and
  // read every value one place to the left. Same bug the Bridge had.
  const r = decodeBody(TSV, utf8('\t42\t8793\t3\t11\tdeep\tpark'));
  assert.equal(r.decoded, true);
  if (!r.decoded) return;
  assert.equal(r.values.auto, 3, 'auto still comes from column 3');
});

test('a JSON body decodes by key path, including nested keys', () => {
  const schema: BodySchema = {
    schemaId: 'json.v1',
    format: 'json',
    fields: [
      { name: 'auto', type: 'integer', source: 'scores.auto' },
      { name: 'note', type: 'string', source: 'note' },
    ],
  };
  const r = decodeBody(schema, utf8(JSON.stringify({ scores: { auto: 5 }, note: 'fast' })));
  assert.equal(r.decoded, true);
  if (!r.decoded) return;
  assert.deepEqual(r.values, { auto: 5, note: 'fast' });
});

test('malformed bodies fail with a reason rather than throwing', () => {
  const json: BodySchema = {
    schemaId: 'j',
    format: 'json',
    fields: [{ name: 'a', type: 'integer', source: 'a' }],
  };
  assert.equal(decodeBody(json, utf8('not json')).decoded, false);
  assert.equal(decodeBody(json, utf8('[1,2]')).decoded, false);
  assert.equal(decodeBody(TSV, new Uint8Array([0xff, 0xfe])).decoded, false);
});

/* -------------------------------------------------------------- registry --- */

function stored(schema: string, body: string, team: number, match = 1) {
  return {
    record: {
      schema,
      body: utf8(body),
      team,
      match,
      eventKey: '2027mose',
      scout: new Uint8Array([1, 2, 3, 4, 5, 6, 7, team & 0xff]),
    },
  };
}

test('an unregistered schema is not decoded, and is counted rather than dropped', () => {
  // The D-4 degradation: transport keeps working, nothing is invented, and the
  // caller is told exactly how much it could not read.
  const reg = DecoderRegistry.from([TSV]);
  const report = reg.decodeAll([
    stored('team8793.v1', 'ada\t1\t100\t3\t11\tdeep\tpark', 100),
    stored('someone-elses-app', 'whatever', 101),
    stored('someone-elses-app', 'whatever', 102),
  ]);

  assert.equal(report.records.length, 1);
  assert.equal(report.unknownSchema, 2);
  assert.deepEqual(report.missingSchemas, ['someone-elses-app']);

  const text = describeGaps(report, 3);
  assert.match(text, /2 of 3 records use a schema this device cannot read/);
  assert.match(text, /will sync onward untouched/);
  assert.match(text, /Register a decoder/);
});

test('a known schema that will not decode is counted separately from an unknown one', () => {
  const reg = DecoderRegistry.from([TSV]);
  const report = reg.decodeAll([
    stored('team8793.v1', 'ada\t1\t100\t3\t11\tdeep\tpark', 100),
    stored('team8793.v1', 'ada\t1\t101\t999\t11\tdeep\tpark', 101),
  ]);
  assert.equal(report.records.length, 1);
  assert.equal(report.failed, 1);
  assert.equal(report.unknownSchema, 0);
  assert.match(describeGaps(report, 2), /matched a known schema but would not decode/);
});

test('a clean run produces no reassuring noise', () => {
  // A "0 problems" line every time trains people to stop reading it.
  const reg = DecoderRegistry.from([TSV]);
  const report = reg.decodeAll([stored('team8793.v1', 'ada\t1\t100\t3\t11\tdeep\tpark', 100)]);
  assert.equal(describeGaps(report, 1), '');
});

test('the registry reports what it can read, for an actionable message', () => {
  const reg = new DecoderRegistry();
  assert.equal(reg.size, 0);
  reg.register(TSV);
  assert.deepEqual(reg.ids(), ['team8793.v1']);
  assert.equal(reg.has('team8793.v1'), true);
  assert.equal(reg.decode('nope', utf8('x')), null);
});

test('the shipped Bridge schemas decode what the Bridge produces', () => {
  const reg = DecoderRegistry.from(Object.values(BridgeSchemas));
  const r = reg.decode('courier.generic.tsv.v1', utf8('ada\t42\t8793\t3\t11\tdeep'));
  assert.ok(r && r.decoded);
  if (!r || !r.decoded) return;
  assert.equal(r.values.auto, 3);
  assert.equal(r.values.teleop, 11);
  assert.equal(r.values.endgame, 'deep');
});

/* ---------------------------------------------------------- observations -- */

const decoded = (team: number, match: number, scout: string, teleop: number): DecodedRecord => ({
  team,
  match,
  eventKey: '2027mose',
  scout,
  values: { teleop },
});

test('scout observations index by alliance position, not by arrival order', () => {
  // Getting this wrong attributes one robot's counts to another, and the blend
  // then reconciles confidently wrong numbers against a correct total.
  const alliance = [100, 101, 102];
  const obs = toScoutObservations(
    [decoded(102, 1, 'a', 9), decoded(100, 1, 'a', 12), decoded(101, 1, 'b', 7)],
    alliance,
    'teleop',
  );
  const byRobot = new Map(obs.map((o) => [o.robot, o.value]));
  assert.equal(byRobot.get(0), 12, 'team 100 is robot 0');
  assert.equal(byRobot.get(2), 9, 'team 102 is robot 2');
});

test('a team outside the alliance is ignored rather than guessed at', () => {
  const obs = toScoutObservations([decoded(999, 1, 'a', 5)], [100, 101, 102], 'teleop');
  assert.deepEqual(obs, []);
});

test('booleans count as one, strings contribute nothing', () => {
  const recs: DecodedRecord[] = [
    { team: 100, match: 1, eventKey: 'e', scout: 'a', values: { climbed: true } },
    { team: 101, match: 1, eventKey: 'e', scout: 'a', values: { climbed: false } },
    { team: 102, match: 1, eventKey: 'e', scout: 'a', values: { climbed: 'deep' } },
  ];
  const obs = toScoutObservations(recs, [100, 101, 102], 'climbed');
  assert.equal(obs.length, 2, 'the string is not coerced into an ordering');
  assert.equal(obs.find((o) => o.robot === 0)!.value, 1);
  assert.equal(obs.find((o) => o.robot === 1)!.value, 0);
});

test('a partial alliance is dropped, because a partial total is a wrong one', () => {
  // Not a smaller observation — the fit would attribute the missing robot's
  // output to the two that were watched.
  const alliances = [{ match: 1, teams: [100, 101, 102] }];
  const complete = toAllianceObservations(
    [decoded(100, 1, 'a', 10), decoded(101, 1, 'a', 20), decoded(102, 1, 'a', 30)],
    alliances,
    'teleop',
  );
  assert.deepEqual(complete, [{ teams: [100, 101, 102], score: 60 }]);

  const partial = toAllianceObservations(
    [decoded(100, 1, 'a', 10), decoded(101, 1, 'a', 20)],
    alliances,
    'teleop',
  );
  assert.deepEqual(partial, []);
});

test('a double-scouted robot is averaged, not counted twice', () => {
  const obs = toAllianceObservations(
    [
      decoded(100, 1, 'a', 10),
      decoded(100, 1, 'b', 14),
      decoded(101, 1, 'a', 20),
      decoded(102, 1, 'a', 30),
    ],
    [{ match: 1, teams: [100, 101, 102] }],
    'teleop',
  );
  assert.equal(obs[0]!.score, 62, '12 + 20 + 30');
});

/* ------------------------------------------------------------ end to end -- */

test('decoded scouting data reaches the blend and the contribution fit', () => {
  // The seam, closed: opaque bodies in, analytics out, on the team's own device.
  const reg = DecoderRegistry.from([TSV]);
  const alliance = [100, 101, 102];

  const report = reg.decodeAll([
    stored('team8793.v1', 'ada\t1\t100\t3\t12\tdeep\tpark', 100),
    stored('team8793.v1', 'bo\t1\t101\t2\t8\tdeep\tpark', 101),
    stored('team8793.v1', 'cy\t1\t102\t1\t15\tdeep\tpark', 102),
  ]);
  assert.equal(report.records.length, 3);

  const scoutObs = toScoutObservations(report.records, alliance, 'teleop');
  const blended = blendWithOfficial({
    priorMean: [10, 10, 10],
    priorVariance: [25, 25, 25],
    observations: scoutObs.map((o) => ({ ...o })),
    officialTotal: 40,
  });
  assert.ok(Math.abs(blended.mean.reduce((a, b) => a + b, 0) - 40) < 1e-9);
  assert.equal(blended.identifiable, true, 'three distinct scouts, three robots');

  const allianceObs = toAllianceObservations(
    report.records,
    [{ match: 1, teams: alliance }],
    'teleop',
  );
  const fit = fitContributions(allianceObs);
  assert.equal(fit.contributions.length, 3);
});
