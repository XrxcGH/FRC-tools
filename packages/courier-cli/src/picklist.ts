/**
 * A picklist from the team's own scouting data.
 *
 * The full loop, ending here: an app that knows nothing about Courier emits QR
 * codes, the Bridge seals them, records gossip across the stands with no venue
 * network, and the picklist laptop reads them back through the team's own
 * decoder and ranks the board. Nothing in this command touches the network and
 * nothing needs an API key.
 *
 * ── Why no least squares ────────────────────────────────────────────────────
 * `ledger picklist` fits contributions, because the official record is
 * alliance-level and the parts have to be solved for. Scouting data is already
 * per-robot, so the deconvolution is unnecessary here. A mean is more accurate
 * AND more explainable, which matters when a student has to defend the list in a
 * meeting against someone who liked a different robot.
 */

import { readFileSync } from 'node:fs';
import {
  DecoderRegistry,
  describeGaps,
  loadSchema,
  teamEstimatesFrom,
  DEFAULT_MIN_OBSERVATIONS,
} from '@courier/decode';
import {
  rankPicklist,
  contingencies,
  formatPicklist,
  seededRng,
  type TeamEstimate,
} from '@courier/analytics';
import { Workspace } from './workspace.ts';
import type { CommandResult } from './commands.ts';

const ok = (text: string): CommandResult => ({ text, code: 0 });
const fail = (text: string): CommandResult => ({ text, code: 1 });

export interface PicklistArgs {
  readonly schemaPath: string;
  readonly field: string;
  readonly alliance: readonly number[];
  readonly exclude?: readonly number[];
  readonly picksBetween?: number;
  readonly minObservations?: number;
  readonly readFile?: (p: string) => string;
  readonly seed?: number;
  readonly limit?: number;
}

