/**
 * Building a picklist from a venue pack, offline.
 *
 * This is the end of the design's flagship journey: a team pulls a pack the
 * night before on hotel wifi, carries it into a pit with no internet, and builds
 * a picklist there. Nothing in this file touches the network — the pack has
 * everything, which is the entire reason the pack exists.
 *
 * ── Why the pack must be verified ───────────────────────────────────────────
 * A pack travels by flash drive and BLE between devices with no way to check
 * where it came from, and it carries the numbers a captain will draft on. An
 * unverified pack is the fabricated-ratings problem wearing a signature-shaped
 * hole: the pit cannot tell a real one from a made-up one, and a picklist built
 * on invented numbers looks exactly like a picklist built on real ones. So a
 * key is required rather than optional.
 */

import { readFileSync } from 'node:fs';
import {
  rankPicklist,
  contingencies,
  formatPicklist,
  seededRng,
  type TeamEstimate,
} from '@courier/analytics';
import { deviceKeyFromSecret, deriveKeyId, toHex } from '@courier/core';
import { openVenuePack, describeStaleness, VenuePackError } from './venue-pack.ts';
import type { LedgerResult } from './cli.ts';

export interface PicklistOptions {
  readonly packPath: string;
  /** The signing device's secret key, used only to derive its public half. */
  readonly keyPath: string;
  /** Teams already on your alliance, captain first. */
  readonly alliance: readonly number[];
  readonly exclude?: readonly number[];
  /** Rival picks before your next turn. In a serpentine draft this is what depletes the board. */
  readonly picksBetween?: number;
  readonly haveSecondPick?: boolean;
  readonly now?: () => number;
  readonly readFile?: (path: string) => Uint8Array;
  /** Deterministic seed, so the same pack yields the same list. */
  readonly seed?: number;
  readonly limit?: number;
}

const ok = (text: string): LedgerResult => ({ text, code: 0 });
const fail = (text: string): LedgerResult => ({ text, code: 1 });

export function picklistFromPack(opts: PicklistOptions): LedgerResult {
  const read = opts.readFile ?? ((p: string) => new Uint8Array(readFileSync(p)));

  let packBytes: Uint8Array;
  let secret: Uint8Array;
  try {
    packBytes = read(opts.packPath);
    secret = read(opts.keyPath);
  } catch (err) {
    return fail(`could not read an input: ${(err as Error).message}`);
  }

  const signer = deviceKeyFromSecret(secret);
  let opened;
  try {
    opened = openVenuePack(packBytes, (kid) =>
      toHex(kid) === toHex(deriveKeyId(signer.publicKey)) ? signer.publicKey : undefined,
    );
  } catch (err) {
    if (err instanceof VenuePackError) {
      return fail(
        `${err.message}\n\n` +
          'This pack was not signed by the key you supplied. Either it came from somewhere\n' +
          'else, or it has been altered. Do not draft on it: a pack with substituted ratings\n' +
          'looks exactly like a real one from in here.',
      );
    }
    throw err;
  }

  const { pack } = opened;

  if (pack.ratings.length === 0) {
    return fail(
      `${pack.eventKey}: this pack carries no ratings, so there is nothing to rank.\n\n` +
        'Regenerate it with "ledger pack --ratings" once enough matches have been played.\n' +
        'The pack deliberately contains none rather than a column of priors dressed up as\n' +
        'measurements.',
    );
  }

  const byTeam = new Map(pack.ratings.map((r) => [r.team, r]));
  const alliance: TeamEstimate[] = [];
  const missing: number[] = [];
  for (const t of opts.alliance) {
    const r = byTeam.get(t);
    if (!r) missing.push(t);
    else alliance.push({ team: t, mean: r.mean, sigma: r.sigma });
  }
  if (missing.length > 0) {
    return fail(
      `no rating in this pack for team(s) ${missing.join(', ')}.\n` +
        'They may have played too few matches to be fitted, in which case the pack omitted\n' +
        'them on purpose rather than guessing.',
    );
  }

  const onAlliance = new Set(opts.alliance);
  const candidates: TeamEstimate[] = pack.ratings
    .filter((r) => !onAlliance.has(r.team))
    .map((r) => ({ team: r.team, mean: r.mean, sigma: r.sigma }));

  if (candidates.length === 0) {
    return fail('every rated team is already on your alliance; there is nobody left to pick.');
  }

  const ranked = rankPicklist({
    candidates,
    alliance,
    picksBeforeYourNext: opts.picksBetween ?? 0,
    haveSecondPick: opts.haveSecondPick ?? false,
    exclude: opts.exclude,
    rng: seededRng(opts.seed ?? 1),
  });

  const stale = describeStaleness(pack, (opts.now ?? Date.now)());
  const lines: string[] = [
    `${pack.eventKey} — picklist for ${opts.alliance.join(' + ')}`,
    `pack ${stale.ageLabel}, ${pack.ratings.length} rated team(s), ${candidates.length} on the board`,
    '',
    formatPicklist(ranked, opts.limit ?? 20),
    '',
  ];

  // Staleness is not a footnote here. A picklist is the single most consequential
  // thing built from a pack, and one built on yesterday's numbers looks
  // identical to one built on this morning's.
  if (stale.resultsIncomplete) {
    lines.push(
      `WARNING: this pack has no official result for ${stale.matchesBehind} match(es) that have`,
      'since been played. Those matches are not in these numbers. Carry fresh results in',
      'before the meeting if you can.',
      '',
    );
  }
  if (stale.ageMs > 12 * 3_600_000) {
    lines.push(
      `WARNING: this pack is ${stale.ageLabel}. Regenerate it rather than drafting on it.`,
      '',
    );
  }

  const plan = contingencies(ranked, 5);
  if (plan.length > 0) {
    lines.push('If the top of the list is gone when your turn comes:');
    for (const c of plan) {
      lines.push(`  ${c.goneTeams.join(', ')} taken  ->  take ${c.take}`);
    }
    lines.push('');
  }

  lines.push(
    'Ranked by expected alliance value after the picks that follow, not by rating alone.',
    'A team ranked high that everyone else also wants is worth less to you than one nobody',
    'has noticed, which is what the risk column is for.',
  );

  return ok(lines.join('\n'));
}

/** Parse a comma or space separated team list from the command line. */
export function parseTeamList(text: string | undefined): number[] {
  if (!text) return [];
  return text
    .split(/[,\s]+/)
    .filter((s) => s.length > 0)
    .map((s) => {
      const n = Number(s);
      if (!Number.isInteger(n) || n < 1) throw new Error(`"${s}" is not a team number`);
      return n;
    });
}
