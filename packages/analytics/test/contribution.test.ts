import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  fitContributions,
  underDetermined,
  ContributionError,
  cholesky,
  choleskySolve,
  choleskyInverse,
  identity,
  LinalgError,
  type AllianceObservation,
} from '../src/index.ts';

/* ------------------------------------------------------------- fixtures --- */

function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s ^= s << 13;
    s >>>= 0;
    s ^= s >> 17;
    s ^= s << 5;
    s >>>= 0;
    return s / 0x100000000;
  };
}

/** Gaussian noise via Box-Muller, so "noise" means what it says. */
function gauss(rand: () => number, sd: number): number {
  const u = Math.max(1e-9, rand());
  const v = rand();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v) * sd;
}

/**
 * A synthetic event with KNOWN team strengths.
 *
 * The point of synthetic data here is that the right answer exists: an
 * estimator can be checked against truth rather than against its own output.
 */
function syntheticEvent(opts: {
  teams: number;
  matches: number;
  seed: number;
  noiseSd?: number;
}): { truth: Map<number, number>; observations: AllianceObservation[] } {
  const rand = rng(opts.seed);
  const truth = new Map<number, number>();
  for (let t = 0; t < opts.teams; t++) {
    // Strengths spread across a plausible range for one additive field.
    truth.set(1000 + t, 5 + rand() * 45);
  }
  const ids = [...truth.keys()];

  const observations: AllianceObservation[] = [];
  for (let m = 0; m < opts.matches; m++) {
    const shuffled = [...ids].sort(() => rand() - 0.5);
    for (const side of [0, 1]) {
      const teams = shuffled.slice(side * 3, side * 3 + 3);
      const score =
        teams.reduce((s, t) => s + truth.get(t)!, 0) + gauss(rand, opts.noiseSd ?? 4);
      observations.push({ teams, score });
    }
  }
  return { truth, observations };
}

const meanAbsError = (fit: ReturnType<typeof fitContributions>, truth: Map<number, number>): number => {
  let e = 0;
  for (const c of fit.contributions) e += Math.abs(c.mean - truth.get(c.team)!);
  return e / fit.contributions.length;
};

/* --------------------------------------------------------------- linalg --- */

test('Cholesky solves a system it can, and refuses one it cannot', () => {
  // [[4,2],[2,3]] is symmetric positive definite.
  const a = Float64Array.from([4, 2, 2, 3]);
  const l = cholesky(a, 2);
  const x = choleskySolve(l, 2, Float64Array.from([10, 8]));
  // 4x+2y=10, 2x+3y=8  =>  x=1.75, y=1.5
  assert.ok(Math.abs(x[0]! - 1.75) < 1e-9);
  assert.ok(Math.abs(x[1]! - 1.5) < 1e-9);

  // A singular matrix must be reported, not silently pseudo-inverted.
  assert.throws(() => cholesky(Float64Array.from([1, 1, 1, 1]), 2), LinalgError);
  assert.throws(() => cholesky(Float64Array.from([0, 0, 0, 0]), 2), /not positive definite/);
});

test('the inverse from a Cholesky factor really is the inverse', () => {
  const a = Float64Array.from([4, 2, 2, 3]);
  const inv = choleskyInverse(cholesky(a, 2), 2);
  // a * inv should be the identity.
  const prod = [0, 0, 0, 0];
  for (let i = 0; i < 2; i++) {
    for (let j = 0; j < 2; j++) {
      for (let k = 0; k < 2; k++) prod[i * 2 + j]! += a[i * 2 + k]! * inv[k * 2 + j]!;
    }
  }
  const eye = identity(2);
  for (let i = 0; i < 4; i++) assert.ok(Math.abs(prod[i]! - eye[i]!) < 1e-9, `element ${i}`);
});

/* ---------------------------------------------------- recovering truth --- */

