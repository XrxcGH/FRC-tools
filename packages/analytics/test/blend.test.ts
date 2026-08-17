import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  blendWithOfficial,
  scoutReliability,
  cusumUpdate,
  describeDrift,
  BlendError,
  MIN_OBSERVATIONS_FOR_RELIABILITY,
  CUSUM_THRESHOLD,
  type CusumState,
} from '../src/index.ts';

const near = (a: number, b: number, tol = 1e-9): void => {
  assert.ok(Math.abs(a - b) < tol, `${a} !== ${b} (tol ${tol})`);
};

const prior = { priorMean: [10, 10, 10], priorVariance: [25, 25, 25] };

/* ------------------------------------------------------------ constraint -- */

test('the posterior sums to the official total exactly', () => {
  // The whole point: three scouts' counts are forced to add up to what the
  // field actually reported.
  const r = blendWithOfficial({
    ...prior,
    observations: [
      { robot: 0, value: 12, scout: 'a' },
      { robot: 1, value: 8, scout: 'b' },
      { robot: 2, value: 15, scout: 'c' },
    ],
    officialTotal: 40,
  });

  near(r.mean.reduce((a, b) => a + b, 0), 40, 1e-9);
  assert.equal(r.constrained, true);
  assert.equal(r.identifiable, true);
  assert.match(r.notes.join(' '), /forced to sum/);
});

test('the correction lands on the least certain robot', () => {
  // A robot three scouts agreed on should barely move; a robot nobody watched
  // should absorb the discrepancy. That proportionality is what makes this
  // better than dividing the residual evenly.
  const r = blendWithOfficial({
    priorMean: [10, 10, 10],
    priorVariance: [25, 25, 25],
    observations: [
      // Robot 0 heavily observed, so its posterior variance collapses.
      { robot: 0, value: 10, scout: 'a', precision: 50 },
      { robot: 0, value: 10, scout: 'b', precision: 50 },
      { robot: 1, value: 10, scout: 'c' },
    ],
    officialTotal: 60, // 30 more than the observations imply
  });

  const moved = r.mean.map((m, i) => m - [10, 10, 10][i]!);
  assert.ok(moved[0]! < moved[1]!, 'the well-observed robot moves least');
  assert.ok(moved[1]! < moved[2]!, 'the unobserved robot moves most');
  near(r.mean.reduce((a, b) => a + b, 0), 60, 1e-9);
});

test('conditioning on an exact total never increases uncertainty', () => {
  const unconstrained = blendWithOfficial({
    ...prior,
    observations: [{ robot: 0, value: 12, scout: 'a' }],
  });
  const constrained = blendWithOfficial({
    ...prior,
    observations: [{ robot: 0, value: 12, scout: 'a' }],
    officialTotal: 35,
  });

  for (let i = 0; i < 3; i++) {
    assert.ok(
      constrained.variance[i]! <= unconstrained.variance[i]! + 1e-12,
      `robot ${i}: knowing the total cannot make an estimate less certain`,
    );
  }
});

test('a noisy official total is a measurement, not a constraint', () => {
  // Station-keyed fields — leave, climb, park — are documented as sometimes
  // wrong, so forcing the sum to match them would propagate FMS's error.
  const exact = blendWithOfficial({
    ...prior,
    observations: [{ robot: 0, value: 12, scout: 'a' }],
    officialTotal: 40,
    officialVariance: 0,
  });
  const noisy = blendWithOfficial({
    ...prior,
    observations: [{ robot: 0, value: 12, scout: 'a' }],
    officialTotal: 40,
    officialVariance: 100,
  });

  near(exact.mean.reduce((a, b) => a + b, 0), 40, 1e-9);
  const noisySum = noisy.mean.reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(noisySum - 40) > 1e-6, 'a noisy total must not be matched exactly');
  assert.match(noisy.notes.join(' '), /noisy measurement/);
});

/* ------------------------------------------------------------- the scouts -- */

test('more agreeing scouts sharpen the estimate', () => {
  const one = blendWithOfficial({
    ...prior,
    observations: [{ robot: 0, value: 12, scout: 'a' }],
  });
  const three = blendWithOfficial({
    ...prior,
    observations: [
      { robot: 0, value: 12, scout: 'a' },
      { robot: 0, value: 12, scout: 'b' },
      { robot: 0, value: 12, scout: 'c' },
    ],
  });
  assert.ok(three.variance[0]! < one.variance[0]!);
  assert.ok(Math.abs(three.mean[0]! - 12) < Math.abs(one.mean[0]! - 12));
});

test('a scout bias is corrected before it reaches the estimate', () => {
  const raw = blendWithOfficial({
    ...prior,
    observations: [{ robot: 0, value: 15, scout: 'a', precision: 10 }],
  });
  const debiased = blendWithOfficial({
    ...prior,
    observations: [{ robot: 0, value: 15, scout: 'a', precision: 10, bias: 5 }],
  });
  assert.ok(debiased.mean[0]! < raw.mean[0]!, 'a known over-counter is pulled back');
});

/* ------------------------------------------------------- honest degradation */

test('one scout across an alliance is flagged as not identifiable', () => {
  // Small teams routinely run one or two scouts over six robots. The constraint
  // still holds; the per-robot split does not really separate them, and a UI
  // must not present it as a measurement.
  const r = blendWithOfficial({
    ...prior,
    observations: [
      { robot: 0, value: 12, scout: 'solo' },
      { robot: 1, value: 9, scout: 'solo' },
      { robot: 2, value: 14, scout: 'solo' },
    ],
    officialTotal: 40,
  });
  assert.equal(r.identifiable, false);
  assert.match(r.notes.join(' '), /one scout/i);
  assert.match(r.notes.join(' '), /indicative/);
});

