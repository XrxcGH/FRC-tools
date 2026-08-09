/**
 * Reconciling the two official sources.
 *
 * The Blue Alliance and the FIRST Events API both describe the same matches,
 * and they are not always the same. TBA is downstream of the same FMS upload
 * and adds a transform step, so a persistent divergence is usually a TBA bug —
 * and finding those is one of the few genuinely useful things a second source
 * buys you.
 *
 * ── The rule that matters ───────────────────────────────────────────────────
 * Disagreements are RECORDED, never silently resolved. A reconciler that picks
 * a winner and moves on produces confident output with no way to tell that
 * anything was ever in doubt, which is worse than either source alone: at least
 * one source is honestly one source.
 *
 * Precedence, when a value must be chosen for display:
 *   identity (which teams were in a match) → TBA, whose key space is canonical
 *   official scores                        → FIRST, which is closer to FMS
 *
 * Both are recorded either way.
 *
 * ── A limitation stated up front ────────────────────────────────────────────
 * FIRST's `tournamentLevel` does not carry the set number that TBA's comp level
 * does — a playoff match is just "Playoff" — so elimination matches cannot be
 * aligned between the two sources without guessing. They are therefore reported
 * as unreconcilable rather than matched up hopefully. Qualification matches,
 * which are what a picklist is built from, align exactly.
 */

import { unpackMatch, matchLabel } from '@courier/core';
import type { MatchEntry, TeamEntry } from './venue-pack.ts';

export type Source = 'tba' | 'first';

export type ConflictKind =
  | 'missing-from-source'
  | 'roster-mismatch'
  | 'score-mismatch'
  | 'result-presence-mismatch'
  | 'unreconcilable-level';

export interface Conflict {
  readonly kind: ConflictKind;
  readonly match: number;
  readonly label: string;
  readonly tba?: string;
  readonly first?: string;
  /** Which source was preferred for display, or null when nothing was chosen. */
  readonly preferred: Source | null;
  readonly note: string;
}

export interface ReconcileInput {
  readonly eventKey: string;
  readonly tbaTeams: readonly TeamEntry[];
  readonly tbaMatches: readonly MatchEntry[];
  readonly firstTeams: readonly TeamEntry[];
  readonly firstMatches: readonly MatchEntry[];
}

export interface ReconcileOutput {
  readonly eventKey: string;
  readonly teams: TeamEntry[];
  readonly matches: MatchEntry[];
  readonly conflicts: Conflict[];
  /** True when the two sources agreed on everything comparable. */
  readonly clean: boolean;
}

const sameNumbers = (a: readonly number[], b: readonly number[]): boolean =>
  a.length === b.length && [...a].sort((x, y) => x - y).every((v, i) => v === [...b].sort((x, y) => x - y)[i]);

const roster = (m: MatchEntry): string => `red ${m.red.join('/')} vs blue ${m.blue.join('/')}`;
const score = (m: MatchEntry): string =>
  m.redScore === undefined ? 'no result' : `${m.redScore}-${m.blueScore}`;