test('with a full event, estimates land close to the true strengths', () => {
  const { truth, observations } = syntheticEvent({ teams: 36, matches: 80, seed: 11 });
  const fit = fitContributions(observations);

  // Three teams share every score, so no estimator recovers truth exactly. With
  // 160 alliance observations over 36 teams, a few points is the right order.
  const mae = meanAbsError(fit, truth);
  assert.ok(mae < 4, `mean absolute error was ${mae.toFixed(2)}`);

  // And the ordering, which is what a picklist actually uses, should be sound.
  const byEstimate = [...fit.contributions].sort((a, b) => b.mean - a.mean).map((c) => c.team);
  const byTruth = [...truth.entries()].sort((a, b) => b[1] - a[1]).map(([t]) => t);
  const topFiveOverlap = byEstimate.slice(0, 5).filter((t) => byTruth.slice(0, 8).includes(t)).length;
  assert.ok(topFiveOverlap >= 4, `only ${topFiveOverlap} of the top 5 were genuinely strong`);
});

test('estimates improve as matches accumulate', () => {
  const { truth, observations } = syntheticEvent({ teams: 36, matches: 80, seed: 3 });
  const early = fitContributions(observations.slice(0, 20));
  const late = fitContributions(observations);

  assert.ok(
    meanAbsError(late, truth) < meanAbsError(early, truth),
    'more data must not make the fit worse',
  );
  assert.ok(late.effectiveDof > early.effectiveDof, 'the model earns freedom as data arrives');
});

/* ------------------------------------------------- the underdetermined --- */

test('an underdetermined event still fits, where plain OPR cannot', () => {
  // Four matches, 24 teams: 8 alliance observations against 24 unknowns. The
  // unregularised normal equations are singular here, which is the state every
  // event is in on Friday morning.
  const { observations } = syntheticEvent({ teams: 24, matches: 4, seed: 7 });
  const played = new Set(observations.flatMap((o) => [...o.teams]));
  assert.ok(observations.length < played.size, 'this really is underdetermined');

  const fit = fitContributions(observations);
  // Only teams that actually appeared are fitted. A team that has not played
  // has no estimate, rather than a confident-looking one derived from nothing.
  assert.equal(fit.contributions.length, played.size);
  assert.ok(played.size < 24, 'not every team has taken the field yet');
  for (const c of fit.contributions) {
    assert.ok(Number.isFinite(c.mean), `${c.team} has a finite estimate`);
    assert.ok(Number.isFinite(c.sigma) && c.sigma >= 0, `${c.team} has a finite sigma`);
  }
});

test('with almost no data the estimate stays near the prior instead of lurching', () => {
  // The failure mode of unregularised OPR: three matches in, it reports that
  // somebody contributes 71 points, because nothing in the model objects.
  const observations: AllianceObservation[] = [
    { teams: [1, 2, 3], score: 150 },
    { teams: [4, 5, 6], score: 30 },
  ];
  const fit = fitContributions(observations, { prior: 30 });

  for (const c of fit.contributions) {
    assert.ok(
      c.mean > 0 && c.mean < 90,
      `${c.team} estimated at ${c.mean.toFixed(1)}, which is a lurch`,
    );
  }
  // The high-scoring alliance should still rank above the low one.
  const strong = fit.contributions.filter((c) => c.team <= 3).reduce((s, c) => s + c.mean, 0);
  const weak = fit.contributions.filter((c) => c.team > 3).reduce((s, c) => s + c.mean, 0);
  assert.ok(strong > weak, 'the signal that does exist is still used');
});

test('shrinkage is stronger when there is less data', () => {
  const { observations } = syntheticEvent({ teams: 30, matches: 60, seed: 5 });
  const early = fitContributions(observations.slice(0, 12));
  const late = fitContributions(observations);
  assert.ok(
    early.lambda >= late.lambda,
    `early lambda ${early.lambda} should not be below late ${late.lambda}`,
  );
});

/* ------------------------------------------------------------ uncertainty */

