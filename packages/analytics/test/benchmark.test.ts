import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  spearman,
  kendallTau,
  rankValues,
  ndcg,
  captainRegret,
  brierScore,
  logLoss,
  accuracy,
  evaluate,
  formatEvaluations,
  BenchmarkError,
  MIN_TEAMS_FOR_STABLE_RANKING,
  type RankedTeam,
  type TruthEntry,
} from '../src/index.ts';

const near = (a: number, b: number, tol = 1e-9): void => {
  assert.ok(Math.abs(a - b) < tol, `${a} !== ${b} (tol ${tol})`);
};

/* ------------------------------------------------------------- rank maths -- */

test('ties are averaged, as both correlations assume', () => {
  assert.deepEqual(rankValues([10, 20, 30]), [1, 2, 3]);
  assert.deepEqual(rankValues([10, 10, 30]), [1.5, 1.5, 3]);
  assert.deepEqual(rankValues([5, 5, 5]), [2, 2, 2]);
});

test('Spearman is 1 for a perfect ordering and -1 for an inverted one', () => {
  near(spearman([1, 2, 3, 4], [10, 20, 30, 40]), 1);
  near(spearman([1, 2, 3, 4], [40, 30, 20, 10]), -1);
});

test('a constant prediction scores zero rather than NaN', () => {
  // NaN would propagate silently into a comparison table and quietly poison it.
  assert.equal(spearman([5, 5, 5], [1, 2, 3]), 0);
  assert.equal(kendallTau([5, 5, 5], [1, 2, 3]), 0);
});

test('Kendall counts head-to-head pairs, and one swap costs a known amount', () => {
  near(kendallTau([1, 2, 3, 4], [1, 2, 3, 4]), 1);
  // Swapping one adjacent pair of four makes 5 of 6 pairs concordant.
  near(kendallTau([1, 2, 3, 4], [2, 1, 3, 4]), (5 - 1) / 6);
});

test('mismatched input lengths are refused', () => {
  assert.throws(() => spearman([1, 2], [1]), BenchmarkError);
  assert.throws(() => kendallTau([1, 2], [1]), BenchmarkError);
});

/* --------------------------------------------------------------- ndcg@k --- */

const truth: TruthEntry[] = [
  { team: 1, actual: 50 },
  { team: 2, actual: 40 },
  { team: 3, actual: 30 },
  { team: 4, actual: 20 },
  { team: 5, actual: 10 },
];

test('a perfect list scores 1, and the top of the list dominates', () => {
  const perfect: RankedTeam[] = truth.map((t) => ({ team: t.team, predicted: t.actual }));
  near(ndcg(perfect, truth, 3), 1);

  // Getting rank 1 wrong hurts far more than getting rank 5 wrong, which is the
  // right shape: a captain reads the first names and never looks at the tail.
  const badTop: RankedTeam[] = [
    { team: 5, predicted: 100 },
    { team: 2, predicted: 40 },
    { team: 3, predicted: 30 },
    { team: 4, predicted: 20 },
    { team: 1, predicted: 10 },
  ];
  const badTail: RankedTeam[] = [
    { team: 1, predicted: 100 },
    { team: 2, predicted: 40 },
    { team: 3, predicted: 30 },
    { team: 5, predicted: 20 },
    { team: 4, predicted: 10 },
  ];
  assert.ok(ndcg(badTop, truth, 5) < ndcg(badTail, truth, 5));
});

test('an all-zero ground truth scores zero instead of dividing by zero', () => {
  const flat = truth.map((t) => ({ team: t.team, actual: 0 }));
  assert.equal(ndcg([{ team: 1, predicted: 1 }], flat, 3), 0);
});

/* -------------------------------------------------------- captain regret -- */

test('a perfect list has zero regret', () => {
  const perfect: RankedTeam[] = truth.map((t) => ({ team: t.team, predicted: t.actual }));
  const r = captainRegret(perfect, truth, { picks: 2 });
  assert.equal(r.regret, 0);
  assert.equal(r.achieved, 90, 'takes the two best: 50 + 40');
  assert.deepEqual(r.picked, [1, 2]);
});

