/**
 * The FIRST FRC Events API adapter.
 *
 * The second official source, and the reason there is a second one at all:
 * FIRST reserves the right to "terminate and discontinue allowing any use of
 * the APIs... for any or all Users", and The Blue Alliance is four unpaid
 * trustees on roughly $5,000 a year. Either can go away. A tool that reads only
 * one of them inherits that single point of failure, so this exists to be the
 * independent second opinion — and, where the two disagree, to say so rather
 * than silently pick.
 *
 * ── Identity, which the two APIs disagree about by construction ─────────────
 * TBA addresses an event as one string: `2027mose`. FIRST splits it into a year
 * in the path and an event code in a query parameter: `/v3.0/2027/...?eventCode=MOSE`.
 * The design settles this — TBA's key space is canonical and FIRST codes are an
 * alias — so everything here converts inward at the edge and the rest of the
 * system never sees a FIRST-shaped identifier.
 */

import { packMatch, matchLabel, type CompLevel } from '@courier/core';
import { PoliteClient } from './http.ts';
import type { MatchEntry, TeamEntry } from './venue-pack.ts';

export class FirstApiError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FirstApiError';
  }
}

/** Split a TBA event key into the year and event code FIRST expects. */
export function splitEventKey(eventKey: string): { year: number; code: string } {
  const m = /^(\d{4})([a-z0-9]{2,12})$/.exec(eventKey);
  if (!m) throw new FirstApiError(`"${eventKey}" is not a TBA-style event key`);
  return { year: Number(m[1]), code: m[2]!.toUpperCase() };
}

/* -------------------------------------------------------------------------- */
/* The subset of FIRST's shapes this depends on                                */
/* -------------------------------------------------------------------------- */

export interface FirstTeam {
  readonly teamNumber?: number;
  readonly nameShort?: string;
}

export interface FirstStation {
  readonly teamNumber?: number;
  /** "Red1".."Red3", "Blue1".."Blue3". */
  readonly station?: string;
}

export interface FirstMatch {
  readonly matchNumber?: number;
  readonly tournamentLevel?: string;
  readonly description?: string;
  readonly scoreRedFinal?: number | null;
  readonly scoreBlueFinal?: number | null;
  readonly teams?: readonly FirstStation[];
  /** Present once played. */
  readonly actualStartTime?: string | null;
  readonly postResultTime?: string | null;
}

/**
 * FIRST's tournament levels do not map cleanly onto TBA's; be explicit.
 *
 * `practice` is deliberately absent, and it used to map to `qm`. That made
 * Practice 1 pack to the same match id as Qualification 1, so a practice score
 * overwrote the real qualification total, the export carried it as the official
 * result, and the reconciler blamed TBA for a roster mismatch it had invented.
 * Practice matches numbered past the qual schedule were worse than an
 * overwrite: they became qualification matches that never happened.
 *
 * Practice results are not part of the official record and carry no ranking
 * weight, so dropping them is correct — the packing scheme has no level for
 * them because TBA has no level for them.
 */
const LEVELS: Readonly<Record<string, CompLevel>> = {
  qualification: 'qm',
  playoff: 'sf',
};

/** Levels recognised and deliberately not imported, so they are not "unmapped". */
const DELIBERATELY_DROPPED: Readonly<Record<string, string>> = {
  practice: 'practice results are not part of the official record',
};

export function compLevelFor(tournamentLevel: string | undefined): CompLevel | null {
  if (!tournamentLevel) return null;
  return LEVELS[tournamentLevel.toLowerCase()] ?? null;
}

export function normaliseFirstTeams(raw: readonly FirstTeam[]): TeamEntry[] {
  const out: TeamEntry[] = [];
  for (const t of raw) {
    if (typeof t.teamNumber !== 'number') continue;
    out.push({ team: t.teamNumber, nickname: (t.nameShort ?? `Team ${t.teamNumber}`).slice(0, 60) });
  }
  return out.sort((a, b) => a.team - b.team);
}

