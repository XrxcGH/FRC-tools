/**
 * Turning decoded records into what the analytics layer consumes.
 *
 * This is the last stretch of the seam: `@courier/analytics` takes alliance
 * observations and per-robot scout observations, and until now nothing produced
 * them from actual scouting data.
 */

import type { DecodedRecord } from './registry.ts';
import type { BodySchema } from './schema.ts';

export interface AllianceObservationLike {
  readonly teams: number[];
  readonly score: number;
}

export interface ScoutObservationLike {
  readonly robot: number;
  readonly value: number;
  readonly scout: string;
}

/**
 * Per-robot scout observations for one alliance in one match.
 *
 * `alliance` fixes the robot ordering, so index 0 is always the same team for
 * every scout who watched that match. Getting this wrong would attribute one
 * robot's counts to another, and the constrained blend would then reconcile
 * confidently wrong numbers against a correct total.
 *
 * Records for teams outside the alliance are ignored rather than guessed at.
 */
export function toScoutObservations(
  records: readonly DecodedRecord[],
  alliance: readonly number[],
  field: string,
): ScoutObservationLike[] {
  const index = new Map(alliance.map((t, i) => [t, i]));
  const out: ScoutObservationLike[] = [];

  for (const r of records) {
    const robot = index.get(r.team);
    if (robot === undefined) continue;
    const v = r.values[field];
    if (typeof v === 'number') {
      out.push({ robot, value: v, scout: r.scout });
    } else if (typeof v === 'boolean') {
      // A boolean is a legitimate additive quantity — "did it climb" summed
      // across an alliance is a count of climbs.
      out.push({ robot, value: v ? 1 : 0, scout: r.scout });
    }
    // A string or a missing field contributes nothing. Coercing an enum to a
    // number here would invent an ordering the team never declared.
  }
  return out;
}

/**
 * Alliance-level observations, for fitting contributions across a whole event.
 *
 * Built only from matches where EVERY robot on the alliance was scouted. A
 * partial alliance total is not a smaller observation, it is a wrong one: the
 * least-squares fit would attribute the missing robot's output to the two that
 * were watched.
 */