export function reconcileSnapshots(input: ReconcileInput): ReconcileOutput {
  const conflicts: Conflict[] = [];

  /* -------------------------------------------------------------- teams --- */
  // TBA's nicknames are community-maintained and generally richer, so they win
  // for display. A team present in only one source is still included: dropping
  // it would silently shrink the event.
  const teamMap = new Map<number, TeamEntry>();
  for (const t of input.firstTeams) teamMap.set(t.team, t);
  for (const t of input.tbaTeams) teamMap.set(t.team, t);
  const teams = [...teamMap.values()].sort((a, b) => a.team - b.team);

  /* ------------------------------------------------------------ matches --- */
  const tbaByMatch = new Map(input.tbaMatches.map((m) => [m.match, m]));
  const firstByMatch = new Map(input.firstMatches.map((m) => [m.match, m]));
  const allIds = [...new Set([...tbaByMatch.keys(), ...firstByMatch.keys()])].sort((a, b) => a - b);

  const matches: MatchEntry[] = [];

  for (const id of allIds) {
    const label = matchLabel(id);
    const t = tbaByMatch.get(id);
    const f = firstByMatch.get(id);
    const isQual = unpackMatch(id).level === 'qm';

    if (!isQual) {
      // Elimination alignment is not possible without guessing at set numbers.
      // Take TBA, which carries the set, and say plainly that it was not checked.
      const chosen = t ?? f!;
      matches.push(chosen);
      conflicts.push({
        kind: 'unreconcilable-level',
        match: id,
        label,
        ...(t ? { tba: roster(t) } : {}),
        ...(f ? { first: roster(f) } : {}),
        preferred: t ? 'tba' : 'first',
        note:
          "FIRST's tournamentLevel carries no set number, so elimination matches cannot be " +
          'aligned between the two sources. This one was taken from a single source and NOT ' +
          'cross-checked.',
      });
      continue;
    }

    if (!t || !f) {
      const present: Source = t ? 'tba' : 'first';
      matches.push((t ?? f)!);
      conflicts.push({
        kind: 'missing-from-source',
        match: id,
        label,
        ...(t ? { tba: roster(t) } : {}),
        ...(f ? { first: roster(f) } : {}),
        preferred: present,
        note: `only ${present} has this match. Taken from there; the other source may lag.`,
      });
      continue;
    }

    // Identity: TBA wins, because its key space is the community lingua franca
    // and the rest of this system is addressed in it.
    let red = t.red;
    let blue = t.blue;
    if (!sameNumbers(t.red, f.red) || !sameNumbers(t.blue, f.blue)) {
      conflicts.push({
        kind: 'roster-mismatch',
        match: id,
        label,
        tba: roster(t),
        first: roster(f),
        preferred: 'tba',
        note:
          'the two sources disagree about who was on the field. TBA is preferred for identity, ' +
          'but a roster mismatch usually means one source has a replay or a substitution the ' +
          'other does not — check before trusting either.',
      });
    }

    // Scores: FIRST wins, being closer to the FMS upload.
    let redScore = t.redScore;
    let blueScore = t.blueScore;

    const tHas = t.redScore !== undefined;
    const fHas = f.redScore !== undefined;

    if (tHas !== fHas) {
      redScore = fHas ? f.redScore : t.redScore;
      blueScore = fHas ? f.blueScore : t.blueScore;
      conflicts.push({
        kind: 'result-presence-mismatch',
        match: id,
        label,
        tba: score(t),
        first: score(f),
        preferred: fHas ? 'first' : 'tba',
        note: 'one source has posted a result and the other has not. Normal within minutes of a match; suspicious hours later.',
      });
    } else if (tHas && fHas && (t.redScore !== f.redScore || t.blueScore !== f.blueScore)) {
      redScore = f.redScore;
      blueScore = f.blueScore;
      conflicts.push({
        kind: 'score-mismatch',
        match: id,
        label,
        tba: score(t),
        first: score(f),
        preferred: 'first',
        note:
          'the official totals disagree. FIRST is preferred as the upstream of both, so a ' +
          'persistent divergence here is a TBA bug worth reporting rather than working around.',
      });
    }

    matches.push({
      match: id,
      red,
      blue,
      ...(redScore !== undefined ? { redScore, blueScore } : {}),
    });
  }

  return {
    eventKey: input.eventKey,
    teams,
    matches,
    conflicts,
    clean: conflicts.length === 0,
  };
}

/** A short operator-facing summary. Empty string when there is nothing to say. */
export function summariseConflicts(conflicts: readonly Conflict[]): string {
  if (conflicts.length === 0) return '';
  const byKind = new Map<ConflictKind, number>();
  for (const c of conflicts) byKind.set(c.kind, (byKind.get(c.kind) ?? 0) + 1);

  const lines = [`${conflicts.length} disagreement(s) between TBA and FIRST:`];
  for (const [kind, n] of [...byKind].sort((a, b) => b[1] - a[1])) {
    lines.push(`  ${String(n).padStart(4)}  ${kind}`);
  }
  const scores = conflicts.filter((c) => c.kind === 'score-mismatch');
  if (scores.length > 0) {
    lines.push(
      '',
      'Score mismatches are the ones worth chasing — both sources claim an official total and',
      'they differ:',
      ...scores.slice(0, 5).map((c) => `  ${c.label}: TBA ${c.tba}, FIRST ${c.first}`),
    );
  }
  return lines.join('\n');
}
