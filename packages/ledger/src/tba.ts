/**
 * The Blue Alliance adapter: fetch, then normalise into the venue-pack shapes.
 *
 * Kept deliberately thin. TBA's responses are wide and change between seasons,
 * and every field this reads is a field that can break in January. So it reads
 * the few that are stable across every season TBA has ever served — event key,
 * team number, match key, alliance rosters, alliance scores — and ignores the
 * rest, including the entire game-specific score breakdown, which is Season
 * Pack's job to interpret and not this module's to guess at.
 */

import {
  packMatch,
  parseMatchKey,
  type CompLevel,
} from '@courier/core';
import { PoliteClient } from './http.ts';
import { SourceError } from './sources.ts';
import type { MatchEntry, TeamEntry } from './venue-pack.ts';

/* -------------------------------------------------------------------------- */
/* The subset of TBA's shapes this depends on                                  */
/* -------------------------------------------------------------------------- */

export interface TbaTeam {
  readonly team_number?: number;
  readonly key?: string;
  readonly nickname?: string;
  readonly name?: string;
}

export interface TbaAlliance {
  readonly score?: number | null;
  readonly team_keys?: readonly string[];
}

export interface TbaMatch {
  readonly key?: string;
  readonly comp_level?: string;
  readonly set_number?: number;
  readonly match_number?: number;
  readonly alliances?: {
    readonly red?: TbaAlliance;
    readonly blue?: TbaAlliance;
  };
  /** Present only once a match has been played. */
  readonly actual_time?: number | null;
}

export class TbaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TbaError';
  }
}

/** "frc8793" -> 8793. TBA team keys are the one identifier it never changed. */
export function teamNumberFromKey(key: string): number {
  const m = /^frc(\d{1,5})$/.exec(key);
  if (!m) throw new TbaError(`"${key}" is not a TBA team key`);
  return Number(m[1]);
}

/* -------------------------------------------------------------------------- */
/* Normalisation                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Team nicknames are public data — they appear on the broadcast and in the
 * printed programme — so carrying them is not a PII decision. Team MEMBER names
 * are never fetched, and TBA does not expose them.
 */
export function normaliseTeams(raw: readonly TbaTeam[]): TeamEntry[] {
  const out: TeamEntry[] = [];
  for (const t of raw) {
    const team = t.team_number ?? (t.key ? teamNumberFromKey(t.key) : undefined);
    if (team === undefined) continue;
    const nickname = (t.nickname ?? t.name ?? `Team ${team}`).slice(0, 60);
    out.push({ team, nickname });
  }
  return out.sort((a, b) => a.team - b.team);
}

/**
 * Normalise matches, skipping anything unparseable rather than failing the run.
 *
 * A single malformed match must not cost a team its whole venue pack the night
 * before an event. Skips are returned so the caller can surface them instead of
 * silently shipping a short schedule.
 */
export function normaliseMatches(raw: readonly TbaMatch[]): {
  matches: MatchEntry[];
  skipped: string[];
} {
  const matches: MatchEntry[] = [];
  const skipped: string[] = [];

  for (const m of raw) {
    try {
      let packed: number;
      if (m.comp_level && m.match_number !== undefined) {
        packed = packMatch({
          level: m.comp_level as CompLevel,
          set: m.comp_level === 'qm' ? 0 : (m.set_number ?? 1),
          number: m.match_number,
        });
      } else if (m.key) {
        packed = parseMatchKey(m.key).packed;
      } else {
        skipped.push('match with no key or comp level');
        continue;
      }

      const red = (m.alliances?.red?.team_keys ?? []).map(teamNumberFromKey);
      const blue = (m.alliances?.blue?.team_keys ?? []).map(teamNumberFromKey);
      if (red.length === 0 || blue.length === 0) {
        skipped.push(`${m.key ?? packed}: missing an alliance roster`);
        continue;
      }

      // TBA reports -1 for an unplayed match rather than null, and 0 is a real
      // score, so both have to be distinguished from "not yet played".
      const played = m.actual_time !== null && m.actual_time !== undefined;
      const redScore = m.alliances?.red?.score;
      const blueScore = m.alliances?.blue?.score;
      const scored =
        played &&
        typeof redScore === 'number' &&
        typeof blueScore === 'number' &&
        redScore >= 0 &&
        blueScore >= 0;

      matches.push({
        match: packed,
        red,
        blue,
        ...(scored ? { redScore, blueScore } : {}),
      });
    } catch (err) {
      skipped.push(`${m.key ?? '(no key)'}: ${(err as Error).message}`);
    }
  }

  matches.sort((a, b) => a.match - b.match);
  return { matches, skipped };
}

/** The highest match with an official result, for the venue pack's staleness field. */
export function lastOfficialMatch(matches: readonly MatchEntry[]): number {
  let last = 0;
  for (const m of matches) {
    if (m.redScore !== undefined && m.match > last) last = m.match;
  }
  return last;
}

/* -------------------------------------------------------------------------- */
/* Client                                                                      */
/* -------------------------------------------------------------------------- */

export interface EventSnapshot {
  readonly eventKey: string;
  readonly teams: TeamEntry[];
  readonly matches: MatchEntry[];
  readonly lastOfficialMatch: number;
  /** Matches that could not be normalised. Surfaced, never swallowed. */
  readonly skipped: string[];
}

export class TbaClient {
  readonly #client: PoliteClient;

  constructor(client: PoliteClient) {
    this.#client = client;
  }

  async teams(eventKey: string): Promise<TeamEntry[]> {
    const raw = await this.#client.getJson<TbaTeam[]>(`/event/${eventKey}/teams`);
    if (!Array.isArray(raw)) throw new TbaError(`unexpected teams response for ${eventKey}`);
    return normaliseTeams(raw);
  }

  async matches(eventKey: string): Promise<{ matches: MatchEntry[]; skipped: string[] }> {
    const raw = await this.#client.getJson<TbaMatch[]>(`/event/${eventKey}/matches`);
    if (!Array.isArray(raw)) throw new TbaError(`unexpected matches response for ${eventKey}`);
    return normaliseMatches(raw);
  }

  /**
   * Everything needed to build a venue pack, in two conditional requests.
   *
   * Two, not one per match: TBA serves the whole event in a single call and
   * charges a 304 for a repeat. Walking match-by-match would be a hundred
   * requests for the same bytes, which is exactly the behaviour that gets an
   * API key revoked for everybody.
   */
  async eventSnapshot(eventKey: string): Promise<EventSnapshot> {
    if (!/^\d{4}[a-z0-9]{2,12}$/.test(eventKey)) {
      throw new TbaError(`"${eventKey}" does not look like an event key`);
    }
    const [teams, matchResult] = await Promise.all([
      this.teams(eventKey),
      this.matches(eventKey),
    ]);
    return {
      eventKey,
      teams,
      matches: matchResult.matches,
      lastOfficialMatch: lastOfficialMatch(matchResult.matches),
      skipped: matchResult.skipped,
    };
  }

  get stats(): PoliteClient['stats'] {
    return this.#client.stats;
  }
}

export { SourceError };