export function toAllianceObservations(
  records: readonly DecodedRecord[],
  alliances: readonly { match: number; teams: number[] }[],
  field: string,
): AllianceObservationLike[] {
  const byMatch = new Map<number, DecodedRecord[]>();
  for (const r of records) {
    const list = byMatch.get(r.match) ?? [];
    list.push(r);
    byMatch.set(r.match, list);
  }

  const out: AllianceObservationLike[] = [];
  for (const a of alliances) {
    const inMatch = byMatch.get(a.match) ?? [];
    let total = 0;
    let covered = 0;

    for (const team of a.teams) {
      // One scout per robot: if a robot was double-scouted, average them rather
      // than counting it twice.
      const forTeam = inMatch.filter((r) => r.team === team);
      const values = forTeam
        .map((r) => r.values[field])
        .filter((v): v is number | boolean => typeof v === 'number' || typeof v === 'boolean')
        .map((v) => (typeof v === 'boolean' ? (v ? 1 : 0) : v));
      if (values.length === 0) continue;
      total += values.reduce((s, v) => s + v, 0) / values.length;
      covered++;
    }

    if (covered === a.teams.length && a.teams.length > 0) {
      out.push({ teams: [...a.teams], score: total });
    }
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/* Schemas for the Bridge's own generic profiles                              */
/* -------------------------------------------------------------------------- */

/**
 * Decoders for the profiles this project ships itself.
 *
 * Only these, deliberately. A decoder for someone else's app would be a guess
 * about a format that varies per deployment — the same reason the Bridge ships
 * its app-specific profiles as unverified examples rather than active. A team
 * writes their own, for their own format, and it stays on their device.
 *
 * The column layout matches `courier.generic.tsv.v1`: scout, match, team, then
 * whatever the team decided to record. Everything past column 2 is theirs, so
 * these name the columns generically and a real team would replace them.
 */
export const BridgeSchemas: Readonly<Record<string, BodySchema>> = {
  'courier.generic.tsv.v1': {
    schemaId: 'courier.generic.tsv.v1',
    format: 'delimited',
    delimiter: '\t',
    fields: [
      { name: 'auto', type: 'integer', source: 3, min: 0, max: 200 },
      { name: 'teleop', type: 'integer', source: 4, min: 0, max: 500 },
      { name: 'endgame', type: 'string', source: 5 },
    ],
  },
  'courier.generic.json.v1': {
    schemaId: 'courier.generic.json.v1',
    format: 'json',
    fields: [
      { name: 'auto', type: 'integer', source: 'auto', min: 0, max: 200 },
      { name: 'teleop', type: 'integer', source: 'teleop', min: 0, max: 500 },
      { name: 'endgame', type: 'string', source: 'endgame' },
    ],
  },
} as const;

/* -------------------------------------------------------------------------- */
/* Per-team estimates straight from scouting                                  */
/* -------------------------------------------------------------------------- */

export interface TeamEstimateLike {
  readonly team: number;
  readonly mean: number;
  /** Standard error of the mean: how unsure we are of their average. */
  readonly sigma: number;
  /**
   * Match-to-match standard deviation: how much the robot itself varies.
   *
   * Carried separately because the picklist's floor needs THIS, not sigma. A
   * floor built from the standard error claims a coin-flip robot gets steadier
   * the more you scout it.
   */
  readonly spread: number;
  readonly observations: number;
}

export interface TeamEstimateOptions {
  /** Below this many observations a team is omitted rather than estimated. */
  readonly minObservations?: number;
}

export const DEFAULT_MIN_OBSERVATIONS = 3;

export interface TeamEstimateResult {
  readonly estimates: TeamEstimateLike[];
  /** Teams seen but omitted for too few observations, with their counts. */
  readonly thin: Array<{ team: number; observations: number }>;
}

/**
 * Mean and uncertainty per team, directly from scouting.
 *
 * No least squares here, and that is the point rather than a shortcut. OPR and
 * its relatives exist because the OFFICIAL record is alliance-level: you can
 * only see three robots' combined output and have to solve for the parts.
 * Scouting data is already per-robot, so the deconvolution is unnecessary — and
 * a mean is both more accurate and vastly more explainable to the student who
 * has to defend the picklist in a meeting.
 *
 * Sigma is the standard error of the mean, shrunk toward the pool spread when a
 * team has few observations. Without shrinkage, a team scouted three times who
 * happened to score the same number each time would report sigma ≈ 0 and sail
 * to the top of a floor-sorted list on the strength of a coincidence.
 */
export function teamEstimatesFrom(
  records: readonly DecodedRecord[],
  field: string,
  opts: TeamEstimateOptions = {},
): TeamEstimateResult {
  const minObs = opts.minObservations ?? DEFAULT_MIN_OBSERVATIONS;
  const byTeam = new Map<number, number[]>();

  for (const r of records) {
    const v = r.values[field];
    const n = typeof v === 'boolean' ? (v ? 1 : 0) : typeof v === 'number' ? v : undefined;
    if (n === undefined) continue;
    const list = byTeam.get(r.team) ?? [];
    list.push(n);
    byTeam.set(r.team, list);
  }

  const all = [...byTeam.values()].flat();
  const poolSd = all.length > 1 ? Math.sqrt(sampleVariance(all)) : 1;

  const estimates: TeamEstimateLike[] = [];
  const thin: Array<{ team: number; observations: number }> = [];

  for (const [team, xs] of byTeam) {
    if (xs.length < minObs) {
      thin.push({ team, observations: xs.length });
      continue;
    }
    const n = xs.length;
    const mean = xs.reduce((a, b) => a + b, 0) / n;
    const ownSd = Math.sqrt(sampleVariance(xs));
    // Partial pooling on the spread, weight n/(n+k) with k = minObs.
    const w = n / (n + minObs);
    const sd = w * ownSd + (1 - w) * poolSd;
    estimates.push({
      team,
      mean,
      sigma: Math.max(sd / Math.sqrt(n), 1e-6),
      // `sd` is already the shrunk match-to-match spread; it was only ever
      // divided by sqrt(n) on the way into sigma.
      spread: sd,
      observations: n,
    });
  }

  estimates.sort((a, b) => b.mean - a.mean);
  thin.sort((a, b) => a.team - b.team);
  return { estimates, thin };
}

function sampleVariance(xs: readonly number[]): number {
  if (xs.length < 2) return 0;
  const m = xs.reduce((a, b) => a + b, 0) / xs.length;
  return xs.reduce((a, x) => a + (x - m) ** 2, 0) / (xs.length - 1);
}
