/**
 * Scoring a rating model on what a picklist actually needs.
 *
 * Every published FRC rating model is evaluated on match-prediction accuracy.
 * Statbotics' own methodology page measures predictive power, interpretability
 * and accessibility — no Spearman, no Kendall, no top-8 metric anywhere — and a
 * GitHub search for FRC rating-model benchmarking returns nothing at all.
 *
 * That gap matters because the two jobs are different. A model can predict match
 * outcomes well by getting the strong and weak halves of the field roughly
 * right, while ordering the top eight — the only ordering an alliance captain
 * uses — no better than chance. Optimising for the published metric does not
 * optimise for the decision anyone makes with it.
 *
 * So this scores ranking quality, and keeps the calibration metrics too, making
 * it a strict superset of the current standard rather than a rival to it.
 *
 * ── The label problem, stated up front ──────────────────────────────────────
 * Every metric here needs a ground truth: what a team was "really" worth. This
 * module uses post-hoc contribution computed over the full event. That is
 * defensible and it is not the only defensible choice, because alliance
 * selection encodes strategic FIT — defence, consistency, a specific mechanism
 * — and not just scoring output. A model that ranks purely by points will look
 * good here and still lose a captain their elimination series.
 *
 * The design flags this as unresolved. Nothing in this file pretends otherwise:
 * `evaluate` reports the label it used and says so in its caveats, and a second
 * label based on observed selection order would be a legitimate addition rather
 * than a correction.
 */

export class BenchmarkError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BenchmarkError';
  }
}

export interface RankedTeam {
  readonly team: number;
  /** Whatever the model predicts. Only the ORDER is used. */
  readonly predicted: number;
}

export interface TruthEntry {
  readonly team: number;
  /** Post-hoc contribution over the full event, in points. */
  readonly actual: number;
}

/* -------------------------------------------------------------------------- */
/* Rank correlation                                                           */
/* -------------------------------------------------------------------------- */

/** Ranks with ties averaged, which is what both correlations assume. */
export function rankValues(values: readonly number[]): number[] {
  const idx = values.map((v, i) => ({ v, i })).sort((a, b) => a.v - b.v);
  const ranks = new Array<number>(values.length);
  let i = 0;
  while (i < idx.length) {
    let j = i;
    while (j + 1 < idx.length && idx[j + 1]!.v === idx[i]!.v) j++;
    const shared = (i + j) / 2 + 1;
    for (let k = i; k <= j; k++) ranks[idx[k]!.i] = shared;
    i = j + 1;
  }
  return ranks;
}

/** Spearman rank correlation. 1 is a perfect ordering, 0 is chance, -1 inverted. */
export function spearman(predicted: readonly number[], actual: readonly number[]): number {
  if (predicted.length !== actual.length) {
    throw new BenchmarkError('predicted and actual must be the same length');
  }
  if (predicted.length < 2) return 0;
  return pearson(rankValues(predicted), rankValues(actual));
}

function pearson(x: readonly number[], y: readonly number[]): number {
  const n = x.length;
  const mx = x.reduce((s, v) => s + v, 0) / n;
  const my = y.reduce((s, v) => s + v, 0) / n;
  let num = 0;
  let dx = 0;
  let dy = 0;
  for (let i = 0; i < n; i++) {
    const a = x[i]! - mx;
    const b = y[i]! - my;
    num += a * b;
    dx += a * a;
    dy += b * b;
  }
  const den = Math.sqrt(dx * dy);
  // A constant prediction correlates with nothing. Zero is the honest answer;
  // NaN would propagate silently into a summary table.
  return den === 0 ? 0 : num / den;
}

/**
 * Kendall tau-b: the share of team pairs the model orders correctly, corrected
 * for ties.
 *
 * More interpretable than Spearman for this use — "how often does the model get
 * a head-to-head right" is a question a captain can act on — and less sensitive
 * to one badly misplaced team.
 */
export function kendallTau(predicted: readonly number[], actual: readonly number[]): number {
  if (predicted.length !== actual.length) {
    throw new BenchmarkError('predicted and actual must be the same length');
  }
  const n = predicted.length;
  if (n < 2) return 0;

  let concordant = 0;
  let discordant = 0;
  let tiedPredicted = 0;
  let tiedActual = 0;

  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const dp = Math.sign(predicted[i]! - predicted[j]!);
      const da = Math.sign(actual[i]! - actual[j]!);
      if (dp === 0 && da === 0) continue;
      if (dp === 0) tiedPredicted++;
      else if (da === 0) tiedActual++;
      else if (dp === da) concordant++;
      else discordant++;
    }
  }

  const den = Math.sqrt(
    (concordant + discordant + tiedPredicted) * (concordant + discordant + tiedActual),
  );
  return den === 0 ? 0 : (concordant - discordant) / den;
}

/* -------------------------------------------------------------------------- */
/* Top-of-list quality                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Normalised discounted cumulative gain over the top k.
 *
 * Weights the top of the list far more than the tail, which is the right shape:
 * a captain reads the first eight names and never looks at rank 40. Gain is the
 * team's actual contribution, so putting a genuinely strong team first is worth
 * more than putting a mediocre one there.
 */