test('uncertainty is always present and shrinks with appearances', () => {
  const { observations } = syntheticEvent({ teams: 30, matches: 60, seed: 21 });
  const fit = fitContributions(observations);

  for (const c of fit.contributions) {
    assert.ok(c.sigma > 0, `${c.team} must carry a real sigma`);
    assert.ok(Number.isFinite(c.sigma));
  }

  const early = fitContributions(observations.slice(0, 16));
  const meanSigma = (f: typeof fit) =>
    f.contributions.reduce((s, c) => s + c.sigma, 0) / f.contributions.length;
  assert.ok(meanSigma(fit) < meanSigma(early), 'more data must reduce uncertainty');
});

test('noisier scoring produces wider intervals, not just different means', () => {
  const quiet = syntheticEvent({ teams: 30, matches: 60, seed: 9, noiseSd: 2 });
  const loud = syntheticEvent({ teams: 30, matches: 60, seed: 9, noiseSd: 20 });

  const q = fitContributions(quiet.observations);
  const l = fitContributions(loud.observations);
  assert.ok(l.residualSigma > q.residualSigma, 'the fit must notice the extra noise');
});

test('thinly-observed teams are flagged rather than ranked alongside the rest', () => {
  // A team with two appearances has an estimate and it means nothing. Formatting
  // it identically to a well-measured one is how a picklist ranks noise.
  const observations: AllianceObservation[] = [
    ...syntheticEvent({ teams: 12, matches: 20, seed: 4 }).observations,
    { teams: [9001, 9002, 9003], score: 120 },
  ];
  const fit = fitContributions(observations);
  const thin = underDetermined(fit, 4).map((c) => c.team);

  for (const t of [9001, 9002, 9003]) assert.ok(thin.includes(t), `${t} must be flagged`);
  assert.ok(!thin.includes(1000), 'a well-observed team must not be');
});

/* ---------------------------------------------------------------- inputs -- */

test('a supplied prior is honoured, per team or globally', () => {
  const observations: AllianceObservation[] = [{ teams: [1, 2, 3], score: 90 }];

  const flat = fitContributions(observations, { prior: 30, lambda: 1e6 });
  for (const c of flat.contributions) {
    assert.ok(Math.abs(c.mean - 30) < 0.1, 'with huge lambda the fit is the prior');
  }

  const perTeam = fitContributions(observations, {
    prior: new Map([
      [1, 50],
      [2, 20],
      [3, 20],
    ]),
    lambda: 1e6,
  });
  const one = perTeam.contributions.find((c) => c.team === 1)!;
  assert.ok(Math.abs(one.mean - 50) < 0.1, 'per-team priors are used');
});

test('an explicit lambda overrides cross-validation', () => {
  const { observations } = syntheticEvent({ teams: 20, matches: 30, seed: 6 });
  assert.equal(fitContributions(observations, { lambda: 42 }).lambda, 42);
});

test('empty input is an error rather than an empty answer', () => {
  assert.throws(() => fitContributions([]), ContributionError);
});

test('a single alliance observation still produces a usable fit', () => {
  const fit = fitContributions([{ teams: [1, 2, 3], score: 60 }]);
  assert.equal(fit.contributions.length, 3);
  for (const c of fit.contributions) assert.ok(Number.isFinite(c.mean) && c.sigma >= 0);
});

test('the fit works on any additive field, not only total score', () => {
  // Alliance sums of a Season Pack field marked `additive` give component
  // contributions with no change to the estimator.
  const observations: AllianceObservation[] = [
    { teams: [1, 2, 3], score: 12 },
    { teams: [4, 5, 6], score: 3 },
    { teams: [1, 4, 5], score: 9 },
    { teams: [2, 3, 6], score: 8 },
    { teams: [1, 3, 5], score: 10 },
    { teams: [2, 4, 6], score: 5 },
  ];
  const fit = fitContributions(observations);
  const t1 = fit.contributions.find((c) => c.team === 1)!;
  const t6 = fit.contributions.find((c) => c.team === 6)!;
  assert.ok(t1.mean > t6.mean, 'the team on every high-scoring alliance should rank higher');
});
