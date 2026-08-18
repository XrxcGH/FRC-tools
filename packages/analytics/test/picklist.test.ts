import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  allianceScore,
  rankPicklist,
  contingencies,
  formatPicklist,
  seededRng,
  PicklistError,
  type TeamEstimate,
} from '../src/index.ts';

const team = (n: number, mean: number, sigma = 3, sharedShare?: number): TeamEstimate => ({
  team: n,
  mean,
  sigma,
  ...(sharedShare !== undefined ? { sharedShare } : {}),
});

const rng = () => seededRng(12345);

/* ------------------------------------------------------- alliance score --- */

test('with no contention model an alliance is plainly additive', () => {
  assert.equal(allianceScore([team(1, 30), team(2, 20), team(3, 10)]), 60);
  assert.equal(allianceScore([]), 0);
});

test('contention discounts shared-resource demand above capacity', () => {
  // Three robots that each score by monopolising the same feeder do not make a
  // 120-point alliance, and a picklist that assumes they do will build one.
  const members = [team(1, 40, 3, 40), team(2, 40, 3, 40), team(3, 40, 3, 40)];
  const additive = allianceScore(members);
  const contended = allianceScore(members, { capacity: 80, gamma: 1 });

  assert.equal(additive, 120);
  assert.equal(contended, 80, '40 of shared demand above capacity is discarded');
});

test('contention leaves an alliance under capacity untouched', () => {
  const members = [team(1, 40, 3, 10), team(2, 40, 3, 10)];
  assert.equal(allianceScore(members, { capacity: 80, gamma: 1 }), 80);
});

test('gamma zero disables the model rather than silently half-applying it', () => {
  const members = [team(1, 40, 3, 40), team(2, 40, 3, 40)];
  assert.equal(allianceScore(members, { capacity: 0, gamma: 0 }), 80);
});

/* ------------------------------------------------------------- the draft -- */

const board = [
  team(101, 40),
  team(102, 36),
  team(103, 32),
  team(104, 28),
  team(105, 24),
  team(106, 20),
];
const captain = [team(1, 45, 2)];

test('with no rival picks the ranking degenerates to a sort, correctly', () => {
  // Picking last means the board is static, and then a sort IS the right answer.
  const ranked = rankPicklist({
    candidates: board,
    alliance: captain,
    picksBeforeYourNext: 0,
    haveSecondPick: false,
    simulations: 800,
    rng: rng(),
  });
  assert.deepEqual(ranked.map((r) => r.team), [101, 102, 103, 104, 105, 106]);
  for (const r of ranked) assert.equal(r.availabilityRisk, 0);
});

test('availability risk rises with how many rivals pick before your turn', () => {
  const few = rankPicklist({
    candidates: board,
    alliance: captain,
    picksBeforeYourNext: 1,
    haveSecondPick: true,
    simulations: 600,
    rng: rng(),
  });
  const many = rankPicklist({
    candidates: board,
    alliance: captain,
    picksBeforeYourNext: 4,
    haveSecondPick: true,
    simulations: 600,
    rng: rng(),
  });

  // The best team is already certain to be gone after ONE rival pick, so the
  // effect has to be read mid-board, where there is room to move.
  const mid = (r: typeof few) => r.find((x) => x.team === 104)!;
  assert.ok(
    mid(many).availabilityRisk > mid(few).availabilityRisk,
    'a deeper wait means the board depletes further',
  );
  assert.ok(mid(few).availabilityRisk < 0.1, 'a mid-board team survives one pick');
  assert.ok(mid(many).availabilityRisk > 0.5, 'but rarely survives four');

  const top = (r: typeof few) => r.find((x) => x.team === 101)!;
  assert.equal(top(few).availabilityRisk, 1, 'the best team never survives even one pick');
});

test('a team nobody else wants carries less availability risk than a contested one', () => {
  const ranked = rankPicklist({
    candidates: board,
    alliance: captain,
    picksBeforeYourNext: 2,
    haveSecondPick: true,
    simulations: 800,
    rng: rng(),
  });
  const contested = ranked.find((r) => r.team === 101)!;
  const overlooked = ranked.find((r) => r.team === 106)!;
  assert.ok(contested.availabilityRisk > overlooked.availabilityRisk);
});