export function ndcg(ranked: readonly RankedTeam[], truth: readonly TruthEntry[], k = 8): number {
  const actual = new Map(truth.map((t) => [t.team, t.actual]));
  const byPrediction = [...ranked].sort((a, b) => b.predicted - a.predicted);

  const gains = byPrediction.slice(0, k).map((r) => actual.get(r.team) ?? 0);
  const ideal = [...actual.values()].sort((a, b) => b - a).slice(0, k);

  const dcg = (xs: readonly number[]): number =>
    xs.reduce((s, g, i) => s + g / Math.log2(i + 2), 0);

  const best = dcg(ideal);
  return best === 0 ? 0 : dcg(gains) / best;
}

/* -------------------------------------------------------------------------- */
/* Captain regret — the headline                                              */
/* -------------------------------------------------------------------------- */

export interface RegretOptions {
  /** How many picks a captain makes. Two in a three-team alliance. */
  readonly picks?: number;
  /**
   * How many teams are taken by others between your picks.
   *
   * This is what makes regret a DRAFT metric rather than a sorting metric: a
   * model that ranks an unavailable team first has cost its captain nothing if
   * the second name is also good, and everything if it is not.
   */
  readonly picksBetween?: number;
}

export interface RegretResult {
  /** Points foregone versus an oracle who knew every team's true contribution. */
  readonly regret: number;
  /** What the model's list actually delivered. */
  readonly achieved: number;
  /** What the oracle would have delivered facing the same depletion. */
  readonly oracle: number;
  readonly picked: number[];
  readonly oraclePicked: number[];
}

/**
 * Points a captain gives up by drafting down this model's list.
 *
 * The metric the design calls the headline, and the one that most directly
 * answers "is this model any good for the job". Both the model and the oracle
 * face the same board depletion, so a model is not punished for ranking a team
 * that was never going to be available — only for the choice it made among
 * teams that were.
 *
 * Zero regret means the list was as good as knowing the future.
 */
export function captainRegret(
  ranked: readonly RankedTeam[],
  truth: readonly TruthEntry[],
  opts: RegretOptions = {},
): RegretResult {
  const picks = opts.picks ?? 2;
  const between = opts.picksBetween ?? 0;
  const actual = new Map(truth.map((t) => [t.team, t.actual]));

  if (ranked.length === 0) throw new BenchmarkError('no teams to rank');

  const byModel = [...ranked].sort((a, b) => b.predicted - a.predicted).map((r) => r.team);
  const byTruth = [...ranked]
    .sort((a, b) => (actual.get(b.team) ?? 0) - (actual.get(a.team) ?? 0))
    .map((r) => r.team);

  const draft = (order: readonly number[]): { taken: number[]; total: number } => {
    const gone = new Set<number>();
    const taken: number[] = [];
    for (let p = 0; p < picks; p++) {
      // Rivals remove the top of the TRUE ordering: the strongest available
      // teams go first regardless of whose list is being scored.
      if (p > 0) {
        let removed = 0;
        for (const t of byTruth) {
          if (removed >= between) break;
          if (gone.has(t)) continue;
          gone.add(t);
          removed++;
        }
      }
      const pick = order.find((t) => !gone.has(t));
      if (pick === undefined) break;
      gone.add(pick);
      taken.push(pick);
    }
    return { taken, total: taken.reduce((s, t) => s + (actual.get(t) ?? 0), 0) };
  };

  const model = draft(byModel);
  const oracle = draft(byTruth);

  return {
    regret: Math.max(0, oracle.total - model.total),
    achieved: model.total,
    oracle: oracle.total,
    picked: model.taken,
    oraclePicked: oracle.taken,
  };
}

/* -------------------------------------------------------------------------- */
/* Calibration, kept so this is a superset                                    */
/* -------------------------------------------------------------------------- */

export interface Prediction {
  /** Model's probability that the first side wins. */
  readonly probability: number;
  readonly won: boolean;
}

function checkProbability(p: number): void {
  if (!Number.isFinite(p) || p < 0 || p > 1) {
    throw new BenchmarkError(`probability ${p} is outside [0, 1]`);
  }
}

/** Mean squared error of a probability forecast. Lower is better; 0.25 is a coin flip. */
export function brierScore(predictions: readonly Prediction[]): number {
  if (predictions.length === 0) throw new BenchmarkError('no predictions to score');
  let s = 0;
  for (const p of predictions) {
    checkProbability(p.probability);
    s += (p.probability - (p.won ? 1 : 0)) ** 2;
  }
  return s / predictions.length;
}

/** Log loss. Punishes confident mistakes far harder than Brier does. */
export function logLoss(predictions: readonly Prediction[], epsilon = 1e-15): number {
  if (predictions.length === 0) throw new BenchmarkError('no predictions to score');
  let s = 0;
  for (const p of predictions) {
    checkProbability(p.probability);
    const q = Math.min(1 - epsilon, Math.max(epsilon, p.probability));
    s += p.won ? -Math.log(q) : -Math.log(1 - q);
  }
  return s / predictions.length;
}

