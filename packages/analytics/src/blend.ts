/**
 * Blending scout observations with the official alliance total.
 *
 * The design calls this "the piece nobody ships", and the research found five
 * teams who hand-rolled the arithmetic and none who packaged it. The problem is
 * concrete: FMS publishes an alliance total and nothing per robot, while scouts
 * produce per-robot counts that are noisy and sometimes plain wrong. Neither
 * source alone answers "how much did team 8793 contribute".
 *
 * The move is to treat the official total as a HARD LINEAR CONSTRAINT on the
 * per-robot estimates rather than as another noisy observation. Three scouts'
 * counts get forced to sum to what actually happened, and the correction is
 * distributed in proportion to how uncertain each robot's estimate was — a
 * confident estimate barely moves, a shaky one absorbs most of the discrepancy.
 *
 * ── Why the maths stays small ───────────────────────────────────────────────
 * The prior is diagonal (robots are a priori independent) and each scout
 * observation touches exactly one robot, so the posterior after the scout
 * update is still diagonal. That makes the whole update a handful of scalar
 * operations rather than a matrix solve, for an alliance of three. The
 * constraint step does introduce correlation — that is what a constraint IS —
 * but the marginal variances, which is all a picklist consumes, stay closed
 * form.
 */

import { cholesky, choleskySolve } from './linalg.ts';

export class BlendError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BlendError';
  }
}

export interface ScoutObservation {
  /** Index of the robot within this alliance, 0-based. */
  readonly robot: number;
  readonly value: number;
  /** Opaque scout pseudonym. Never a name. */
  readonly scout: string;
  /**
   * Observation precision, 1/σ². Higher means more trusted.
   *
   * Defaults to 1. Supply per-scout values from `scoutReliability` once enough
   * double-scouted matches exist to estimate them.
   */
  readonly precision?: number;
  /** Additive bias correction for this scout, subtracted before the update. */
  readonly bias?: number;
}

export interface BlendInput {
  /** Prior mean per robot, in this field's units. */
  readonly priorMean: readonly number[];
  /** Prior variance per robot. Must be positive. */
  readonly priorVariance: readonly number[];
  readonly observations: readonly ScoutObservation[];
  /**
   * The official alliance total, when it is known.
   *
   * Omit it and this degrades to a plain Bayesian update from the scouts —
   * which is exactly what happens in a pit with no uplink, where today's
   * results cannot reach the device (D-5). The result says so.
   */
  readonly officialTotal?: number;
  /**
   * Variance on the official total. 0 for an alliance-level FMS figure, which
   * is exact.
   *
   * Use a LARGE value for station-keyed fields such as leave, climb and park:
   * those are documented as sometimes wrong, so they are a noisy measurement
   * rather than a constraint.
   */
  readonly officialVariance?: number;
}

export interface BlendResult {
  readonly mean: number[];
  /** Marginal variance per robot. Not a covariance — the constraint correlates them. */
  readonly variance: number[];
  /** True when the official total was applied. */
  readonly constrained: boolean;
  /** Robots with at least one scout observation. */
  readonly observedRobots: number;
  /**
   * False when the estimate cannot really separate the robots — one scout
   * covering an alliance, or robots with no observation at all. The numbers are
   * still the best available, but they are mostly prior plus an even share of
   * the constraint, and a UI must not present them as measurements.
   */
  readonly identifiable: boolean;
  readonly notes: string[];
}

const DEFAULT_PRECISION = 1;

/**
 * Posterior per-robot contributions.
 *
 * Step 1 is an ordinary Gaussian update from the scouts, in information form so
 * that multiple observations of one robot compose by addition. Step 2 conditions
 * on the alliance total.
 */