test('an unwatched robot is named, not quietly invented', () => {
  const r = blendWithOfficial({
    ...prior,
    observations: [
      { robot: 0, value: 12, scout: 'a' },
      { robot: 1, value: 9, scout: 'b' },
    ],
    officialTotal: 40,
  });
  assert.equal(r.observedRobots, 2);
  assert.equal(r.identifiable, false);
  assert.match(r.notes.join(' '), /1 of 3 robots had no scout observation/);
});

test('with no official total it says the numbers are unreconciled', () => {
  // The pit-with-no-uplink case (D-5). Presenting these as if they were
  // reconciled is exactly the failure the design warns about.
  const r = blendWithOfficial({
    ...prior,
    observations: [{ robot: 0, value: 12, scout: 'a' }],
  });
  assert.equal(r.constrained, false);
  assert.match(r.notes.join(' '), /NOT\s+reconciled/);
  assert.match(r.notes.join(' '), /no uplink/);
});

test('malformed input is refused rather than silently producing numbers', () => {
  assert.throws(() => blendWithOfficial({ priorMean: [], priorVariance: [], observations: [] }), BlendError);
  assert.throws(
    () => blendWithOfficial({ priorMean: [1, 2], priorVariance: [1], observations: [] }),
    /priorVariance/,
  );
  assert.throws(
    () => blendWithOfficial({ priorMean: [1], priorVariance: [0], observations: [] }),
    /positive/,
  );
  assert.throws(
    () => blendWithOfficial({ ...prior, observations: [{ robot: 7, value: 1, scout: 'a' }] }),
    /outside 0\.\.2/,
  );
  assert.throws(
    () => blendWithOfficial({ ...prior, observations: [{ robot: 0, value: 1, scout: 'a', precision: 0 }] }),
    /precision/,
  );
});

/* ---------------------------------------------------------- reliability --- */

test('a scout with few observations is shrunk toward the pool and flagged', () => {
  const residuals = [
    ...Array.from({ length: 30 }, () => ({ scout: 'veteran', residual: 0.1 })),
    { scout: 'rookie', residual: 9 },
    { scout: 'rookie', residual: 9 },
  ];
  const q = scoutReliability(residuals);
  const rookie = q.find((s) => s.scout === 'rookie')!;
  const veteran = q.find((s) => s.scout === 'veteran')!;

  assert.equal(rookie.reliable, false);
  assert.equal(veteran.reliable, true);
  assert.ok(
    rookie.bias < 9,
    'two observations must not buy a full-strength bias estimate',
  );
  assert.ok(veteran.precision > rookie.precision, 'consistency earns precision');
});

test('reliability needs the stated number of observations before it is trusted', () => {
  const few = scoutReliability(
    Array.from({ length: MIN_OBSERVATIONS_FOR_RELIABILITY - 1 }, () => ({ scout: 'a', residual: 1 })),
  );
  assert.equal(few[0]!.reliable, false);

  const enough = scoutReliability(
    Array.from({ length: MIN_OBSERVATIONS_FOR_RELIABILITY }, () => ({ scout: 'a', residual: 1 })),
  );
  assert.equal(enough[0]!.reliable, true);
});

test('no residuals yields no claims', () => {
  assert.deepEqual(scoutReliability([]), []);
  assert.deepEqual(scoutReliability([{ scout: 'a', residual: NaN }]), []);
});

/* ---------------------------------------------------------------- CUSUM --- */

test('one bad match does not raise an alarm', () => {
  let state: CusumState | null = null;
  state = cusumUpdate(state, 3);
  assert.equal(state.alarm, false, 'a single outlier is not a drifting scout');
});

test('a sustained one-sigma drift alarms within a handful of matches', () => {
  // A scout who stops watching keeps submitting and drifts low. No single match
  // is extreme, so only the cumulative sum catches it.
  let state: CusumState | null = null;
  let matches = 0;
  while (matches < 20) {
    state = cusumUpdate(state, -1);
    matches++;
    if (state.alarm) break;
  }
  assert.equal(state!.alarm, true, 'must eventually fire');
  assert.ok(matches >= 4 && matches <= 10, `fired after ${matches} matches`);
  assert.match(describeDrift(state!, -1), /under-counting/);
});

test('an accurate scout never alarms, however long they scout', () => {
  let state: CusumState | null = null;
  const wobble = [0.4, -0.3, 0.2, -0.5, 0.1, 0.3, -0.2, 0.45, -0.4, 0.05];
  for (let i = 0; i < 200; i++) {
    state = cusumUpdate(state, wobble[i % wobble.length]!);
    assert.equal(state.alarm, false, `false alarm at observation ${i}`);
  }
});

test('an alarm resets, so the next drift is detected from scratch', () => {
  let state: CusumState | null = null;
  for (let i = 0; i < 20 && !(state?.alarm ?? false); i++) state = cusumUpdate(state, 2);
  assert.equal(state!.alarm, true);
  assert.equal(state!.high, 0, 'not latched forever after one bad stretch');
  assert.match(describeDrift(state!, 2), /over-counting/);

  const next = cusumUpdate(state, 0);
  assert.equal(next.alarm, false);
});

test('the alarm threshold is what the constants say it is', () => {
  // Guards against someone tuning the constants without revisiting the claim
  // that an alarm takes four to six one-sigma matches.
  assert.equal(CUSUM_THRESHOLD, 4);
  let state: CusumState | null = null;
  let n = 0;
  while (!(state?.alarm ?? false) && n < 50) {
    state = cusumUpdate(state, -1);
    n++;
  }
  assert.equal(n, 9, 'slack 0.5 and threshold 4 means nine half-sigma steps');
});
