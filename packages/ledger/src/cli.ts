/**
 * `ledger` — fetch an event from both official sources, reconcile them, and
 * write the artifacts a team can carry into a venue with no internet.
 *
 * Separate from the `courier` CLI on purpose. Courier is about a team's own
 * mesh and holds a signing key; ledger only reads public data and writes files.
 * Keeping them apart means the machine that runs a nightly fetch never needs
 * the key that signs scouting records.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { PoliteClient, type FetchLike, type HttpResponse } from './http.ts';
import { TbaClient } from './tba.ts';
import { FirstClient } from './first.ts';
import { reconcileSnapshots, summariseConflicts } from './reconcile.ts';
import { buildBulkExport } from './bulk.ts';
import { buildVenuePack, type MatchEntry, type RatingEntry } from './venue-pack.ts';
import { SourceError, type SourceId } from './sources.ts';
import {
  fitContributions,
  underDetermined,
  type AllianceObservation,
} from '@courier/analytics';
import type { DeviceKeyPair } from '@courier/core';

export interface LedgerResult {
  readonly text: string;
  readonly code: number;
}

const ok = (text: string): LedgerResult => ({ text, code: 0 });
const fail = (text: string): LedgerResult => ({ text, code: 1 });

/** Adapt the platform fetch to the shape PoliteClient expects. */
export const nodeFetch: FetchLike = async (url, init): Promise<HttpResponse> => {
  const res = await globalThis.fetch(url, { headers: init.headers });
  const headers: Record<string, string> = {};
  res.headers.forEach((v, k) => {
    headers[k] = v;
  });
  return { status: res.status, headers, body: new Uint8Array(await res.arrayBuffer()) };
};

export interface Credentials {
  readonly tbaKey?: string;
  readonly firstUser?: string;
  readonly firstToken?: string;
}

export function credentialsFromEnv(env: Record<string, string | undefined>): Credentials {
  return {
    tbaKey: env.TBA_AUTH_KEY,
    firstUser: env.FRC_API_USER,
    firstToken: env.FRC_API_TOKEN,
  };
}

export interface FetchOptions {
  readonly eventKey: string;
  readonly outDir: string;
  readonly credentials: Credentials;
  readonly fetch?: FetchLike;
  readonly now?: () => number;
  /** Write files. Injected so tests do not touch the filesystem. */
  readonly writeFile?: (path: string, bytes: Uint8Array) => void;
}

function defaultWrite(path: string, bytes: Uint8Array): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, bytes);
}

/**
 * Fetch, reconcile, and write a bulk export.
 *
 * Reads whichever sources it has credentials for. With only one it still works
 * and says plainly that nothing was cross-checked — which is honest, and better
 * than refusing to run for a team that only has a TBA key.
 */
export async function fetchEvent(opts: FetchOptions): Promise<LedgerResult> {
  const { eventKey, credentials } = opts;
  const fetchImpl = opts.fetch ?? nodeFetch;
  const now = (opts.now ?? Date.now)();
  const write = opts.writeFile ?? defaultWrite;

  if (!credentials.tbaKey && !(credentials.firstUser && credentials.firstToken)) {
    return fail(
      'no credentials. Set TBA_AUTH_KEY, or FRC_API_USER and FRC_API_TOKEN, or both.\n' +
        'Both are free and self-serve. With both, the two sources are cross-checked and\n' +
        'disagreements are reported; with one, nothing is checked against anything.',
    );
  }

  const sources: SourceId[] = [];
  let tbaSnap: Awaited<ReturnType<TbaClient['eventSnapshot']>> | null = null;
  let firstSnap: Awaited<ReturnType<FirstClient['eventSnapshot']>> | null = null;
  const notes: string[] = [];

  try {
    if (credentials.tbaKey) {
      const client = new TbaClient(
        new PoliteClient('tba', { fetch: fetchImpl, credentials: { token: credentials.tbaKey } }),
      );
      tbaSnap = await client.eventSnapshot(eventKey);
      sources.push('tba');
      if (tbaSnap.skipped.length) {
        notes.push(`TBA: skipped ${tbaSnap.skipped.length} unparseable match(es)`);
      }
    }
    if (credentials.firstUser && credentials.firstToken) {
      const client = new FirstClient(
        new PoliteClient('first', {
          fetch: fetchImpl,
          credentials: { username: credentials.firstUser, token: credentials.firstToken },
        }),
      );
      firstSnap = await client.eventSnapshot(eventKey);
      sources.push('first');
      if (firstSnap.skipped.length) {
        notes.push(`FIRST: skipped ${firstSnap.skipped.length} unparseable match(es)`);
      }
    }
  } catch (err) {
    if (err instanceof SourceError) {
      return fail(`${err.source}: ${err.message}`);
    }
    return fail((err as Error).message);
  }

  const reconciled = reconcileSnapshots({
    eventKey,
    tbaTeams: tbaSnap?.teams ?? [],
    tbaMatches: tbaSnap?.matches ?? [],
    firstTeams: firstSnap?.teams ?? [],
    firstMatches: firstSnap?.matches ?? [],
  });

  const bulk = buildBulkExport({
    eventKey,
    generatedAt: now,
    sources,
    teams: reconciled.teams,
    matches: reconciled.matches,
    conflicts: reconciled.conflicts.length,
  });

  const files = bulk.files();
  for (const [rel, bytes] of files) write(join(opts.outDir, rel), bytes);

  const lines = [
    `${eventKey}: ${reconciled.teams.length} teams, ${reconciled.matches.length} matches`,
    `sources: ${sources.join(' + ')}`,
    `wrote ${files.size} file(s) under ${opts.outDir}`,
    '',
  ];

  if (sources.length < 2) {
    lines.push(
      'Only one source was available, so NOTHING was cross-checked. Disagreements between',
      'TBA and FIRST are the main thing a second source buys; without it you have one',
      "source's word for everything.",
      '',
    );
  }
  if (notes.length) lines.push(...notes, '');

  const summary = summariseConflicts(reconciled.conflicts);
  lines.push(summary || 'The two sources agreed on everything comparable.');

  return ok(lines.join('\n'));
}

