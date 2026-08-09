import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  loadPack,
  validatePack,
  parseVersion,
  compareVersions,
  classifyChange,
  requiredVersion,
  PackIndex,
  validateBreakdown,
  reconcileTotal,
  PackError,
  type SeasonPack,
} from '../src/index.ts';

const PACK = loadPack(
  JSON.parse(
    readFileSync(fileURLToPath(new URL('../packs/example-synthetic/1.0.0.json', import.meta.url)), 'utf8'),
  ),
);
const index = new PackIndex(PACK);

const clone = (p: SeasonPack): SeasonPack => JSON.parse(JSON.stringify(p)) as SeasonPack;

test('the shipped fixture loads and announces that it is synthetic', () => {
  assert.equal(PACK.packId, 'example-synthetic');
  assert.match(PACK.notes!, /[Nn]ot a real game/);
});

/* ------------------------------------------------------------ versioning --- */

test('versions parse, compare, and reject nonsense', () => {
  assert.deepEqual(parseVersion('2.1.0'), { major: 2, minor: 1, patch: 0 });
  assert.ok(compareVersions('2.1.0', '2.0.9') > 0);
  assert.ok(compareVersions('1.0.0', '1.0.0') === 0);
  assert.ok(compareVersions('1.9.0', '1.10.0') < 0);
  assert.throws(() => parseVersion('2.1'), PackError);
  assert.throws(() => parseVersion('v2.1.0'), PackError);
});

test('a removed field forces MAJOR', () => {
  const next = clone(PACK);
  (next as { fields: unknown[] }).fields = next.fields.slice(1);
  assert.equal(classifyChange(PACK, next), 'major');
  assert.equal(requiredVersion(PACK, next), '2.0.0');
});

test('changed semantics force MAJOR even when the field stays', () => {
  for (const mutate of [
    (f: Record<string, unknown>) => (f.pointsEach = 99),
    (f: Record<string, unknown>) => (f.additive = false),
    (f: Record<string, unknown>) => (f.unit = 'points'),
    (f: Record<string, unknown>) => (f.attribution = 'robot_slot'),
  ]) {
    const next = clone(PACK);
    mutate(next.fields[1] as unknown as Record<string, unknown>);
    assert.equal(classifyChange(PACK, next), 'major', 'semantic change must be MAJOR');
  }
});

test('an added field is MINOR', () => {
  const next = clone(PACK);
  (next.fields as unknown[]).push({
    path: 'teleop.gear.placed',
    type: 'integer',
    unit: 'count',
    pointsEach: 5,
    additive: true,
    attribution: 'alliance',
  });
  assert.equal(classifyChange(PACK, next), 'minor');
  assert.equal(requiredVersion(PACK, next), '1.1.0');
});

test('a moved ranking-point threshold is PATCH — the mid-season Team Update case', () => {
  // A Team Update moving an RP threshold does not change the data SHAPE, so it
  // is a patch — but it must still bump the version, because a picklist built
  // in week 3 has to stay reproducible after week 5 rewrites the threshold.
  const next = clone(PACK);
  (next.rankingPoints[0] as { threshold: number }).threshold = 50;
  (next.rankingPoints[0] as { changedIn?: unknown }).changedIn = { tu: 19, effectiveEventWeek: 5 };
  assert.equal(classifyChange(PACK, next), 'patch');
  assert.equal(requiredVersion(PACK, next), '1.0.1');
});

test('an identical pack requires no bump', () => {
  assert.equal(classifyChange(PACK, clone(PACK)), 'none');
  assert.equal(requiredVersion(PACK, clone(PACK)), '1.0.0');
});

/* ------------------------------------------------------------ validation --- */

test('packs with internally inconsistent semantics are rejected', () => {
  const bad = (mutate: (p: SeasonPack) => void, expect: RegExp): void => {
    const p = clone(PACK);
    mutate(p);
    assert.throws(() => validatePack(p), expect);
  };

  bad((p) => ((p.fields[0] as { additive: boolean }).additive = true, (p.fields[0] as { unit: string }).unit = 'category'), /additive/);
  bad((p) => ((p.fields[0] as { pointsEach?: number }).pointsEach = undefined), /pointsEach/);
  bad((p) => ((p.fields[1] as { path: string }).path = p.fields[0]!.path), /duplicate field path/);
  bad((p) => ((p.fields[0] as { unit: string }).unit = 'furlongs'), /unknown unit/);
  bad((p) => ((p.fields[3] as { values?: unknown }).values = undefined), /enum/);
  bad((p) => ((p.season as unknown as number) = 1800), /season/);
});

