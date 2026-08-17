/**
 * Alliance selection.
 *
 * The design's point, and the reason this is not a sort: **the board depletes.**
 * Every shipped picklist tool ranks teams by rating and hands you a list, which
 * silently assumes your second pick is still available when your turn comes
 * round. It usually is not. A team ranked fourth that seven other captains also
 * want is worth less to you than a team ranked sixth that nobody else has
 * noticed, and no amount of sorting expresses that.
 *
 * So selection is modelled as a draft: simulate what the other captains plausibly
 * do, and score each candidate by what your alliance is worth *after* the picks
 * that follow. That is one-ply lookahead, not game theory — see the note on
 * `pickOrder` for why deeper search is not worth it here.
 *
 * ── Two stages, deliberately separate ───────────────────────────────────────
 * Valuation (what is a robot worth) comes from `blendWithOfficial` and
 * `fitContributions`. Selection (who to take) is this file. Keeping them apart
 * matters because valuation is a measurement problem and selection is a
 * decision problem, and conflating them is how a tool ends up unable to answer
 * "why is this team ranked here".
 */

export class PicklistError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PicklistError';
  }
}

export interface TeamEstimate {
  readonly team: number;
  /** Posterior mean contribution, in this season's units. */
  readonly mean: number;
  /** Posterior standard deviation. Not optional — a floor needs it. */
  readonly sigma: number;
  /**
   * Share of this team's contribution that competes for a shared resource.
   *
   * When several robots on one alliance draw from the same supply of game
   * pieces, their contributions do not simply add. Leave it 0 for a game where
   * they do.
   */
  readonly sharedShare?: number;
}

export interface ContentionModel {
  /**
   * Alliance capacity for the shared resource, in the same units as `mean`.
   * Contributions above this are discounted.
   */
  readonly capacity: number;
  /** How steeply the excess is discounted. 0 disables. 1 discards it entirely. */
  readonly gamma: number;
}

/**
 * What an alliance is worth.
 *
 * Additive, minus a contention penalty when the members' shared-resource demand
 * exceeds what the field can supply. Three robots that each score 40 by
 * monopolising the same feeder do not make a 120-point alliance, and a picklist
 * that assumes they do will build one.
 *
 * The contention parameters are fitted per season from observed alliance scores
 * against summed per-robot posteriors; they are NOT known a priori and this
 * function does not invent them. With no model supplied the score is plainly
 * additive, which is the honest default.
 */
export function allianceScore(
  members: readonly TeamEstimate[],
  contention?: ContentionModel,
): number {
  const total = members.reduce((a, m) => a + m.mean, 0);
  if (!contention || contention.gamma === 0) return total;

  const shared = members.reduce((a, m) => a + (m.sharedShare ?? 0), 0);
  const excess = Math.max(0, shared - contention.capacity);
  return total - contention.gamma * excess;
}

/* -------------------------------------------------------------------------- */
/* Randomness                                                                  */
/* -------------------------------------------------------------------------- */

export type Rng = () => number;

/** Deterministic RNG, so a picklist is reproducible and a test is not flaky. */
export function seededRng(seed: number): Rng {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s >>>= 0;
    s ^= s >> 17;
    s ^= s << 5;
    s >>>= 0;
    return s / 0x100000000;
  };
}

