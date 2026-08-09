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
  leafPaths,
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
  assert.ok(compareVersions('1.9.0', '1.10.0') < 0);
  assert.throws(() => parseVersion('2.1'), PackError);
});

test('a removed field forces MAJOR', () => {
  const next = clone(PACK);
  (next as { fields: unknown[] }).fields = next.fields.slice(1);
  assert.equal(classifyChange(PACK, next), 'major');
  assert.equal(requiredVersion(PACK, next), '2.0.0');
});

test('every semantic property forces MAJOR, not just the five once compared', () => {
  // classifyChange previously compared type/unit/additive/attribution/pointsEach
  // and nothing else, so a changed concept, trust, or set of enum values
  // classified as 'none' — and requiredVersion then MANDATED shipping different
  // content under the same version string.
  const mutations: Array<[string, (p: SeasonPack) => void]> = [
    ['pointsEach', (p) => ((p.fields[1] as { pointsEach: number }).pointsEach = 99)],
    ['additive', (p) => ((p.fields[1] as { additive: boolean }).additive = false)],
    ['unit', (p) => ((p.fields[1] as { unit: string }).unit = 'points')],
    ['attribution', (p) => ((p.fields[1] as { attribution: string }).attribution = 'robot_slot')],
    ['concept', (p) => ((p.fields[1] as { concept: string }).concept = 'something.else')],
    ['trust', (p) => ((p.fields[3] as { trust: string }).trust = 'high')],
    ['allowNegative', (p) => ((p.fields[6] as { allowNegative: boolean }).allowNegative = false)],
    [
      'enum value renamed',
      (p) => ((p.fields[3] as { values: string[] }).values = ['None', 'Park', 'Shallow', 'Deep']),
    ],
    [
      'enum points changed',
      (p) =>
        ((p.fields[3] as { pointsByValue: Record<string, number> }).pointsByValue = {
          None: 0,
          Park: 2,
          Low: 6,
          High: 99,
        }),
    ],
  ];

  for (const [name, mutate] of mutations) {
    const next = clone(PACK);
    mutate(next);
    assert.equal(classifyChange(PACK, next), 'major', `${name} must be MAJOR`);
    assert.notEqual(requiredVersion(PACK, next), PACK.version, `${name} must force a bump`);
  }
});

test('an added field is MINOR, and so is an added ranking point', () => {
  const withField = clone(PACK);
  (withField.fields as unknown[]).push({
    path: 'teleop.gear.placed',
    type: 'integer',
    unit: 'count',
    pointsEach: 5,
    additive: true,
    attribution: 'alliance',
  });
  assert.equal(classifyChange(PACK, withField), 'minor');
  assert.equal(requiredVersion(PACK, withField), '1.1.0');

  const withRp = clone(PACK);
  (withRp.rankingPoints as unknown[]).push({ key: 'coop_rp', description: 'Synthetic coop.' });
  assert.equal(classifyChange(PACK, withRp), 'minor', 'RP set shape changed');
});

test('a moved ranking-point threshold is PATCH — the mid-season Team Update case', () => {
  const next = clone(PACK);
  (next.rankingPoints[0] as { threshold: number }).threshold = 50;
  (next.rankingPoints[0] as { changedIn?: unknown }).changedIn = { tu: 19, effectiveEventWeek: 5 };
  assert.equal(classifyChange(PACK, next), 'patch');
  assert.equal(requiredVersion(PACK, next), '1.0.1');
});

test('reordering ranking points is not a change at all', () => {
  const next = clone(PACK);
  (next as { rankingPoints: unknown[] }).rankingPoints = [...next.rankingPoints].reverse();
  assert.equal(classifyChange(PACK, next), 'none', 'order carries no meaning');
});

test('a changed Team Update number is at least PATCH', () => {
  const next = clone(PACK);
  (next as { derivedFromTeamUpdate: number }).derivedFromTeamUpdate = 19;
  assert.equal(classifyChange(PACK, next), 'patch');
});