test('an inverted list gives up exactly the points it should', () => {
  const inverted: RankedTeam[] = truth.map((t) => ({ team: t.team, predicted: -t.actual }));
  const r = captainRegret(inverted, truth, { picks: 2 });
  assert.equal(r.achieved, 30, 'takes the two worst: 10 + 20');
  assert.equal(r.oracle, 90);
  assert.equal(r.regret, 60);
});

test('regret is a draft metric: a model is not punished for an unavailable team', () => {
  // A model that ranks the very best team first loses nothing when that team is
  // taken anyway — both it and the oracle face the same depletion.
  const perfect: RankedTeam[] = truth.map((t) => ({ team: t.team, predicted: t.actual }));
  const r = captainRegret(perfect, truth, { picks: 2, picksBetween: 2 });
  assert.equal(r.regret, 0, 'still optimal among what was actually available');
  assert.ok(r.achieved < 90, 'but it does get less, because the board depleted');
});

test('depletion changes which list is better, not just the totals', () => {
  // A model whose second name is strong beats one whose second name is weak,
  // even when both get the same first pick.
  const board: TruthEntry[] = [
    { team: 1, actual: 50 },
    { team: 2, actual: 45 },
    { team: 3, actual: 44 },
    { team: 4, actual: 5 },
  ];
  const good: RankedTeam[] = [
    { team: 1, predicted: 9 },
    { team: 3, predicted: 8 },
    { team: 2, predicted: 7 },
    { team: 4, predicted: 6 },
  ];
  const bad: RankedTeam[] = [
    { team: 1, predicted: 9 },
    { team: 4, predicted: 8 },
    { team: 2, predicted: 7 },
    { team: 3, predicted: 6 },
  ];
  const g = captainRegret(good, board, { picks: 2, picksBetween: 1 });
  const b = captainRegret(bad, board, { picks: 2, picksBetween: 1 });
  assert.ok(g.regret < b.regret, 'a strong second name is worth real points');
});

test('regret never goes negative, even when the model gets lucky', () => {
  const perfect: RankedTeam[] = truth.map((t) => ({ team: t.team, predicted: t.actual }));
  for (const between of [0, 1, 2, 3]) {
    const r = captainRegret(perfect, truth, { picks: 2, picksBetween: between });
    assert.ok(r.regret >= 0, `between=${between}`);
  }
});

test('an empty board is an error rather than a zero score', () => {
  assert.throws(() => captainRegret([], truth), BenchmarkError);
});

/* ---------------------------------------------------------- calibration --- */

test('Brier and log loss reward confidence only when it is earned', () => {
  const confidentRight = [{ probability: 0.95, won: true }];
  const confidentWrong = [{ probability: 0.95, won: false }];
  const hedged = [{ probability: 0.5, won: true }];

  assert.ok(brierScore(confidentRight) < brierScore(hedged));
  assert.ok(brierScore(confidentWrong) > brierScore(hedged));
  // Log loss punishes the confident mistake far harder than Brier does.
  assert.ok(logLoss(confidentWrong) > 10 * logLoss(confidentRight));
});

test('a coin flip scores 0.25 on Brier, which is the number to beat', () => {
  near(brierScore([{ probability: 0.5, won: true }, { probability: 0.5, won: false }]), 0.25);
});

test('a 0.5 forecast is not a call, so it does not earn accuracy', () => {
  // Crediting half of them would let a model that predicts nothing score 50%.
  assert.equal(accuracy([{ probability: 0.5, won: true }]), 0);
  assert.equal(accuracy([{ probability: 0.6, won: true }]), 1);
  assert.equal(accuracy([{ probability: 0.6, won: false }]), 0);
});

test('probabilities outside [0,1] are refused, not clamped silently', () => {
  assert.throws(() => brierScore([{ probability: 1.4, won: true }]), /outside/);
  assert.throws(() => logLoss([{ probability: -0.1, won: true }]), /outside/);
  assert.throws(() => brierScore([]), /no predictions/);
});

/* ------------------------------------------------------------- the report -- */

const bigTruth: TruthEntry[] = Array.from({ length: 24 }, (_, i) => ({
  team: 100 + i,
  actual: 60 - 2 * i,
}));