test('robot_slot fields must declare low trust — deliberate friction', () => {
  // FMS keys these to driver stations and they are documented as sometimes
  // wrong. Making the pack author say so stops downstream code treating them
  // as an oracle for per-robot data.
  const p = clone(PACK);
  delete (p.fields[3] as { trust?: unknown }).trust;
  assert.throws(() => validatePack(p), /trust/);
});

/* --------------------------------------------------------------- queries --- */

test('concepts join fields across seasons without knowing field names', () => {
  const primary = index.byConcept('scoring.gamepiece.primary');
  assert.equal(primary.length, 2);
  assert.deepEqual(
    primary.map((f) => f.path).sort(),
    ['auto.fuel.high', 'teleop.fuel.high'],
  );
  assert.equal(index.byConcept('nonexistent').length, 0);
});

test('additive fields are exactly those eligible for least-squares decomposition', () => {
  const additive = index.additiveFields().map((f) => f.path);
  assert.deepEqual(additive.sort(), ['auto.fuel.high', 'teleop.fuel.high', 'teleop.fuel.low']);
  // Enums, categories, and penalty points must never enter an OPR design matrix.
  assert.ok(!additive.includes('endgame.robot1.climb'));
  assert.ok(!additive.includes('foul.points'));
});

test('robot-slot fields are identifiable so consumers can distrust them', () => {
  assert.deepEqual(
    index.robotSlotFields().map((f) => f.path).sort(),
    ['auto.robot1.leave', 'endgame.robot1.climb'],
  );
  for (const f of index.robotSlotFields()) assert.equal(f.trust, 'low');
});

/* --------------------------------------------------------------- scoring --- */

const BREAKDOWN = {
  auto: { fuel: { high: 5 }, robot1: { leave: true } },
  teleop: { fuel: { high: 20, low: 12 } },
  endgame: { robot1: { climb: 'High' } },
  foul: { points: 6 },
};

test('the scoring engine is generic over the season', () => {
  const { total, byField } = index.scoreBreakdown(BREAKDOWN);
  // 5*4 auto high + 20*2 teleop high + 12*1 teleop low + 3 leave + 6 foul
  assert.equal(byField.get('auto.fuel.high'), 20);
  assert.equal(byField.get('teleop.fuel.high'), 40);
  assert.equal(byField.get('teleop.fuel.low'), 12);
  assert.equal(byField.get('auto.robot1.leave'), 3);
  assert.equal(byField.get('foul.points'), 6);
  assert.equal(total, 81);
});

test('reconciling against an official total names the disagreement', () => {
  assert.deepEqual(reconcileTotal(index, BREAKDOWN, 81), []);
  const issues = reconcileTotal(index, BREAKDOWN, 90);
  assert.equal(issues.length, 1);
  assert.match(issues[0]!.message, /81.*90|difference 9/);
  // It must not silently prefer either side.
  assert.match(issues[0]!.message, /do not silently prefer/);
});

/* ------------------------------------------------------------- validator --- */

test('implausible and mistyped breakdown values are caught', () => {
  const issues = validateBreakdown(index, {
    auto: { fuel: { high: 500 }, robot1: { leave: 'yes' } },
    teleop: { fuel: { high: -1, low: 3 } },
    endgame: { robot1: { climb: 'Orbit' } },
    foul: { points: 0 },
  });
  const errors = issues.filter((i) => i.severity === 'error');
  const paths = errors.map((e) => e.path);

  assert.ok(paths.includes('auto.fuel.high'), 'plausibility bound');
  assert.ok(paths.includes('auto.robot1.leave'), 'wrong type');
  assert.ok(paths.includes('teleop.fuel.high'), 'negative count');
  assert.ok(paths.includes('endgame.robot1.climb'), 'value outside the enum');
});

test('a field the pack has never heard of warns that the pack may be stale', () => {
  const issues = validateBreakdown(index, { ...BREAKDOWN, coral: { placed: 3 } });
  const stale = issues.find((i) => i.path === 'coral');
  assert.ok(stale, 'unknown top-level key must be reported');
  assert.match(stale!.message, /stale/);
});

test('an absent field warns rather than erroring — breakdowns are often partial', () => {
  const issues = validateBreakdown(index, { teleop: { fuel: { high: 1 } } });
  assert.ok(issues.some((i) => i.severity === 'warning' && i.path === 'auto.fuel.high'));
  assert.equal(issues.filter((i) => i.severity === 'error').length, 0);
});