export function blendWithOfficial(input: BlendInput): BlendResult {
  const n = input.priorMean.length;
  if (n === 0) throw new BlendError('an alliance needs at least one robot');
  if (input.priorVariance.length !== n) {
    throw new BlendError(
      `priorMean has ${n} entries but priorVariance has ${input.priorVariance.length}`,
    );
  }
  for (const v of input.priorVariance) {
    if (!(v > 0) || !Number.isFinite(v)) {
      throw new BlendError('every prior variance must be finite and positive');
    }
  }
  for (const m of input.priorMean) {
    if (!Number.isFinite(m)) throw new BlendError('prior means must be finite');
  }

  // --- 1. scout update, in information form -------------------------------
  // Λ_ii = 1/σ0_i² + Σ precision   and   η_i = μ0_i/σ0_i² + Σ precision·(y − bias)
  const lambda = input.priorVariance.map((v) => 1 / v);
  const eta = input.priorMean.map((m, i) => m * lambda[i]!);
  const seen = new Array<number>(n).fill(0);
  const scouts = new Set<string>();

  for (const o of input.observations) {
    if (!Number.isInteger(o.robot) || o.robot < 0 || o.robot >= n) {
      throw new BlendError(`observation names robot ${o.robot}, outside 0..${n - 1}`);
    }
    if (!Number.isFinite(o.value)) throw new BlendError('observation values must be finite');
    const p = o.precision ?? DEFAULT_PRECISION;
    if (!(p > 0) || !Number.isFinite(p)) {
      throw new BlendError('observation precision must be finite and positive');
    }
    lambda[o.robot] += p;
    eta[o.robot] += p * (o.value - (o.bias ?? 0));
    seen[o.robot]!++;
    scouts.add(o.scout);
  }

  let mean = eta.map((e, i) => e / lambda[i]!);
  let variance = lambda.map((l) => 1 / l);

  const observedRobots = seen.filter((c) => c > 0).length;
  const notes: string[] = [];

  // --- 2. condition on the official total ---------------------------------
  const constrained = input.officialTotal !== undefined;
  if (constrained) {
    const total = input.officialTotal!;
    if (!Number.isFinite(total)) throw new BlendError('the official total must be finite');
    const r = input.officialVariance ?? 0;
    if (r < 0 || !Number.isFinite(r)) {
      throw new BlendError('officialVariance must be finite and non-negative');
    }

    // A = [1 … 1], so AΣAᵀ is just the sum of the marginal variances.
    const s = variance.reduce((a, b) => a + b, 0) + r;
    if (!(s > 0)) {
      throw new BlendError('degenerate constraint: zero total variance');
    }
    const residual = total - mean.reduce((a, b) => a + b, 0);

    // Kalman gain per robot: how much of the discrepancy this robot absorbs.
    // Proportional to its own uncertainty, which is the whole point — a robot
    // three scouts agreed on barely moves.
    const gain = variance.map((v) => v / s);
    mean = mean.map((m, i) => m + gain[i]! * residual);
    // Σ* = Σ − ΣAᵀ(AΣAᵀ+R)⁻¹AΣ. Diagonal entries only; the constraint does
    // introduce off-diagonal correlation, which a picklist does not consume.
    variance = variance.map((v, i) => Math.max(0, v - gain[i]! * v));

    if (r === 0) {
      notes.push(
        'The per-robot estimates are forced to sum to the official alliance total exactly.',
      );
    } else {
      notes.push(
        'The official total was treated as a noisy measurement rather than an exact ' +
          'constraint, which is correct for station-keyed fields (leave, climb, park) that ' +
          'FMS is documented to get wrong.',
      );
    }
  } else {
    notes.push(
      'No official total was available, so these are scout estimates alone and are NOT ' +
        'reconciled against what actually happened. This is the normal state in a pit with no ' +
        'uplink until someone carries results in.',
    );
  }

  // --- 3. say plainly when this cannot separate the robots -----------------
  const identifiable = observedRobots === n && scouts.size > 1;
  if (observedRobots < n) {
    notes.push(
      `${n - observedRobots} of ${n} robots had no scout observation. Their values come from ` +
        'the prior plus a share of the constraint, not from anyone watching them.',
    );
  }
  if (scouts.size === 1 && n > 1) {
    // Small teams routinely run one or two scouts across six robots. The
    // constraint is still valid; the per-robot split is close to unidentifiable.
    notes.push(
      'Every observation came from one scout, so a systematic bias by that scout cannot be ' +
        'distinguished from the robots genuinely differing. Treat the split as indicative.',
    );
  }

  return { mean, variance, constrained, observedRobots, identifiable, notes };
}

