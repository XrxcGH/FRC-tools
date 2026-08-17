/**
 * Scout reliability without an official score to check against.
 *
 * `@courier/analytics` can already turn residuals into per-scout bias and
 * precision, and CUSUM can already catch a scout drifting. Neither had a way to
 * produce residuals from a team's own data, so both were reachable only with a
 * venue pack and an official total — which is exactly the wrong time. A scout
 * who has stopped watching should be found on Saturday morning, in the stands,
 * with no network, not on Sunday from a downloaded results file.
 *
 * ── The reference ───────────────────────────────────────────────────────────
 * A residual needs something to be a residual FROM. With no official score the
 * only reference available offline is the other scouts who watched the same
 * robot in the same match, so that is what this uses: leave-one-out peer
 * consensus, within one (event, match, team).
 *
 * Leave-one-out matters. Comparing a scout against a mean that includes their
 * own number shrinks every residual by a factor of 1/n and makes everybody look
 * better the fewer people are watching.
 *
 * ── What this therefore does NOT measure ────────────────────────────────────
 * It measures DISAGREEMENT WITH PEERS, not accuracy. Two scouts who both watch
 * the wrong robot agree perfectly and both score as reliable. A single careful
 * scout on a robot nobody else covered produces no residual at all and is
 * invisible here. Every caller has to say this out loud, because "reliability"
 * reads as "correctness" and a student handed this table will act on it.
 *
 * The honest alternative — comparing a scout to that team's own average across
 * matches — is worse: it flags whoever happened to watch the robot on its bad
 * match, which is a scout doing their job correctly.
 */

import type { DecodedRecord } from './registry.ts';

export interface PeerResidual {
  readonly scout: string;
  readonly team: number;
  readonly match: number;
  readonly value: number;
  /** Mean of the OTHER scouts on this robot in this match. */
  readonly peerMean: number;
  /** Who those others were. Needed to tell a drifting scout from their partner. */
  readonly peerScouts: string[];
  /** value - peerMean. */
  readonly residual: number;
  readonly peers: number;
}

export interface ResidualReport {
  readonly residuals: PeerResidual[];
  /** Observations with a readable value but nobody else watching the same robot. */
  readonly unpaired: number;
  /** Distinct (match, team) pairs that had two or more scouts. */
  readonly doubleScouted: number;
  /** Distinct (match, team) pairs seen at all. */
  readonly observations: number;
}

const key = (eventKey: string, match: number, team: number): string =>
  `${eventKey}/${match}/${team}`;

function numeric(v: number | boolean | string | undefined): number | undefined {
  if (typeof v === 'number') return v;
  if (typeof v === 'boolean') return v ? 1 : 0;
  return undefined;
}

/**
 * Residuals against peer consensus, one per scouted observation that had a peer.
 *
 * Records must already be the CURRENT view — a superseded revision and its
 * correction would otherwise appear as two scouts disagreeing with themselves.
 */
export function peerResiduals(records: readonly DecodedRecord[], field: string): ResidualReport {
  const groups = new Map<string, Array<{ scout: string; team: number; match: number; value: number }>>();
  const allObservations = new Set<string>();

  for (const r of records) {
    allObservations.add(key(r.eventKey, r.match, r.team));
    const v = numeric(r.values[field]);
    if (v === undefined) continue;
    const k = key(r.eventKey, r.match, r.team);
    const list = groups.get(k) ?? [];
    list.push({ scout: r.scout, team: r.team, match: r.match, value: v });
    groups.set(k, list);
  }

  const residuals: PeerResidual[] = [];
  let unpaired = 0;
  let doubleScouted = 0;

  for (const k of [...groups.keys()].sort()) {
    const rows = groups.get(k)!;

    // One entry per scout. Two records from the same scout on the same robot
    // are not two opinions; without this a scout could be their own peer.
    const byScout = new Map<string, number[]>();
    for (const row of rows) {
      const list = byScout.get(row.scout) ?? [];
      list.push(row.value);
      byScout.set(row.scout, list);
    }
    const collapsed = [...byScout.entries()].map(([scout, xs]) => ({
      scout,
      value: xs.reduce((a, b) => a + b, 0) / xs.length,
    }));

    if (collapsed.length < 2) {
      unpaired += collapsed.length;
      continue;
    }
    doubleScouted++;

    const total = collapsed.reduce((a, x) => a + x.value, 0);
    for (const x of collapsed) {
      const peerMean = (total - x.value) / (collapsed.length - 1);
      residuals.push({
        scout: x.scout,
        peerScouts: collapsed.filter((y) => y.scout !== x.scout).map((y) => y.scout),
        team: rows[0]!.team,
        match: rows[0]!.match,
        value: x.value,
        peerMean,
        residual: x.value - peerMean,
        peers: collapsed.length - 1,
      });
    }
  }

  // Stable order: by match, then team, then scout. CUSUM walks this sequence
  // and an unstable order would give two devices different alarms.
  residuals.sort(
    (a, b) => a.match - b.match || a.team - b.team || (a.scout < b.scout ? -1 : a.scout > b.scout ? 1 : 0),
  );

  return { residuals, unpaired, doubleScouted, observations: allObservations.size };
}

/**
 * The scale to standardise residuals by, before CUSUM.
 *
 * The POOL spread, not each scout's own. A scout who is drifting has a growing
 * residual spread, so dividing by their own standard deviation shrinks exactly
 * the signal the detector exists to find — the worse they get, the more normal
 * they look. The pool is what "one sigma of normal disagreement at this event"
 * means, and that is the right unit.
 */
export function residualScale(residuals: readonly PeerResidual[]): number {
  if (residuals.length < 2) return 1;
  const xs = residuals.map((r) => r.residual);
  const m = xs.reduce((a, b) => a + b, 0) / xs.length;
  const v = xs.reduce((a, x) => a + (x - m) ** 2, 0) / (xs.length - 1);
  const sd = Math.sqrt(v);
  // A pool with no spread at all means every scout agrees exactly, which is
  // either a tiny sample or a field where the quantity is trivially countable.
  // Either way there is no drift to detect, and 1 keeps the arithmetic finite.
  return sd > 1e-9 ? sd : 1;
}
