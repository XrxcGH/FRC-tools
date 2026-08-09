/**
 * Team contribution estimates from alliance scores — OPR, but honest about
 * what it does not know.
 *
 * ── Why not plain OPR ───────────────────────────────────────────────────────
 * Ordinary OPR solves the normal equations AᵀA x = Aᵀb, where A is one row per
 * alliance-match and one column per team. That matrix is singular whenever
 * 2m < n, which is true through roughly qualification match 4 at every event
 * and true for the *whole* event at a small one. Implementations paper over it
 * with a pseudo-inverse, which is numerically fine and statistically
 * indefensible: with three matches played, an unregularised fit will happily
 * report that a team's contribution is 71 points, because nothing in the model
 * says otherwise.
 *
 * This shrinks toward a prior instead:
 *
 *     x̂ = μ + (AᵀA + λI)⁻¹ Aᵀ(b − Aμ)
 *
 * With no data the estimate is the prior. With a lot of data the prior washes
 * out. In between — which is where a picklist is actually built — it degrades
 * gracefully rather than lurching.
 *
 * ── Why uncertainty is not optional ─────────────────────────────────────────
 * Second-pick decisions are floor-driven: a captain wants the robot that will
 * not have a bad day, not the one with the highest mean. A rating without a
 * variance cannot express a floor, and every shipped tool in this space
 * displays a point estimate and hides the spread. So `sigma` is a required
 * field here and in the venue pack, not an optional extra.
 */

import {
  cholesky,
  choleskySolve,
  choleskyInverse,
  identity,
  at,
  set,
  traceProduct,
  LinalgError,
  type Matrix,
} from './linalg.ts';

export class ContributionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ContributionError';
  }
}

/** One alliance's appearance in one match: who was on it, and what they scored. */
export interface AllianceObservation {
  readonly teams: readonly number[];
  readonly score: number;
}

export interface ContributionOptions {
  /**
   * Ridge parameter. Larger means more shrinkage toward the prior.
   *
   * Omit it and one is chosen by cross-validation, which is almost always what
   * you want: the right value depends on how many matches have been played, and
   * that changes hourly during an event.
   */
  readonly lambda?: number;
  /**
   * Prior contribution, per team or a single value for all.
   *
   * Defaults to the mean alliance score divided by three — the assumption that
   * an unknown robot is an average third of an average alliance, which is both
   * the least informative honest guess and the right units.
   */
  readonly prior?: number | ReadonlyMap<number, number>;
  /** Grid searched when `lambda` is omitted. */
  readonly lambdaGrid?: readonly number[];
}

export interface TeamContribution {
  readonly team: number;
  /** Point estimate, in the units of the score column that was fitted. */
  readonly mean: number;
  /** Standard deviation of the estimate. Never omitted. */
  readonly sigma: number;
  /** Alliance-appearances this team has. Two or three is not a measurement. */
  readonly appearances: number;
}

export interface ContributionFit {
  readonly contributions: TeamContribution[];
  /** The ridge parameter used, whether supplied or chosen. */
  readonly lambda: number;
  /** Effective degrees of freedom: tr(A(AᵀA+λI)⁻¹Aᵀ). Between 0 and n. */
  readonly effectiveDof: number;
  /** Residual standard deviation of the fit, in score units. */
  readonly residualSigma: number;
  readonly observations: number;
  readonly teams: number;
}

const DEFAULT_GRID = [0.5, 1, 2, 4, 8, 16, 32, 64, 128, 256];

/**
 * Fit contributions.
 *
 * Works with any additive quantity, not only total score — pass alliance sums
 * of a Season Pack field marked `additive` and you get component contributions
 * for free. That is the direct payoff of the pack carrying additivity as data.
 */