test('every entry carries a floor and a ceiling, not just a point estimate', () => {
  // Second-pick decisions are floor-driven, and the research found no shipped
  // tool exposes a floor at all.
  const ranked = rankPicklist({
    candidates: board,
    alliance: captain,
    picksBeforeYourNext: 1,
    haveSecondPick: false,
    simulations: 800,
    rng: rng(),
  });
  for (const r of ranked) {
    assert.ok(r.floor < r.ceiling, `team ${r.team} must have a real interval`);
    assert.ok(Number.isFinite(r.floor) && Number.isFinite(r.ceiling));
  }
});

test('a wider posterior produces a wider interval at the same mean', () => {
  const ranked = rankPicklist({
    candidates: [team(201, 30, 1), team(202, 30, 10)],
    alliance: captain,
    picksBeforeYourNext: 0,
    haveSecondPick: false,
    simulations: 2000,
    rng: rng(),
  });
  const tight = ranked.find((r) => r.team === 201)!;
  const loose = ranked.find((r) => r.team === 202)!;
  assert.ok(loose.ceiling - loose.floor > tight.ceiling - tight.floor);
  assert.ok(loose.floor < tight.floor, 'the risky team has the worse bad day');
});

test('contention changes who is worth taking, not just the totals', () => {
  // Two strong teams that fight over the same resource are worth less together
  // than a strong team plus a complementary one.
  const hog = team(301, 38, 2, 38);
  const complement = team(302, 34, 2, 0);
  const allianceHog = [team(1, 40, 2, 40)];

  const ranked = rankPicklist({
    candidates: [hog, complement],
    alliance: allianceHog,
    picksBeforeYourNext: 0,
    haveSecondPick: false,
    contention: { capacity: 45, gamma: 1 },
    simulations: 1200,
    rng: rng(),
  });
  assert.equal(ranked[0]!.team, 302, 'the complementary team wins despite a lower rating');
});

test('when expected value ties, the higher floor wins', () => {
  // A real and common tie: in a serpentine draft, taking A and leaving B often
  // yields the same final alliance as taking B and leaving A. Array order would
  // then silently rank a shakier team above a steadier one.
  const ranked = rankPicklist({
    candidates: [team(401, 20, 12), team(402, 20, 2)],
    alliance: captain,
    picksBeforeYourNext: 0,
    haveSecondPick: false,
    simulations: 3000,
    rng: rng(),
  });

  const steady = ranked.find((r) => r.team === 402)!;
  const shaky = ranked.find((r) => r.team === 401)!;
  assert.ok(steady.floor > shaky.floor, 'the low-sigma team has the better bad day');

  if (Math.abs(ranked[0]!.expectedValue - ranked[1]!.expectedValue) < 1e-9) {
    assert.equal(ranked[0]!.team, 402, 'a tie must break toward the floor');
  }
  // And the ordering is at least never floor-inverted at equal value.
  assert.ok(ranked[0]!.expectedValue > ranked[1]!.expectedValue || ranked[0]!.floor >= ranked[1]!.floor);
});

test('excluded teams never appear, whatever the numbers say', () => {
  const ranked = rankPicklist({
    candidates: board,
    alliance: captain,
    picksBeforeYourNext: 1,
    haveSecondPick: false,
    exclude: [101, 102],
    simulations: 400,
    rng: rng(),
  });
  assert.equal(ranked.length, 4);
  assert.ok(!ranked.some((r) => r.team === 101 || r.team === 102));
});

test('the same seed produces the same picklist', () => {
  // A picklist recomputed mid-meeting that reorders itself for no reason
  // destroys trust in the tool faster than being slightly wrong would.
  const args = {
    candidates: board,
    alliance: captain,
    picksBeforeYourNext: 2,
    haveSecondPick: true,
    simulations: 500,
  };
  const a = rankPicklist({ ...args, rng: seededRng(7) });
  const b = rankPicklist({ ...args, rng: seededRng(7) });
  assert.deepEqual(a.map((r) => r.team), b.map((r) => r.team));
  assert.deepEqual(a.map((r) => r.expectedValue), b.map((r) => r.expectedValue));
});