test('packs from different seasons or ids cannot be compared at all', () => {
  const other = clone(PACK);
  (other as { season: number }).season = 2028;
  assert.throws(() => classifyChange(PACK, other), /different seasons/);

  const renamed = clone(PACK);
  (renamed as { packId: string }).packId = 'something-else';
  assert.throws(() => classifyChange(PACK, renamed), /different ids/);
});

test('requiredVersion resets lower components correctly', () => {
  const from = clone(PACK);
  (from as { version: string }).version = '2.3.4';
  const to = clone(from);
  (to.fields as unknown[]).push({
    path: 'x.y',
    type: 'integer',
    unit: 'count',
    pointsEach: 1,
    additive: true,
    attribution: 'alliance',
  });
  assert.equal(requiredVersion(from, to), '2.4.0');
});

/* ------------------------------------------------------------ validation --- */

test('packs with internally inconsistent semantics are rejected', () => {
  const bad = (mutate: (p: SeasonPack) => void, expect: RegExp): void => {
    const p = clone(PACK);
    mutate(p);
    assert.throws(() => validatePack(p), expect);
  };

  bad((p) => {
    (p.fields[0] as { additive: boolean }).additive = true;
    (p.fields[0] as { unit: string }).unit = 'category';
  }, /additive/);
  bad((p) => ((p.fields[1] as { path: string }).path = p.fields[0]!.path), /duplicate field path/);
  bad((p) => ((p.fields[0] as { unit: string }).unit = 'furlongs'), /unknown unit/);
  bad((p) => ((p.fields[3] as { values?: unknown }).values = undefined), /enum/);
  bad((p) => ((p.season as unknown as number) = 1800), /season/);
});

test('a field with no points model at all is rejected — silence is not zero', () => {
  const p = clone(PACK);
  delete (p.fields[1] as { pointsEach?: number }).pointsEach;
  assert.throws(() => validatePack(p), /needs pointsEach/);
});

test('enum point maps must reference real values, and enums cannot use pointsEach', () => {
  const bogusKey = clone(PACK);
  (bogusKey.fields[3] as { pointsByValue: Record<string, number> }).pointsByValue = { Orbit: 5 };
  assert.throws(() => validatePack(bogusKey), /not one of its values/);

  const scalarOnEnum = clone(PACK);
  (scalarOnEnum.fields[3] as { pointsEach?: number }).pointsEach = 3;
  assert.throws(() => validatePack(scalarOnEnum), /pointsByValue, not pointsEach/);
});

test('robot_slot fields must declare low trust — deliberate friction', () => {
  const p = clone(PACK);
  delete (p.fields[3] as { trust?: unknown }).trust;
  assert.throws(() => validatePack(p), /trust/);
});

test('a structurally malformed pack raises PackError, not a raw TypeError', () => {
  assert.throws(() => loadPack({ formatVersion: 1, packId: 'x' }), PackError);
  assert.throws(() => loadPack({ ...clone(PACK), fields: 'nope' }), /fields array/);
  assert.throws(() => loadPack(null), PackError);
});

/* --------------------------------------------------------------- queries --- */

test('concepts join fields across seasons without knowing field names', () => {
  const primary = index.byConcept('scoring.gamepiece.primary');
  assert.deepEqual(primary.map((f) => f.path).sort(), ['auto.fuel.high', 'teleop.fuel.high']);
});

test('additive fields are exactly those eligible for least-squares decomposition', () => {
  const additive = index.additiveFields().map((f) => f.path).sort();
  assert.deepEqual(additive, ['auto.fuel.high', 'teleop.fuel.high', 'teleop.fuel.low']);
  assert.ok(!additive.includes('endgame.robot1.climb'));
  assert.ok(!additive.includes('foul.points'));
});

/* --------------------------------------------------------------- scoring --- */

const BREAKDOWN = {
  auto: { fuel: { high: 5 }, robot1: { leave: true } },
  teleop: { fuel: { high: 20, low: 12 } },
  endgame: { robot1: { climb: 'High' } },
  foul: { points: 6 },
  adjust: { points: -2 },
};