/** Box-Muller. One draw per call; the second is discarded for simplicity. */
function gaussian(rng: Rng): number {
  let u = 0;
  while (u === 0) u = rng();
  const v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/* -------------------------------------------------------------------------- */
/* The draft                                                                   */
/* -------------------------------------------------------------------------- */

export interface PicklistOptions {
  /** Teams still on the board, with their posteriors. */
  readonly candidates: readonly TeamEstimate[];
  /** Who is already on your alliance, including the captain. */
  readonly alliance: readonly TeamEstimate[];
  /**
   * How many picks other captains make before your next turn.
   *
   * In a serpentine draft this is what makes the board deplete. Zero means you
   * are picking last and the board is static, in which case this degenerates to
   * a sort — correctly.
   */
  readonly picksBeforeYourNext: number;
  /** Do you get another pick after those? Affects whether depth matters. */
  readonly haveSecondPick: boolean;
  readonly contention?: ContentionModel;
  /**
   * How closely other captains follow public ratings. 0 = perfectly, higher =
   * noisier.
   *
   * Fitted from historical selection order in principle; 1.0 is a placeholder
   * and is NOT a measured value. It matters: at 0 the model assumes rivals take
   * exactly the top of the public list, which overstates how predictable they
   * are and makes contested teams look cheaper than they are.
   *
   * Calibrate it against the spread of your board, not in the abstract. On a
   * board where consecutive teams differ by 4 points, a noise of 1 makes rival
   * order almost deterministic — availability risk comes out as 0 or 1 with
   * almost nothing between, which is very unlikely to match how eight captains
   * with their own scouting data actually behave. If every risk figure reads 0%
   * or 100%, this number is too low for that board.
   */
  readonly rivalNoise?: number;
  /** Teams you will not take, whatever the numbers say. */
  readonly exclude?: readonly number[];
  readonly simulations?: number;
  readonly rng?: Rng;
}

export interface PicklistEntry {
  readonly team: number;
  /** Expected alliance score if you take this team now. */
  readonly expectedValue: number;
  /** Probability this team is gone before your next pick. */
  readonly availabilityRisk: number;
  /**
   * 20th percentile of this team's own contribution — its floor.
   *
   * Second-pick decisions are floor-driven, and the research found that no
   * shipped tool exposes a floor at all: they all show a point estimate and
   * hide the spread that matters most when you cannot afford a dud.
   */
  readonly floor: number;
  readonly ceiling: number;
}

const DEFAULT_SIMULATIONS = 4000;
const DEFAULT_RIVAL_NOISE = 1;

/**
 * Rank the board by expected alliance value, accounting for depletion.
 *
 * Each simulation draws every team's true contribution from its posterior,
 * simulates the rival picks that happen before your next turn, and evaluates
 * what your alliance is worth if you take each candidate now and the best
 * remaining option later.
 */
export function rankPicklist(opts: PicklistOptions): PicklistEntry[] {
  const excluded = new Set(opts.exclude ?? []);
  const board = opts.candidates.filter((c) => !excluded.has(c.team));
  if (board.length === 0) throw new PicklistError('no candidates left on the board');
  for (const c of board) {
    if (!Number.isFinite(c.mean) || !Number.isFinite(c.sigma) || c.sigma < 0) {
      throw new PicklistError(`team ${c.team} has a malformed estimate`);
    }
  }
  if (opts.picksBeforeYourNext < 0) {
    throw new PicklistError('picksBeforeYourNext cannot be negative');
  }

  const rng = opts.rng ?? seededRng(1);
  const sims = opts.simulations ?? DEFAULT_SIMULATIONS;
  const noise = opts.rivalNoise ?? DEFAULT_RIVAL_NOISE;

  const value = new Map<number, number>();
  const samples = new Map<number, number[]>();
  for (const c of board) {
    value.set(c.team, 0);
    samples.set(c.team, []);
  }

  for (let s = 0; s < sims; s++) {
    // One joint draw of everyone's true contribution this simulation.
    const drawn = new Map<number, TeamEstimate>();
    for (const c of board) {
      const v = c.mean + c.sigma * gaussian(rng);
      drawn.set(c.team, { ...c, mean: v });
      samples.get(c.team)!.push(v);
    }

    // Rivals pick by public rating plus noise. Their ordering is a model, not
    // an observation: they see different data and have their own opinions.
    const rivalOrder = [...board]
      .map((c) => ({ team: c.team, score: c.mean + noise * gaussian(rng) }))
      .sort((a, b) => b.score - a.score)
      .map((x) => x.team);

    for (const c of board) {
      // Take c now. Rivals then pick from what is left.
      const takenByRivals = new Set<number>([c.team]);
      for (const t of rivalOrder) {
        if (takenByRivals.size - 1 >= opts.picksBeforeYourNext) break;
        if (t === c.team) continue;
        takenByRivals.add(t);
      }

      const withPick = [...opts.alliance, drawn.get(c.team)!];

      let best = allianceScore(withPick, opts.contention);
      if (opts.haveSecondPick) {
        // One-ply: the best still-available team, valued at this draw.
        let bestSecond = -Infinity;
        for (const d of board) {
          if (takenByRivals.has(d.team)) continue;
          const score = allianceScore([...withPick, drawn.get(d.team)!], opts.contention);
          if (score > bestSecond) bestSecond = score;
        }
        if (bestSecond > -Infinity) best = bestSecond;
      }
      value.set(c.team, value.get(c.team)! + best);
    }
  }

  return board
    .map((c) => {
      const xs = samples.get(c.team)!.slice().sort((a, b) => a - b);
      return {
        team: c.team,
        expectedValue: value.get(c.team)! / sims,
        availabilityRisk: riskOfLoss(c, board, opts, rng, sims),
        floor: percentile(xs, 0.2),
        ceiling: percentile(xs, 0.8),
      };
    })
    .sort((a, b) => b.expectedValue - a.expectedValue);
}

/** Probability a team is taken before your next pick, if you pass on them now. */
function riskOfLoss(
  team: TeamEstimate,
  board: readonly TeamEstimate[],
  opts: PicklistOptions,
  rng: Rng,
  sims: number,
): number {
  if (opts.picksBeforeYourNext === 0) return 0;
  const noise = opts.rivalNoise ?? DEFAULT_RIVAL_NOISE;
  let lost = 0;
  const trials = Math.max(200, Math.floor(sims / 4));
  for (let s = 0; s < trials; s++) {
    const order = board
      .map((c) => ({ team: c.team, score: c.mean + noise * gaussian(rng) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, opts.picksBeforeYourNext)
      .map((x) => x.team);
    if (order.includes(team.team)) lost++;
  }
  return lost / trials;
}

function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return 0;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.floor(p * (sorted.length - 1))));
  return sorted[i]!;
}