export function picklist(ws: Workspace, args: PicklistArgs): CommandResult {
  if (!ws.exists) return fail(`no workspace at ${ws.dir} — run "courier init" first`);

  const read = args.readFile ?? ((p: string) => readFileSync(p, 'utf8'));

  let registry: DecoderRegistry;
  try {
    registry = DecoderRegistry.from([loadSchema(JSON.parse(read(args.schemaPath)))]);
  } catch (err) {
    return fail(`could not load the schema: ${(err as Error).message}`);
  }

  const store = ws.store();
  if (store.size === 0) {
    return fail('no records yet. Run "courier ingest" first.');
  }

  // The CURRENT view, not every record ever admitted. `sortedIds` is the sync
  // view: a corrected observation leaves the original in the log forever so
  // peers can still reconcile, and averaging that set counts the typo and the
  // fix as two matches. Both numbers look plausible, so nothing catches it.
  const stored = store.currentRecords();
  const superseded = store.size - stored.length;
  const report = registry.decodeAll(stored);

  const gaps = describeGaps(report, stored.length);
  if (report.records.length === 0) {
    return fail(`none of the ${stored.length} records could be decoded.\n\n${gaps}`);
  }

  const minObs = args.minObservations ?? DEFAULT_MIN_OBSERVATIONS;
  const { estimates, thin } = teamEstimatesFrom(report.records, args.field, {
    minObservations: minObs,
  });

  if (estimates.length === 0) {
    // Three different causes, three different fixes. One generic message for
    // all of them sends a student looking for a typo in a field name that is
    // spelled correctly.
    const fields = availableFields(report.records);
    const numericSeen = report.records.some((r) => {
      const v = r.values[args.field];
      return typeof v === 'number' || typeof v === 'boolean';
    });

    if (!fields.includes(args.field)) {
      return fail(
        `no field named "${args.field}" in any decoded record.\n` +
          `Fields available: ${fields.join(', ') || '(none)'}`,
      );
    }
    if (!numericSeen) {
      return fail(
        `"${args.field}" holds text, not a quantity, so it cannot be averaged. Values seen: ` +
          `${sampleValues(report.records, args.field).join(', ')}.\n` +
          'Those categories have no ordering that you declared, and inventing one here would\n' +
          'rank teams on a scale nobody chose. Declare the field as a boolean or an integer\n' +
          'in your schema if it is one, or pick a different field.',
      );
    }
    return fail(
      `no team has been scouted ${minObs} times on "${args.field}" yet — it is early.\n` +
        `${thin.length} team(s) have some data: ` +
        `${thin.slice(0, 12).map((t) => `${t.team} (${t.observations})`).join(', ')}.\n` +
        'Lower --min-observations if you accept a shakier number.',
    );
  }

  const byTeam = new Map(estimates.map((e) => [e.team, e]));
  const alliance: TeamEstimate[] = [];
  const unscouted: number[] = [];
  for (const t of args.alliance) {
    const e = byTeam.get(t);
    if (!e) unscouted.push(t);
    else alliance.push({ team: t, mean: e.mean, sigma: e.sigma, spread: e.spread });
  }
  if (unscouted.length > 0) {
    return fail(
      `no estimate for team(s) ${unscouted.join(', ')} — they have fewer than ${minObs}\n` +
        'observations on this field. Lower --min-observations if you accept a shakier number,\n' +
        'but a rating from two matches is how a picklist ends up ranking noise.',
    );
  }

  const onAlliance = new Set(args.alliance);
  const candidates: TeamEstimate[] = estimates
    .filter((e) => !onAlliance.has(e.team))
    .map((e) => ({ team: e.team, mean: e.mean, sigma: e.sigma, spread: e.spread }));

  if (candidates.length === 0) {
    return fail('every scouted team is already on your alliance; there is nobody left to pick.');
  }

  const ranked = rankPicklist({
    candidates,
    alliance,
    picksBeforeYourNext: args.picksBetween ?? 0,
    haveSecondPick: (args.picksBetween ?? 0) > 0,
    exclude: args.exclude,
    rng: seededRng(args.seed ?? 1),
  });

  const mesh = ws.mesh();
  const lines: string[] = [
    `${mesh.eventKey} — picklist for ${args.alliance.join(' + ')}, on "${args.field}"`,
    `${report.records.length} decoded record(s), ${estimates.length} team(s) with at least ${minObs}` +
      (superseded > 0 ? `, ${superseded} superseded revision(s) excluded` : ''),
    '',
    formatPicklist(ranked, args.limit ?? 20),
    '',
  ];

  // Everything the numbers do NOT include, before the contingencies rather than
  // after, because that is the part a reader skips.
  if (gaps) lines.push(gaps, '');
  if (thin.length > 0) {
    lines.push(
      `${thin.length} team(s) omitted for fewer than ${minObs} observations: ` +
        thin.map((t) => `${t.team} (${t.observations})`).join(', '),
      '',
    );
  }

  const plan = contingencies(ranked, 5);
  if (plan.length > 0) {
    lines.push('If the top of the list is gone when your turn comes:');
    for (const c of plan) lines.push(`  ${c.goneTeams.join(', ')} taken  ->  take ${c.take}`);
    lines.push('');
  }

  lines.push(
    'These are your own scouts\' numbers, averaged per robot — not a fit against official',
    'alliance totals. They are only as good as the scouting behind them, and nothing here',
    'has been reconciled against what the field actually reported.',
  );

  return ok(lines.join('\n'));
}

function availableFields(records: readonly { values: Record<string, unknown> }[]): string[] {
  const names = new Set<string>();
  for (const r of records) for (const k of Object.keys(r.values)) names.add(k);
  return [...names].sort();
}

/** A few distinct values of a field, so the message shows what is actually there. */
function sampleValues(
  records: readonly { values: Record<string, unknown> }[],
  field: string,
): string[] {
  const seen = new Set<string>();
  for (const r of records) {
    const v = r.values[field];
    if (v === undefined) continue;
    seen.add(JSON.stringify(v));
    if (seen.size >= 5) break;
  }
  return [...seen].sort();
}