export function normaliseFirstMatches(raw: readonly FirstMatch[]): {
  matches: MatchEntry[];
  skipped: string[];
} {
  const matches: MatchEntry[] = [];
  const skipped: string[] = [];

  for (const m of raw) {
    const label = m.description ?? `match ${m.matchNumber ?? '?'}`;
    const level = compLevelFor(m.tournamentLevel);
    if (!level) {
      // A level we chose not to import reads differently from one nobody has
      // mapped yet: the first is a decision, the second is a gap to go fix.
      const why = DELIBERATELY_DROPPED[(m.tournamentLevel ?? '').toLowerCase()];
      skipped.push(
        why
          ? `${label}: skipped — ${why}`
          : `${label}: unmapped tournament level "${m.tournamentLevel ?? ''}"`,
      );
      continue;
    }
    if (typeof m.matchNumber !== 'number') {
      skipped.push(`${label}: no match number`);
      continue;
    }

    const red: number[] = [];
    const blue: number[] = [];
    for (const s of m.teams ?? []) {
      if (typeof s.teamNumber !== 'number' || !s.station) continue;
      if (/^red/i.test(s.station)) red.push(s.teamNumber);
      else if (/^blue/i.test(s.station)) blue.push(s.teamNumber);
    }
    if (red.length === 0 || blue.length === 0) {
      skipped.push(`${label}: missing an alliance roster`);
      continue;
    }

    // FIRST signals "played" with a post-result timestamp. A null score and a
    // real 0 are both possible, so the timestamp is the only safe gate.
    const played = Boolean(m.postResultTime ?? m.actualStartTime);
    const scored =
      played && typeof m.scoreRedFinal === 'number' && typeof m.scoreBlueFinal === 'number';

    try {
      matches.push({
        match: packMatch({ level, set: level === 'qm' ? 0 : 1, number: m.matchNumber }),
        red,
        blue,
        ...(scored ? { redScore: m.scoreRedFinal!, blueScore: m.scoreBlueFinal! } : {}),
      });
    } catch (err) {
      skipped.push(`${label}: ${(err as Error).message}`);
    }
  }

  // Two rows packing to one id means the level mapping is wrong — that is how
  // a practice match came to overwrite a qualification result. Downstream the
  // collision would be resolved by a Map's last-wins and vanish without a
  // trace, so catch it here where the cause is visible.
  const byId = new Map<number, MatchEntry[]>();
  for (const m of matches) {
    const list = byId.get(m.match);
    if (list) list.push(m);
    else byId.set(m.match, [m]);
  }

  const unique: MatchEntry[] = [];
  for (const [id, rows] of byId) {
    if (rows.length === 1) {
      unique.push(rows[0]!);
      continue;
    }
    // Drop them ALL. Keeping either one puts one match's score on another
    // match's roster, and which one survives would depend on payload order.
    skipped.push(
      `${matchLabel(id)}: ${rows.length} source rows pack to the same match id ` +
        rows.map((r) => `(${r.red.join('/')} vs ${r.blue.join('/')})`).join(' and ') +
        `. None were imported — a collision here means a tournament level is mapped wrong, ` +
        `and picking a winner would put one match's score on another match's roster.`,
    );
  }

  unique.sort((a, b) => a.match - b.match);
  return { matches: unique, skipped };
}

/* -------------------------------------------------------------------------- */
/* Client                                                                      */
/* -------------------------------------------------------------------------- */

export interface FirstSnapshot {
  readonly eventKey: string;
  readonly teams: TeamEntry[];
  readonly matches: MatchEntry[];
  readonly skipped: string[];
}

export class FirstClient {
  readonly #client: PoliteClient;

  constructor(client: PoliteClient) {
    this.#client = client;
  }

  async eventSnapshot(eventKey: string): Promise<FirstSnapshot> {
    const { year, code } = splitEventKey(eventKey);

    const [teamsRaw, matchesRaw] = await Promise.all([
      this.#client.getJson<{ teams?: FirstTeam[] }>(`/${year}/teams?eventCode=${code}`),
      this.#client.getJson<{ Matches?: FirstMatch[] }>(`/${year}/matches/${code}`),
    ]);

    if (!Array.isArray(teamsRaw?.teams)) {
      throw new FirstApiError(`unexpected teams response for ${eventKey}`);
    }
    if (!Array.isArray(matchesRaw?.Matches)) {
      throw new FirstApiError(`unexpected matches response for ${eventKey}`);
    }

    const { matches, skipped } = normaliseFirstMatches(matchesRaw.Matches);
    return { eventKey, teams: normaliseFirstTeams(teamsRaw.teams), matches, skipped };
  }
}