test('a full evaluation reports ranking and calibration together', () => {
  const ranked = bigTruth.map((t) => ({ team: t.team, predicted: t.actual }));
  const e = evaluate({
    modelName: 'oracle',
    ranked,
    truth: bigTruth,
    predictions: [
      { probability: 0.9, won: true },
      { probability: 0.8, won: true },
    ],
  });

  near(e.spearman, 1);
  near(e.kendall, 1);
  near(e.ndcg, 1);
  assert.equal(e.regret.regret, 0);
  assert.ok(e.brier !== undefined && e.accuracy !== undefined);
  assert.equal(e.teams, 24);
});

test('the ground-truth label is always reported, never left implicit', () => {
  const ranked = bigTruth.map((t) => ({ team: t.team, predicted: t.actual }));
  const e = evaluate({ modelName: 'm', ranked, truth: bigTruth });
  assert.match(e.label, /post-hoc contribution/);
  assert.ok(
    e.caveats.some((c) => /strategic\s+fit/.test(c)),
    'the report must say what it cannot see',
  );
});

test('a thin field is flagged rather than compared against a full event', () => {
  const small = bigTruth.slice(0, 5);
  const e = evaluate({
    modelName: 'm',
    ranked: small.map((t) => ({ team: t.team, predicted: t.actual })),
    truth: small,
  });
  assert.ok(e.caveats.some((c) => c.includes('Only 5 teams')));
  assert.ok(MIN_TEAMS_FOR_STABLE_RANKING > 5);
});

test('teams with no ground truth are excluded and the exclusion is reported', () => {
  const e = evaluate({
    modelName: 'm',
    ranked: [...bigTruth.map((t) => ({ team: t.team, predicted: t.actual })), { team: 999, predicted: 99 }],
    truth: bigTruth,
  });
  assert.equal(e.teams, 24, 'the unknown team is not scored');
  assert.ok(e.caveats.some((c) => /1 ranked team\(s\) had no ground truth/.test(c)));
  near(e.spearman, 1, 1e-9);
});

test('calibration metrics are omitted rather than faked when absent', () => {
  const e = evaluate({
    modelName: 'm',
    ranked: bigTruth.map((t) => ({ team: t.team, predicted: t.actual })),
    truth: bigTruth,
  });
  assert.equal(e.brier, undefined);
  assert.equal(e.accuracy, undefined);
  assert.match(formatEvaluations([e]), /-\s+-$/m, 'the table shows a dash, not a zero');
});

test('an evaluation with nothing in common with the truth is an error', () => {
  assert.throws(
    () => evaluate({ modelName: 'm', ranked: [{ team: 999, predicted: 1 }], truth: bigTruth }),
    /no ranked team appears/,
  );
  assert.throws(() => evaluate({ modelName: 'm', ranked: [], truth: bigTruth }), /no ranked teams/);
});

test('a better model beats a worse one on every ranking metric', () => {
  const good = bigTruth.map((t) => ({ team: t.team, predicted: t.actual + (t.team % 3) }));
  const noise = bigTruth.map((t) => ({ team: t.team, predicted: (t.team * 7919) % 100 }));

  const a = evaluate({ modelName: 'good', ranked: good, truth: bigTruth });
  const b = evaluate({ modelName: 'noise', ranked: noise, truth: bigTruth });

  assert.ok(a.spearman > b.spearman);
  assert.ok(a.kendall > b.kendall);
  assert.ok(a.ndcg > b.ndcg);
  assert.ok(a.regret.regret <= b.regret.regret);
});

test('the comparison table leads with ranking, and explains regret', () => {
  const models = ['a', 'b'].map((name, i) =>
    evaluate({
      modelName: name,
      ranked: bigTruth.map((t) => ({ team: t.team, predicted: t.actual + i * (t.team % 5) })),
      truth: bigTruth,
      predictions: [{ probability: 0.7, won: true }],
    }),
  );
  const text = formatEvaluations(models);

  assert.match(text, /spearman\s+kendall\s+ndcg@k\s+regret/);
  assert.match(text, /ground truth: post-hoc contribution/);
  assert.match(text, /regret = points a captain gives up/);
  assert.match(text, /superset of the usual/);
  assert.equal(formatEvaluations([]), 'No models evaluated.');
});