/* -------------------------------------------------------------------------- */
/* Contingencies                                                              */
/* -------------------------------------------------------------------------- */

export interface Contingency {
  /** Teams assumed already taken when your turn arrives. */
  readonly goneTeams: number[];
  /** Who to take instead. */
  readonly take: number;
}

/**
 * What to do when the top of the list is gone.
 *
 * A picklist is used in a room with no internet, by a student reading from
 * paper, under time pressure, while an announcer waits. "Take the highest name
 * not crossed off" is the operation it must support, so the contingencies are
 * precomputed rather than recomputed live.
 */
export function contingencies(
  ranked: readonly PicklistEntry[],
  depth = 5,
): Contingency[] {
  const out: Contingency[] = [];
  for (let n = 1; n <= Math.min(depth, Math.max(0, ranked.length - 1)); n++) {
    out.push({
      goneTeams: ranked.slice(0, n).map((r) => r.team),
      take: ranked[n]!.team,
    });
  }
  return out;
}

/** A picklist as printable text, because it is read off paper in the stands. */
export function formatPicklist(ranked: readonly PicklistEntry[], limit = 20): string {
  const rows = ranked.slice(0, limit);
  const lines = ['  #  team    value   floor  ceiling   risk'];
  rows.forEach((r, i) => {
    lines.push(
      `${String(i + 1).padStart(3)}  ${String(r.team).padStart(5)}  ` +
        `${r.expectedValue.toFixed(1).padStart(6)}  ${r.floor.toFixed(1).padStart(5)}  ` +
        `${r.ceiling.toFixed(1).padStart(7)}  ${(r.availabilityRisk * 100).toFixed(0).padStart(4)}%`,
    );
  });
  lines.push('');
  lines.push('risk = chance this team is gone before your next pick.');
  lines.push('floor = 20th percentile of their contribution; what you get on a bad day.');
  return lines.join('\n');
}