test('malformed input is refused rather than ranked', () => {
  assert.throws(
    () =>
      rankPicklist({
        candidates: [],
        alliance: captain,
        picksBeforeYourNext: 0,
        haveSecondPick: false,
      }),
    PicklistError,
  );
  assert.throws(
    () =>
      rankPicklist({
        candidates: [team(1, NaN)],
        alliance: captain,
        picksBeforeYourNext: 0,
        haveSecondPick: false,
      }),
    /malformed estimate/,
  );
  assert.throws(
    () =>
      rankPicklist({
        candidates: board,
        alliance: captain,
        picksBeforeYourNext: -1,
        haveSecondPick: false,
      }),
    /cannot be negative/,
  );
});

/* -------------------------------------------------------- contingencies --- */

test('contingencies answer "the top N are gone, now what"', () => {
  const ranked = rankPicklist({
    candidates: board,
    alliance: captain,
    picksBeforeYourNext: 0,
    haveSecondPick: false,
    simulations: 400,
    rng: rng(),
  });
  const plan = contingencies(ranked, 3);

  assert.equal(plan.length, 3);
  assert.deepEqual(plan[0], { goneTeams: [101], take: 102 });
  assert.deepEqual(plan[1], { goneTeams: [101, 102], take: 103 });
  assert.deepEqual(plan[2]!.goneTeams.length, 3);
});

test('contingencies stop at the end of the board rather than inventing picks', () => {
  const ranked = rankPicklist({
    candidates: [team(1, 10), team(2, 9)],
    alliance: captain,
    picksBeforeYourNext: 0,
    haveSecondPick: false,
    simulations: 200,
    rng: rng(),
  });
  assert.equal(contingencies(ranked, 5).length, 1);
});

test('the printed form is readable off paper under time pressure', () => {
  const ranked = rankPicklist({
    candidates: board,
    alliance: captain,
    picksBeforeYourNext: 2,
    haveSecondPick: true,
    simulations: 400,
    rng: rng(),
  });
  const text = formatPicklist(ranked, 3);

  assert.match(text, /#\s+team\s+total\s+floor\s+ceiling\s+risk/);
  assert.equal(text.split('\n').filter((l) => /^\s+\d+\s+\d+/.test(l)).length, 3);
  assert.match(text, /percentile/, 'the column is explained, not assumed');
  assert.match(text, /risk = chance this team is gone/);
  // The two column groups are on different scales; the header must separate them.
  assert.match(text, /this team alone/);
  assert.match(text, /alliance total = your alliance WITH this pick/);
  // These candidates carry no per-match spread, so the legend must say the
  // floor describes our estimate of the average rather than a bad day.
  assert.match(text, /estimate of their AVERAGE/);
});

test('with no per-match spread the legend refuses to claim a bad day', () => {
  // The Ledger path fits contributions from official ALLIANCE totals, which
  // cannot recover a team's match-to-match consistency. Saying "what you get on
  // a bad day" there would be inventing it.
  const ranked = rankPicklist({
    candidates: [team(111, 30), team(222, 25)],
    alliance: [team(8793, 30)],
    picksBeforeYourNext: 0,
    haveSecondPick: false,
    rng: seededRng(1),
  });
  assert.equal(ranked[0]!.floorBasis, 'estimate-only');

  const text = formatPicklist(ranked, 5);
  assert.match(text, /estimate of their AVERAGE/);
  assert.match(text, /does not tell you/);
  assert.ok(!/on a bad day/.test(text), 'claimed a bad-day range it cannot compute');
});

test('ranking uses the estimate, not the single-match spread', () => {
  // A wilder robot with the same average is not a better pick; it is the same
  // expected value with more variance. Expected alliance value must not move
  // just because spread went up, or the board would rank on volatility.
  const base = { picksBeforeYourNext: 0, haveSecondPick: false, rng: seededRng(1) };
  const tight = rankPicklist({
    ...base,
    candidates: [{ team: 111, mean: 30, sigma: 3, spread: 1 }],
    alliance: [{ team: 8793, mean: 30, sigma: 3, spread: 1 }],
  });
  const wild = rankPicklist({
    ...base,
    candidates: [{ team: 111, mean: 30, sigma: 3, spread: 25 }],
    alliance: [{ team: 8793, mean: 30, sigma: 3, spread: 1 }],
  });

  assert.ok(
    Math.abs(tight[0]!.expectedValue - wild[0]!.expectedValue) < 1,
    'spread leaked into the ranking',
  );
  assert.ok(
    wild[0]!.ceiling - wild[0]!.floor > tight[0]!.ceiling - tight[0]!.floor,
    'spread did not reach the floor/ceiling either',
  );
});
