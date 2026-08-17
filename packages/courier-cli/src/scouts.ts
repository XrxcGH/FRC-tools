/**
 * `courier scouts` — find the scout who stopped watching, during the event.
 *
 * The research found this gap in every direction: teams discover a bad scout
 * from the picklist looking wrong on Saturday night, which is too late to
 * re-task anyone. The blocker was never the statistics — CUSUM has been in
 * `@courier/analytics` all along — it was that residuals needed an official
 * score, and official scores arrive after the matches that mattered.
 *
 * The reference here is the other scouts watching the same robot, so this runs
 * from a team's own store with no network. See `@courier/decode`'s reliability
 * module for what that reference can and cannot tell you: it measures
 * disagreement, not accuracy, and the output has to say so every time.
 */

import { readFileSync } from 'node:fs';
import {
  DecoderRegistry,
  describeGaps,
  loadSchema,
  peerResiduals,
  residualScale,
  type PeerResidual,
} from '@courier/decode';
import {
  scoutReliability,
  scoutEffects,
  adjustForPeers,
  cusumUpdate,
  describeDrift,
  MIN_OBSERVATIONS_FOR_RELIABILITY,
  type CusumState,
} from '@courier/analytics';
import { matchLabel } from '@courier/core';
import { Workspace } from './workspace.ts';
import type { CommandResult } from './commands.ts';

const ok = (text: string): CommandResult => ({ text, code: 0 });
const fail = (text: string): CommandResult => ({ text, code: 1 });

export interface ScoutsArgs {
  readonly schemaPath: string;
  readonly field: string;
  readonly readFile?: (p: string) => string;
}

export function scouts(ws: Workspace, args: ScoutsArgs): CommandResult {
  if (!ws.exists) return fail(`no workspace at ${ws.dir} — run "courier init" first`);

  const read = args.readFile ?? ((p: string) => readFileSync(p, 'utf8'));

  let registry: DecoderRegistry;
  try {
    registry = DecoderRegistry.from([loadSchema(JSON.parse(read(args.schemaPath)))]);
  } catch (err) {
    return fail(`could not load the schema: ${(err as Error).message}`);
  }

  const store = ws.store();
  if (store.size === 0) return fail('no records yet. Run "courier ingest" first.');

  const stored = store.currentRecords();
  const report = registry.decodeAll(stored);
  const gaps = describeGaps(report, stored.length);
  if (report.records.length === 0) {
    return fail(`none of the ${stored.length} records could be decoded.\n\n${gaps}`);
  }

  const res = peerResiduals(report.records, args.field);

  if (res.residuals.length === 0) {
    // Not an error and not an empty table. A team that never double-scouts has
    // made a legitimate choice about where to spend people, and the answer is
    // to explain the tradeoff rather than to print zeros.
    return fail(
      [
        `Nothing to compare. Of ${res.observations} observation(s) on "${args.field}", none had`,
        'two scouts watching the same robot in the same match.',
        '',
        'This check works by disagreement between scouts, so it needs overlap. Double-scouting',
        'even four or five robots a match is enough to catch someone drifting — it costs one',
        'extra person and it is the only way to find a bad scout before the picklist does.',
      ].join('\n'),
    );
  }

  // Raw peer residuals are unusable one row at a time: with two scouts on a
  // robot the two residuals are exact negatives, so one person drifting low
  // pushes every honest partner's residual up by the same amount. Fitting an
  // additive effect per scout across ALL their pairings, then removing the
  // PEERS' fitted effects, leaves each scout's own deviation. Without this step
  // one careless scout raises an alarm on everyone they ever sat next to.
  const comparisons = res.residuals.map((r) => ({
    scout: r.scout,
    peers: r.peerScouts,
    residual: r.residual,
  }));
  const effects = scoutEffects(comparisons);
  const adjusted = adjustForPeers(comparisons, effects);

  const scale = residualScale(res.residuals);
  const quality = scoutReliability(
    res.residuals.map((r, i) => ({ scout: r.scout, residual: adjusted[i]! })),
  );

  /* CUSUM per scout, walked in match order. */
  const drifting: Array<{ scout: string; message: string; at: number }> = [];
  const states = new Map<string, CusumState | null>();
  res.residuals.forEach((r, i) => {
    const next = cusumUpdate(states.get(r.scout) ?? null, adjusted[i]! / scale);
    states.set(r.scout, next);
    if (next.alarm) {
      drifting.push({ scout: r.scout, message: describeDrift(next, adjusted[i]!), at: r.match });
    }
  });

  const short = (s: string): string => s.slice(0, 8);
  const lines: string[] = [
    `${ws.mesh().eventKey} — scout agreement on "${args.field}"`,
    `${res.doubleScouted} of ${res.observations} observation(s) had a second opinion; ` +
      `${res.unpaired} did not`,
    '',
    '  scout       paired    bias   spread   enough?',
  ];

  for (const q of quality) {
    const sd = Math.sqrt(1 / q.precision);
    lines.push(
      `  ${short(q.scout).padEnd(10)}  ${String(q.observations).padStart(6)}  ` +
        `${q.bias >= 0 ? '+' : ''}${q.bias.toFixed(1).padStart(5)}  ${sd.toFixed(1).padStart(6)}  ` +
        `${q.reliable ? 'yes' : `no (${MIN_OBSERVATIONS_FOR_RELIABILITY} needed)`}`,
    );
  }

  lines.push(
    '',
    'bias = how far above or below their peers this scout runs, on average.',
    'spread = how much they vary around that, shrunk toward the pool when data is thin.',
    `"enough?" is no until ${MIN_OBSERVATIONS_FOR_RELIABILITY} paired observations. Below that the`,
    'numbers shown are mostly the pool average wearing that scout\'s name.',
  );

  if (drifting.length > 0) {
    lines.push('', 'DRIFT DETECTED:');
    const first = new Map<string, { message: string; at: number }>();
    for (const d of drifting) if (!first.has(d.scout)) first.set(d.scout, d);
    for (const [scout, d] of first) {
      lines.push(`  ${short(scout)} — from around ${matchLabel(d.at)}. ${d.message}`);
    }
  }

  if (gaps) lines.push('', gaps);

  lines.push(
    '',
    'This measures DISAGREEMENT WITH OTHER SCOUTS, not accuracy. Two people watching the',
    'same wrong robot agree perfectly and both look reliable here. A careful scout on a',
    'robot nobody else covered produces no rows at all. Use it to start a conversation,',
    'not to rank the students.',
    '',
    'Two scouts who only ever watch robots together cannot be told apart by this: there is',
    'no third opinion to break the symmetry, so the disagreement gets split between them.',
    'Rotate pairings and the attribution sharpens.',
    '',
    'Scout ids are pseudonyms, one per event, so they cannot be joined across events into a',
    'record about a person. Only your team knows which handle is whom.',
  );

  return ok(lines.join('\n'));
}

/** Exported for tests: the residual rows behind the table. */
export function residualsFor(
  ws: Workspace,
  registry: DecoderRegistry,
  field: string,
): PeerResidual[] {
  return peerResiduals(registry.decodeAll(ws.store().currentRecords()).records, field).residuals;
}