/* -------------------------------------------------------------------------- */
/* Scout reliability                                                          */
/* -------------------------------------------------------------------------- */

export interface ScoutResidual {
  readonly scout: string;
  /** Observed minus the blended posterior for the same robot and match. */
  readonly residual: number;
}

export interface ScoutQuality {
  readonly scout: string;
  readonly observations: number;
  /** Systematic over- or under-count. Subtract it before the next update. */
  readonly bias: number;
  /** 1/σ², for use as an observation precision. */
  readonly precision: number;
  /**
   * False until there are enough observations for the estimate to mean
   * anything. A scout with three matches gets essentially the pool average, and
   * the flag says so rather than dressing it up.
   */
  readonly reliable: boolean;
}

/** Below this many observations a scout's own statistics are mostly noise. */
export const MIN_OBSERVATIONS_FOR_RELIABILITY = 8;

/**
 * Per-scout bias and precision, shrunk toward the pool.
 *
 * Partial pooling rather than per-scout maximum likelihood: a scout with three
 * matches would otherwise get a precision estimated from three numbers, which is
 * worse than assuming they are average. The shrinkage weight is
 * n/(n+k) with k the minimum-observations constant, so a scout converges to
 * their own statistics as evidence accumulates.
 */
export function scoutReliability(residuals: readonly ScoutResidual[]): ScoutQuality[] {
  const byScout = new Map<string, number[]>();
  for (const r of residuals) {
    if (!Number.isFinite(r.residual)) continue;
    const list = byScout.get(r.scout) ?? [];
    list.push(r.residual);
    byScout.set(r.scout, list);
  }
  if (byScout.size === 0) return [];

  const all = [...byScout.values()].flat();
  const poolBias = mean(all);
  const poolVariance = Math.max(variance(all, poolBias), 1e-9);

  const k = MIN_OBSERVATIONS_FOR_RELIABILITY;
  const out: ScoutQuality[] = [];

  for (const [scout, xs] of byScout) {
    const n = xs.length;
    const w = n / (n + k);
    const ownBias = mean(xs);
    const ownVariance = n > 1 ? Math.max(variance(xs, ownBias), 1e-9) : poolVariance;

    const bias = w * ownBias + (1 - w) * poolBias;
    const v = w * ownVariance + (1 - w) * poolVariance;

    out.push({
      scout,
      observations: n,
      bias,
      precision: 1 / v,
      reliable: n >= k,
    });
  }
  return out.sort((a, b) => b.precision - a.precision);
}