export interface PackOptions extends FetchOptions {
  readonly signer: DeviceKeyPair;
  readonly seasonPackId: string;
  readonly outFile: string;
  /** Ratings, if any are available. Omitted rather than faked when absent. */
  readonly ratings?: readonly RatingEntry[];
  /**
   * Fit contributions from the event's own played matches.
   *
   * Off by default. Early in an event the fit is dominated by the prior and
   * says very little, and a pack that quietly contains near-prior numbers looks
   * exactly like one containing real ones — so asking for them is a deliberate
   * act, and the output says how thin the data was.
   */
  readonly computeRatings?: boolean;
  /** Below this many alliance appearances a team gets no rating at all. */
  readonly minAppearances?: number;
}

/**
 * Turn played matches into alliance observations for the estimator.
 *
 * Unplayed matches contribute nothing — they have no score, and treating a
 * missing result as a zero would drag every team on that alliance down.
 */
export function observationsFrom(matches: readonly MatchEntry[]): AllianceObservation[] {
  const out: AllianceObservation[] = [];
  for (const m of matches) {
    if (m.redScore === undefined || m.blueScore === undefined) continue;
    if (m.red.length > 0) out.push({ teams: m.red, score: m.redScore });
    if (m.blue.length > 0) out.push({ teams: m.blue, score: m.blueScore });
  }
  return out;
}

/**
 * Build a signed venue pack for an event.
 *
 * Ratings are passed in rather than invented here. A pack with fabricated
 * ratings is worse than a pack with none: the pit cannot tell the difference,
 * and a picklist built on made-up numbers looks exactly like one built on real
 * ones.
 */
export async function makeVenuePack(opts: PackOptions): Promise<LedgerResult> {
  const fetched = await fetchEvent({ ...opts, writeFile: () => {} });
  if (fetched.code !== 0) return fetched;

  const fetchImpl = opts.fetch ?? nodeFetch;
  const now = (opts.now ?? Date.now)();
  const write = opts.writeFile ?? defaultWrite;

  if (!opts.credentials.tbaKey) {
    return fail('a venue pack needs TBA_AUTH_KEY for the schedule');
  }
  const client = new TbaClient(
    new PoliteClient('tba', { fetch: fetchImpl, credentials: { token: opts.credentials.tbaKey } }),
  );
  const snap = await client.eventSnapshot(opts.eventKey);

  const notes: string[] = [];
  let ratings: readonly RatingEntry[] = opts.ratings ?? [];

  if (!opts.ratings?.length && opts.computeRatings) {
    const observations = observationsFrom(snap.matches);
    if (observations.length === 0) {
      notes.push(
        'No matches have been played yet, so there is nothing to fit. The pack carries no',
        'ratings rather than a column of priors dressed up as measurements.',
      );
    } else {
      const fit = fitContributions(observations);
      const minAppearances = opts.minAppearances ?? 4;
      const thin = new Set(underDetermined(fit, minAppearances).map((c) => c.team));

      ratings = fit.contributions
        .filter((c) => !thin.has(c.team))
        .map((c) => ({
          team: c.team,
          mean: c.mean,
          sigma: c.sigma,
          matchesPlayed: c.appearances,
        }));

      notes.push(
        `Fitted ${ratings.length} rating(s) from ${observations.length} alliance observation(s).`,
        `  ridge lambda ${fit.lambda}, effective dof ${fit.effectiveDof.toFixed(1)} of ${fit.teams}`,
        `  residual sigma ${fit.residualSigma.toFixed(1)} points`,
      );
      if (thin.size > 0) {
        notes.push(
          `  ${thin.size} team(s) omitted for fewer than ${minAppearances} appearances — an`,
          '  estimate from two matches formatted like a real one is how a picklist ranks noise',
        );
      }
      if (fit.effectiveDof < fit.teams / 3) {
        notes.push(
          '',
          'WARNING: effective degrees of freedom are low, meaning the fit is still dominated by',
          'the prior. These numbers separate teams barely more than guessing does. Re-generate',
          'once more matches have been played.',
        );
      }
    }
  }

  const bytes = buildVenuePack(
    {
      eventKey: opts.eventKey,
      generatedAt: now,
      officialResultsAsOfMatch: snap.lastOfficialMatch,
      sources: ['tba'],
      seasonPackId: opts.seasonPackId,
      teams: snap.teams,
      matches: snap.matches,
      ratings,
    },
    opts.signer,
  );
  write(opts.outFile, bytes);

  const lines = [
    `Wrote a signed venue pack to ${opts.outFile} (${(bytes.length / 1024).toFixed(1)} kB).`,
    `  ${snap.teams.length} teams, ${snap.matches.length} matches`,
    `  official results through match ${snap.lastOfficialMatch || '(none yet)'}`,
  ];
  if (notes.length) lines.push('', ...notes);
  if (ratings.length === 0 && !opts.computeRatings) {
    lines.push(
      '',
      'No ratings were supplied and none were computed, so the pack carries none. Pass',
      '--ratings to fit them from the event\'s own played matches. A pack with fabricated',
      'ratings is worse than one with none, because the pit cannot tell which it is holding.',
    );
  }
  return ok(lines.join('\n'));
}