export function fitContributions(
  observations: readonly AllianceObservation[],
  options: ContributionOptions = {},
): ContributionFit {
  if (observations.length === 0) {
    throw new ContributionError('no observations to fit');
  }

  const teamList = [...new Set(observations.flatMap((o) => [...o.teams]))].sort((a, b) => a - b);
  const n = teamList.length;
  const index = new Map(teamList.map((t, i) => [t, i]));
  const m = observations.length;

  const appearances = new Map<number, number>();
  for (const o of observations) {
    for (const t of o.teams) appearances.set(t, (appearances.get(t) ?? 0) + 1);
  }

  // Prior. The default says an unknown robot is an average third of an average
  // alliance, which is the least informative guess that still has correct units.
  const meanScore = observations.reduce((s, o) => s + o.score, 0) / m;
  const priorFor = (team: number): number => {
    if (typeof options.prior === 'number') return options.prior;
    if (options.prior) return options.prior.get(team) ?? meanScore / 3;
    return meanScore / 3;
  };
  const mu = new Float64Array(n);
  for (let i = 0; i < n; i++) mu[i] = priorFor(teamList[i]!);

  // Normal equations, accumulated without materialising A: for each alliance
  // row the design is a 0/1 indicator over its teams, so AᵀA gains 1 at every
  // pair and Aᵀr gains r at every member.
  const ata = new Float64Array(n * n);
  const residualTarget = new Float64Array(n);

  for (const o of observations) {
    const idx = o.teams.map((t) => index.get(t)!);
    let predictedByPrior = 0;
    for (const i of idx) predictedByPrior += mu[i]!;
    const r = o.score - predictedByPrior;

    for (const i of idx) {
      residualTarget[i] += r;
      for (const j of idx) set(ata, n, i, j, at(ata, n, i, j) + 1);
    }
  }

  const lambda = options.lambda ?? chooseLambda(observations, teamList, mu, options.lambdaGrid ?? DEFAULT_GRID);

  const { x, l } = solveRidge(ata, n, residualTarget, lambda);

  // Residuals of the fitted model, for the noise scale.
  let sse = 0;
  for (const o of observations) {
    let pred = 0;
    for (const t of o.teams) {
      const i = index.get(t)!;
      pred += mu[i]! + x[i]!;
    }
    sse += (o.score - pred) ** 2;
  }

  // Effective degrees of freedom: tr(A(AᵀA+λI)⁻¹Aᵀ) = tr((AᵀA+λI)⁻¹ AᵀA).
  const inv = choleskyInverse(l, n);
  const effectiveDof = traceProduct(inv, ata, n);
  const denom = Math.max(1, m - effectiveDof);
  const residualVariance = sse / denom;

  // Cov(x̂) ≈ σ² (AᵀA+λI)⁻¹ AᵀA (AᵀA+λI)⁻¹. Only the diagonal is needed.
  const contributions: TeamContribution[] = teamList.map((team, i) => {
    let v = 0;
    for (let a = 0; a < n; a++) {
      for (let b = 0; b < n; b++) {
        v += at(inv, n, i, a) * at(ata, n, a, b) * at(inv, n, b, i);
      }
    }
    return {
      team,
      mean: mu[i]! + x[i]!,
      sigma: Math.sqrt(Math.max(0, residualVariance * v)),
      appearances: appearances.get(team) ?? 0,
    };
  });

  return {
    contributions,
    lambda,
    effectiveDof,
    residualSigma: Math.sqrt(residualVariance),
    observations: m,
    teams: n,
  };
}

function solveRidge(
  ata: Matrix,
  n: number,
  target: Float64Array,
  lambda: number,
): { x: Float64Array; l: Matrix } {
  const ridged = new Float64Array(ata);
  for (let i = 0; i < n; i++) set(ridged, n, i, i, at(ridged, n, i, i) + lambda);
  try {
    const l = cholesky(ridged, n);
    return { x: choleskySolve(l, n, target), l };
  } catch (err) {
    if (err instanceof LinalgError) {
      throw new ContributionError(
        `${err.message} Try a larger lambda, or wait for more matches to be played.`,
      );
    }
    throw err;
  }
}

/**
 * Pick λ by k-fold cross-validation on held-out alliance observations.
 *
 * The right amount of shrinkage depends on how much data exists, and at an
 * event that changes hourly — so it is measured rather than configured. Early
 * on, cross-validation picks heavy shrinkage because the data cannot support
 * anything else; by Saturday it relaxes on its own.
 */
export function chooseLambda(
  observations: readonly AllianceObservation[],
  teamList: readonly number[],
  mu: Float64Array,
  grid: readonly number[],
): number {
  const m = observations.length;
  const folds = Math.min(5, m);
  if (folds < 2) return grid[grid.length - 1]!; // no data to validate against

  const n = teamList.length;
  const index = new Map(teamList.map((t, i) => [t, i]));

  let best = grid[0]!;
  let bestErr = Number.POSITIVE_INFINITY;

  for (const lambda of grid) {
    let err = 0;
    let counted = 0;

    for (let f = 0; f < folds; f++) {
      const ata = new Float64Array(n * n);
      const target = new Float64Array(n);

      for (let k = 0; k < m; k++) {
        if (k % folds === f) continue; // held out
        const o = observations[k]!;
        const idx = o.teams.map((t) => index.get(t)!);
        let byPrior = 0;
        for (const i of idx) byPrior += mu[i]!;
        const r = o.score - byPrior;
        for (const i of idx) {
          target[i] += r;
          for (const j of idx) set(ata, n, i, j, at(ata, n, i, j) + 1);
        }
      }

      let x: Float64Array;
      try {
        x = solveRidge(ata, n, target, lambda).x;
      } catch {
        // This λ cannot fit this fold at all; that is itself evidence against it.
        err = Number.POSITIVE_INFINITY;
        break;
      }

      for (let k = 0; k < m; k++) {
        if (k % folds !== f) continue;
        const o = observations[k]!;
        let pred = 0;
        for (const t of o.teams) {
          const i = index.get(t)!;
          pred += mu[i]! + x[i]!;
        }
        err += (o.score - pred) ** 2;
        counted++;
      }
    }

    const mse = counted > 0 ? err / counted : Number.POSITIVE_INFINITY;
    if (mse < bestErr) {
      bestErr = mse;
      best = lambda;
    }
  }
  return best;
}

/**
 * Flag estimates that should not be shown as numbers.
 *
 * A team with two alliance appearances has an estimate, and it means nothing.
 * Returning it alongside a well-measured one, formatted identically, is how a
 * picklist ends up ranking noise.
 */
export function underDetermined(fit: ContributionFit, minAppearances = 4): TeamContribution[] {
  return fit.contributions.filter((c) => c.appearances < minAppearances);
}