test('the scoring engine scores enums, where every real FRC endgame lives', () => {
  const { total, byField, unpriced } = index.scoreBreakdown(BREAKDOWN);
  assert.equal(byField.get('auto.fuel.high'), 20); // 5 * 4
  assert.equal(byField.get('teleop.fuel.high'), 40); // 20 * 2
  assert.equal(byField.get('teleop.fuel.low'), 12); // 12 * 1
  assert.equal(byField.get('auto.robot1.leave'), 3);
  assert.equal(byField.get('endgame.robot1.climb'), 12, 'the endgame must score');
  assert.equal(byField.get('foul.points'), 6);
  assert.equal(byField.get('adjust.points'), -2);
  assert.equal(total, 91);
  assert.deepEqual(unpriced, [], 'every present field is priced');
});

test('an unpriced field is reported rather than silently contributing zero', () => {
  const p = clone(PACK);
  delete (p.fields[3] as { pointsByValue?: unknown }).pointsByValue;
  const idx = new PackIndex(p);
  const { total, unpriced } = idx.scoreBreakdown(BREAKDOWN);
  assert.equal(total, 79, 'the climb no longer scores');
  assert.deepEqual(unpriced, ['endgame.robot1.climb']);

  // And reconcileTotal points the author at the real cause.
  const issues = reconcileTotal(idx, BREAKDOWN, 91);
  assert.match(issues[0]!.message, /carry no points model/);
  assert.match(issues[0]!.message, /endgame\.robot1\.climb/);
});

test('reconciling against an official total names the disagreement', () => {
  assert.deepEqual(reconcileTotal(index, BREAKDOWN, 91), []);
  const issues = reconcileTotal(index, BREAKDOWN, 100);
  assert.equal(issues.length, 1);
  assert.match(issues[0]!.message, /do not silently prefer/);
});

/* ------------------------------------------------------------- validator --- */

test('implausible and mistyped breakdown values are caught', () => {
  const issues = validateBreakdown(index, {
    auto: { fuel: { high: 500 }, robot1: { leave: 'yes' } },
    teleop: { fuel: { high: -1, low: 3 } },
    endgame: { robot1: { climb: 'Orbit' } },
    foul: { points: 0 },
    adjust: { points: -5 },
  });
  const paths = issues.filter((i) => i.severity === 'error').map((e) => e.path);
  assert.ok(paths.includes('auto.fuel.high'), 'plausibility bound');
  assert.ok(paths.includes('auto.robot1.leave'), 'wrong type');
  assert.ok(paths.includes('teleop.fuel.high'), 'negative count');
  assert.ok(paths.includes('endgame.robot1.climb'), 'value outside the enum');
  assert.ok(!paths.includes('adjust.points'), 'a field declaring allowNegative may go negative');
});

test('staleness detection walks leaves, so a new field inside a known group is caught', () => {
  // A top-level-only check is satisfied by the `auto` prefix and misses this
  // entirely — which is the common shape of a mid-season Team Update.
  const issues = validateBreakdown(index, {
    ...BREAKDOWN,
    auto: { fuel: { high: 5, mid: 99 }, robot1: { leave: true } },
  });
  const stale = issues.find((i) => i.path === 'auto.fuel.mid');
  assert.ok(stale, 'a new leaf inside a known group must be reported');
  assert.match(stale!.message, /stale/);
});

test('FMS aggregates do not cry wolf on every single match', () => {
  const issues = validateBreakdown(index, {
    ...BREAKDOWN,
    totalPoints: 91,
    rp: 3,
    foulCount: 1,
    techFoulCount: 0,
  });
  for (const key of ['totalPoints', 'rp', 'foulCount', 'techFoulCount']) {
    assert.ok(!issues.some((i) => i.path === key), `${key} is an allowlisted aggregate`);
  }
});

test('leafPaths flattens a nested breakdown', () => {
  assert.deepEqual(
    [...leafPaths({ a: { b: 1, c: { d: 2 } }, e: 3 })],
    ['a.b', 'a.c.d', 'e'],
  );
});

test('an absent field warns rather than erroring — breakdowns are often partial', () => {
  const issues = validateBreakdown(index, { teleop: { fuel: { high: 1 } } });
  assert.ok(issues.some((i) => i.severity === 'warning' && i.path === 'auto.fuel.high'));
  assert.equal(issues.filter((i) => i.severity === 'error').length, 0);
});