/**
 * Share of matches called correctly.
 *
 * A 0.5 forecast is not a call, so it counts as a miss rather than a coin-flip
 * win. Crediting half of them would let a model that predicts nothing score 50%.
 */
export function accuracy(predictions: readonly Prediction[]): number {
  if (predictions.length === 0) throw new BenchmarkError('no predictions to score');
  let right = 0;
  for (const p of predictions) {
    checkProbability(p.probability);
    if (p.probability === 0.5) continue;
    if (p.probability > 0.5 === p.won) right++;
  }
  return right / predictions.length;
}

/* -------------------------------------------------------------------------- */
/* The report                                                                 */
/* -------------------------------------------------------------------------- */

export interface EvaluationInput {
  readonly modelName: string;
  readonly ranked: readonly RankedTeam[];
  readonly truth: readonly TruthEntry[];
  readonly predictions?: readonly Prediction[];
  readonly regret?: RegretOptions;
  readonly ndcgK?: number;
}

export interface Evaluation {
  readonly modelName: string;
  readonly teams: number;
  readonly spearman: number;
  readonly kendall: number;
  readonly ndcg: number;
  readonly ndcgK: number;
  readonly regret: RegretResult;
  readonly brier?: number;
  readonly logLoss?: number;
  readonly accuracy?: number;
  /** What "actual" meant. Never left implicit. */
  readonly label: string;
  readonly caveats: string[];
}

export const DEFAULT_LABEL = 'post-hoc contribution over the full event, in points';

/** Below this many teams, rank correlations are dominated by a couple of placements. */
export const MIN_TEAMS_FOR_STABLE_RANKING = 12;

export function evaluate(input: EvaluationInput): Evaluation {
  if (input.ranked.length === 0) throw new BenchmarkError('no ranked teams');

  const truthTeams = new Set(input.truth.map((t) => t.team));
  const paired = input.ranked.filter((r) => truthTeams.has(r.team));
  if (paired.length === 0) {
    throw new BenchmarkError('no ranked team appears in the ground truth');
  }

  const actualByTeam = new Map(input.truth.map((t) => [t.team, t.actual]));
  const predicted = paired.map((r) => r.predicted);
  const actual = paired.map((r) => actualByTeam.get(r.team)!);
  const missing = input.ranked.length - paired.length;
  const k = input.ndcgK ?? 8;

  const caveats: string[] = [];
  if (missing > 0) {
    caveats.push(
      `${missing} ranked team(s) had no ground truth and were excluded. A model is neither ` +
        'credited nor penalised for them.',
    );
  }
  if (paired.length < MIN_TEAMS_FOR_STABLE_RANKING) {
    caveats.push(
      `Only ${paired.length} teams were scored. Rank correlations over a field this small are ` +
        'dominated by a couple of placements and should not be compared against a full event.',
    );
  }
  caveats.push(
    'Ranking quality here measures scoring output. Alliance selection also encodes strategic ' +
      'fit — defence, consistency, a specific mechanism — which no metric in this report sees.',
  );

  return {
    modelName: input.modelName,
    teams: paired.length,
    spearman: spearman(predicted, actual),
    kendall: kendallTau(predicted, actual),
    ndcg: ndcg(paired, input.truth, k),
    ndcgK: k,
    regret: captainRegret(paired, input.truth, input.regret),
    ...(input.predictions?.length
      ? {
          brier: brierScore(input.predictions),
          logLoss: logLoss(input.predictions),
          accuracy: accuracy(input.predictions),
        }
      : {}),
    label: DEFAULT_LABEL,
    caveats,
  };
}

/** A comparison table. Ranking metrics first, because that is the point. */
export function formatEvaluations(evaluations: readonly Evaluation[]): string {
  if (evaluations.length === 0) return 'No models evaluated.';
  const lines = [
    'model                  spearman  kendall   ndcg@k   regret   brier   acc',
    '---------------------  --------  -------  -------  -------  ------  ----',
  ];
  for (const e of evaluations) {
    lines.push(
      [
        e.modelName.slice(0, 21).padEnd(21),
        e.spearman.toFixed(3).padStart(8),
        e.kendall.toFixed(3).padStart(7),
        e.ndcg.toFixed(3).padStart(7),
        e.regret.regret.toFixed(1).padStart(7),
        (e.brier !== undefined ? e.brier.toFixed(3) : '-').padStart(6),
        (e.accuracy !== undefined ? `${(e.accuracy * 100).toFixed(0)}%` : '-').padStart(4),
      ].join('  '),
    );
  }
  lines.push('');
  lines.push(`ground truth: ${evaluations[0]!.label}`);
  lines.push('regret = points a captain gives up by drafting down this list. Lower is better.');
  lines.push('brier and accuracy are match prediction, kept so this is a superset of the usual');
  lines.push('evaluation rather than a rival to it.');
  return lines.join('\n');
}