function mean(xs: readonly number[]): number {
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

function variance(xs: readonly number[], m: number): number {
  if (xs.length < 2) return 0;
  return xs.reduce((a, x) => a + (x - m) ** 2, 0) / (xs.length - 1);
}

/* -------------------------------------------------------------------------- */
/* Drifting scouts                                                            */
/* -------------------------------------------------------------------------- */

export interface CusumState {
  /** Accumulated evidence of over-reporting. */
  readonly high: number;
  /** Accumulated evidence of under-reporting. */
  readonly low: number;
  readonly alarm: boolean;
  /** Observations since the last alarm or reset. */
  readonly since: number;
}

/**
 * Slack and threshold, in units of the pool's own disagreement spread.
 *
 * MEASURED, not quoted. These were 0.5 and 4 — the textbook pairing, carried in
 * with a comment admitting they had never been checked. Running the real
 * `courier scouts` command against generated events with no drift injected
 * accused one or two innocent scouts every time, so they were measured:
 * `packages/analytics/bench/cusum-operating-point.ts` reproduces the table.
 *
 * At 0.5 / 4 a clean scout alarms with probability 0.24 over the ~48 paired
 * observations of a two-day event. With six scouts that is an 81% chance of
 * accusing somebody who did nothing wrong, EVERY event. The textbook figure
 * (in-control run length ~168) is not wrong, it is answering a different
 * question: teams run their scouts in parallel and care about the chance that
 * any of them is falsely flagged once.
 *
 * At 0.75 / 5 that falls to 1.0% per scout, 6% across a team of six, while a
 * 1.5σ or worse drift is still caught essentially every time within three to
 * five of that scout's paired observations. The price is missing about a fifth
 * of mild 1σ drifts, and that is the right trade: a drift table people believe
 * catches more real problems than a stricter one they have learned to skip.
 */
export const CUSUM_SLACK = 0.75;
export const CUSUM_THRESHOLD = 5;

/**
 * CUSUM on the standardised residual — the detector that actually catches a
 * scout losing attention.
 *
 * A scout who stops watching does not go silent. They keep submitting, and the
 * numbers drift systematically low. A per-match outlier test never fires on that
 * because no single match is extreme; the drift only shows up cumulatively.
 *
 * A noiseless one-sigma bias adds 0.25 per observation, so it needs 21 to cross
 * the threshold; with real noise the bench measures a median of 11 and catches
 * about four in five. A 1.5-sigma drift takes 7 noiseless, 5 with noise, and is
 * caught essentially always. The mild case is deliberately slow — that is the
 * price of the false-alarm rate — and the serious case is fast enough to re-task
 * somebody mid-event, which is the operational claim that matters
 * — fast enough to re-task someone during an event, slow enough that a clean
 * scout is almost never accused. See CUSUM_SLACK for the measurement behind
 * them. They are still calibrated against SIMULATED drift, not against real
 * scouting data, because none was available here; what has been checked is the
 * false-alarm rate, which is a property of the detector rather than of the
 * data.
 */
export function cusumUpdate(
  previous: CusumState | null,
  standardisedResidual: number,
): CusumState {
  const prev = previous ?? { high: 0, low: 0, alarm: false, since: 0 };
  if (!Number.isFinite(standardisedResidual)) return prev;

  const high = Math.max(0, prev.high + standardisedResidual - CUSUM_SLACK);
  const low = Math.max(0, prev.low - standardisedResidual - CUSUM_SLACK);
  const alarm = high > CUSUM_THRESHOLD || low > CUSUM_THRESHOLD;

  // Reset on alarm so the next drift is detected from scratch rather than
  // latching forever after one bad stretch.
  if (alarm) return { high: 0, low: 0, alarm: true, since: 0 };
  return { high, low, alarm: false, since: prev.since + 1 };
}

/** Direction of a drift, for a message an operator can act on. */
export function describeDrift(state: CusumState, lastResidual: number): string {
  if (!state.alarm) return '';
  return lastResidual < 0
    ? 'This scout has been under-counting for several matches. Check they are still watching ' +
        'the right robot.'
    : 'This scout has been over-counting for several matches. Check they are not double-' +
        'counting shared game pieces.';
}

/* -------------------------------------------------------------------------- */
/* Disentangling scouts from each other                                       */
/* -------------------------------------------------------------------------- */

export interface PeerComparison {
  readonly scout: string;
  /** The other scouts on the same robot in the same match. */
  readonly peers: readonly string[];
  /** This scout's value minus the mean of their peers' values. */
  readonly residual: number;
}

export interface ScoutEffect {
  readonly scout: string;
  /** Additive offset from the group, centred so the effects sum to zero. */
  readonly effect: number;
  readonly comparisons: number;
}

/** Ridge weight for the effects fit. Small: this system is only rank-deficient by one. */
export const SCOUT_EFFECT_LAMBDA = 0.5;

/**
 * Who is actually off, when everyone is measured against everyone else.
 *
 * Peer residuals cannot be read one row at a time. With two scouts on a robot
 * the two residuals are exact negatives of each other: if one drifts low by 5,
 * the other's residual is +5 through no fault of their own. Run a drift
 * detector on those raw numbers and one careless scout sets off an alarm on
 * every honest person they were ever paired with — which is worse than no
 * detector, because a table of alarms that are mostly wrong teaches people to
 * stop reading it.
 *
 * The disambiguation has to come from ACROSS pairings. A scout who reads low
 * against everyone is low; a scout who only looks high when paired with that
 * one person is fine. So this fits an additive effect per scout to
 *
 *     residual(i, j) = effect(i) - mean(effect(p) for p in peers(j))
 *
 * by ridge least squares, and the caller subtracts the peers' fitted effects
 * before looking at anybody's numbers. Adding a constant to every effect leaves
 * every residual unchanged, so the system is rank-deficient by exactly one; the
 * ridge term picks the minimum-norm solution and the result is then centred
 * explicitly rather than left to depend on the regulariser.
 *
 * This still cannot separate two scouts who are the ONLY pair that ever watches
 * a robot together — there is no third opinion to break the symmetry, and the
 * fit will split the difference between them. That is a real limit of peer
 * consensus and not something a better estimator fixes.
 */
export function scoutEffects(
  rows: readonly PeerComparison[],
  lambda: number = SCOUT_EFFECT_LAMBDA,
): ScoutEffect[] {
  const names = [...new Set(rows.flatMap((r) => [r.scout, ...r.peers]))].sort();
  const n = names.length;
  if (n === 0) return [];
  if (n === 1) return [{ scout: names[0]!, effect: 0, comparisons: rows.length }];

  const index = new Map(names.map((s, i) => [s, i]));
  const counts = new Map<string, number>();

  // Normal equations, accumulated row by row: no design matrix is materialised
  // because it is one row per comparison and mostly zeros.
  const ata = new Float64Array(n * n);
  const atb = new Float64Array(n);

  for (const r of rows) {
    if (!Number.isFinite(r.residual) || r.peers.length === 0) continue;
    counts.set(r.scout, (counts.get(r.scout) ?? 0) + 1);

    const row = new Float64Array(n);
    row[index.get(r.scout)!] = 1;
    const share = 1 / r.peers.length;
    for (const p of r.peers) row[index.get(p)!] -= share;

    for (let i = 0; i < n; i++) {
      const vi = row[i]!;
      if (vi === 0) continue;
      atb[i] += vi * r.residual;
      for (let j = 0; j < n; j++) {
        const vj = row[j]!;
        if (vj !== 0) ata[i * n + j] += vi * vj;
      }
    }
  }

  for (let i = 0; i < n; i++) ata[i * n + i] += lambda;

  const solved = choleskySolve(cholesky(ata, n), n, atb);
  const centre = [...solved].reduce((a, b) => a + b, 0) / n;

  return names
    .map((scout, i) => ({
      scout,
      effect: solved[i]! - centre,
      comparisons: counts.get(scout) ?? 0,
    }))
    .sort((a, b) => a.effect - b.effect);
}

/**
 * Each comparison with the PEERS' fitted effects removed.
 *
 * What is left is that scout's own deviation on that robot in that match,
 * uncontaminated by whoever they happened to be sitting next to. This is the
 * sequence a drift detector should walk, and the sequence a bias estimate
 * should average.
 */
export function adjustForPeers(
  rows: readonly PeerComparison[],
  effects: readonly ScoutEffect[],
): number[] {
  const byName = new Map(effects.map((e) => [e.scout, e.effect]));
  return rows.map((r) => {
    if (r.peers.length === 0) return r.residual;
    const peerMean =
      r.peers.reduce((a, p) => a + (byName.get(p) ?? 0), 0) / r.peers.length;
    return r.residual + peerMean;
  });
}
