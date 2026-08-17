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

export {
  allianceScore,
  rankPicklist,
  contingencies,
  formatPicklist,
  seededRng,
  PicklistError,
  type TeamEstimate,
  type ContentionModel,
  type PicklistOptions,
  type PicklistEntry,
  type Contingency,
  type Rng,
} from './picklist.ts';

export {
  blendWithOfficial,
  scoutReliability,
  cusumUpdate,
  describeDrift,
  BlendError,
  MIN_OBSERVATIONS_FOR_RELIABILITY,
  CUSUM_SLACK,
  CUSUM_THRESHOLD,
  type ScoutObservation,
  type BlendInput,
  type BlendResult,
  type ScoutResidual,
  type ScoutQuality,
  type CusumState,
} from './blend.ts';

export {
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
  DEFAULT_LABEL,
  MIN_TEAMS_FOR_STABLE_RANKING,
  type RankedTeam,
  type TruthEntry,
  type Prediction,
  type RegretOptions,
  type RegretResult,
  type EvaluationInput,
  type Evaluation,
} from './benchmark.ts';
