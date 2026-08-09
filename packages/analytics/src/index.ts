/**
 * @courier/analytics — team contribution estimates, with the uncertainty
 * attached rather than discarded.
 *
 * Works on any additive quantity, not just total score. Pass alliance sums of a
 * Season Pack field marked `additive` and component contributions fall out —
 * which is the direct payoff of the pack carrying additivity as data instead of
 * leaving each consumer to guess.
 */

export {
  fitContributions,
  chooseLambda,
  underDetermined,
  ContributionError,
  type AllianceObservation,
  type ContributionOptions,
  type ContributionFit,
  type TeamContribution,
} from './contribution.ts';

export {
  cholesky,
  choleskySolve,
  choleskyInverse,
  identity,
  matVec,
  traceProduct,
  LinalgError,
  type Matrix,
} from './linalg.ts';
