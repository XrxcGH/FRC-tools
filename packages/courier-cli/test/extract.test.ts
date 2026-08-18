/**
 * `courier extract` — the command that stops this being a roach motel.
 *
 * Two things carry the weight here: nothing disappears quietly, and the CSV is
 * safe to open. The second is not paranoia — a record body is text from
 * whatever app printed the QR code, and the file lands in a spreadsheet that a
 * student opens without thinking about it.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { supersede, sealRecord, utf8 } from '@courier/core';
import { Workspace, run, loadProfilesForTest } from './helpers.ts';
import * as cmd from '../src/commands.ts';

function scratch(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'courier-extract-'));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

const EVENT = '2027mose';
const PROFILES = loadProfilesForTest();
const tsv = (...f: (string | number)[]): string => f.join('\t');

const SCHEMA = {
  schemaId: 'courier.generic.tsv.v1',
  format: 'delimited',
  delimiter: '\t',
  fields: [
    { name: 'auto', type: 'integer', source: 3 },
    { name: 'teleop', type: 'integer', source: 4 },
    { name: 'note', type: 'string', source: 5 },
  ],
};

function fixture(dir: string, lines: string[]): { wsDir: string; schemaPath: string } {
  const wsDir = join(dir, 'ws');
  cmd.init(new Workspace(wsDir), EVENT, 'pit-laptop');
  const scans = join(dir, 'scans.txt');
  writeFileSync(scans, lines.join('\n'));
  assert.equal(cmd.ingest(new Workspace(wsDir), scans, PROFILES).code, 0);
  const schemaPath = join(dir, 'schema.json');
  writeFileSync(schemaPath, JSON.stringify(SCHEMA));
  return { wsDir, schemaPath };
}

const DEFAULT_LINES = [
  tsv('ada', 1, 8793, 3, 11, 'clean'),
  tsv('bo', 1, 9143, 2, 9, 'also clean'),
  tsv('cy', 2, 8793, 4, 14, 'third'),
];

const go = (wsDir: string, ...args: string[]) => run(['extract', '--dir', wsDir, ...args]);

/* ------------------------------------------------------------------- csv -- */

test('CSV carries routing fields and the team\'s own decoded columns', async () => {
  const s = scratch();
  try {
    const { wsDir, schemaPath } = fixture(s.dir, DEFAULT_LINES);
    const r = await go(wsDir, '--schema', schemaPath);
    assert.equal(r.code, 0, r.text);

    const rows = r.text.trim().split('\n');
    assert.equal(rows[0], 'event,match,team,scout,schema,decoded,auto,teleop,note');
    assert.equal(rows.length, 4, 'one header, three records');
    assert.match(rows[1]!, /^2027mose,Q1,8793,[0-9a-f]+,courier\.generic\.tsv\.v1,true,3,11,clean$/);
  } finally {
    s.cleanup();
  }
});

test('a value that a spreadsheet would execute is defanged', async () => {
  const s = scratch();
  try {
    // The body is text from whatever app printed the QR code, so this is
    // attacker-controlled. A file a team opens without thinking must not run it.
    const { wsDir, schemaPath } = fixture(s.dir, [
      tsv('ada', 1, 8793, 3, 11, '=HYPERLINK("http://evil/","click")'),
      tsv('bo', 1, 9143, 2, 9, '@SUM(1+1)'),
      tsv('cy', 2, 8793, 1, 7, '+1'),
      tsv('di', 2, 9143, 1, 7, '-1'),
    ]);
    const r = await go(wsDir, '--schema', schemaPath);
    const body = r.text;

    for (const lead of ['=HYPERLINK', '@SUM', '+1', '-1']) {
      assert.ok(!body.includes(`,${lead}`), `an unescaped ${lead} reached a cell`);
    }
    assert.match(body, /"'=HYPERLINK/);
    assert.match(body, /'@SUM/);
  } finally {
    s.cleanup();
  }
});

test('commas, quotes and newlines in a value do not shift the columns', async () => {
  const s = scratch();
  try {
    const { wsDir, schemaPath } = fixture(s.dir, [
      tsv('ada', 1, 8793, 3, 11, 'note, with "quotes" and a comma'),
    ]);
    const r = await go(wsDir, '--schema', schemaPath);
    const line = r.text.trim().split('\n')[1]!;
    assert.ok(line.endsWith('"note, with ""quotes"" and a comma"'), line);
    // The header and the row must still agree on how many columns there are.
    assert.equal(countCsvCells(r.text.trim().split('\n')[0]!), countCsvCells(line));
  } finally {
    s.cleanup();
  }
});

/** A minimal RFC-4180 cell count, so the test does not trust the writer's own logic. */
function countCsvCells(line: string): number {
  let n = 1;
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') {
      if (quoted && line[i + 1] === '"') i++;
      else quoted = !quoted;
    } else if (c === ',' && !quoted) n++;
  }
  return n;
}

/* ------------------------------------------------------------------ json -- */

test('JSON is an array of objects with the same fields', async () => {
  const s = scratch();
  try {
    const { wsDir, schemaPath } = fixture(s.dir, DEFAULT_LINES);
    const r = await go(wsDir, '--schema', schemaPath, '--format', 'json');
    const parsed = JSON.parse(r.text);
    assert.equal(parsed.length, 3);
    assert.deepEqual(Object.keys(parsed[0]), [
      'event', 'match', 'team', 'scout', 'schema', 'decoded', 'auto', 'teleop', 'note',
    ]);
    assert.equal(parsed[0].team, 8793);
    assert.equal(parsed[0].decoded, true);
  } finally {
    s.cleanup();
  }
});

test('an unrecognised format is refused rather than silently defaulting', async () => {
  const s = scratch();
  try {
    const { wsDir, schemaPath } = fixture(s.dir, DEFAULT_LINES);
    const r = await go(wsDir, '--schema', schemaPath, '--format', 'parquet');
    assert.equal(r.code, 1);
    assert.match(r.text, /--format must be csv or json/);
  } finally {
    s.cleanup();
  }
});

/* --------------------------------------------------- nothing disappears -- */

test('a record the schema cannot read is present with decoded=false, not dropped', async () => {
  const s = scratch();
  try {
    const { wsDir, schemaPath } = fixture(s.dir, DEFAULT_LINES);

    // A schema for a different format. Every record becomes unreadable, and a
    // CSV that is quietly shorter than the store is the failure nobody notices.
    const other = join(s.dir, 'other.json');
    writeFileSync(other, JSON.stringify({ ...SCHEMA, schemaId: 'someone.else.v1' }));

    const r = await go(wsDir, '--schema', other);
    assert.equal(r.code, 0, r.text);
    const rows = r.text.trim().split('\n');
    assert.equal(rows.length, 4, 'rows vanished');
    for (const row of rows.slice(1)) assert.match(row, /,false,,,$/);
    assert.match(r.stderr!, /3 record\(s\) could not be decoded/);
    assert.match(r.stderr!, /row count matches the store/);
  } finally {
    s.cleanup();
  }
});

test('--decoded-only drops them, and says so instead of pretending', async () => {
  const s = scratch();
  try {
    const { wsDir, schemaPath } = fixture(s.dir, DEFAULT_LINES);
    const other = join(s.dir, 'other.json');
    writeFileSync(other, JSON.stringify({ ...SCHEMA, schemaId: 'someone.else.v1' }));

    const r = await go(wsDir, '--schema', other, '--decoded-only');
    assert.equal(r.text.trim().split('\n').length, 1, 'only the header should remain');
    assert.match(r.stderr!, /LEFT OUT because you asked for/);
    assert.match(r.stderr!, /still in the store and will still sync/);
  } finally {
    s.cleanup();
  }
});

test('a corrected observation exports once, at the corrected value', async () => {
  const s = scratch();
  try {
    const { wsDir, schemaPath } = fixture(s.dir, DEFAULT_LINES);
    const ws = new Workspace(wsDir);
    const store = ws.store();

    const wrong = store
      .currentRecords()
      .find((x) => new TextDecoder().decode(x.record.body).includes('clean'))!;
    const fixed = supersede(wrong.record, utf8(tsv('ada', 1, 8793, 3, 12, 'corrected')));
    assert.equal(store.admit(sealRecord(fixed, ws.device()), ws.registry().resolver()).status, 'admitted');
    ws.writeStore(store);

    const r = await go(wsDir, '--schema', schemaPath);
    const rows = r.text.trim().split('\n');
    assert.equal(rows.length, 4, 'the typo and its fix both exported');
    assert.match(r.text, /corrected/);
    assert.ok(!/,clean$/m.test(r.text), 'the superseded value survived');
    assert.match(r.stderr!, /1 superseded revision\(s\) excluded/);
  } finally {
    s.cleanup();
  }
});

/* --------------------------------------------------------------- plumbing */

test('with --out the file gets the data and stdout gets the notes', async () => {
  const s = scratch();
  try {
    const { wsDir, schemaPath } = fixture(s.dir, DEFAULT_LINES);
    const out = join(s.dir, 'day.csv');
    const r = await go(wsDir, '--schema', schemaPath, '--out', out);

    assert.equal(r.code, 0);
    assert.match(r.text, /Wrote 3 row\(s\)/);
    assert.equal(r.stderr, undefined, 'nothing needs stderr when the data went to a file');
    assert.equal(readFileSync(out, 'utf8').trim().split('\n').length, 4);
  } finally {
    s.cleanup();
  }
});

test('without --out the data is the output and the notes are on stderr', async () => {
  const s = scratch();
  try {
    const { wsDir, schemaPath } = fixture(s.dir, DEFAULT_LINES);
    const r = await go(wsDir, '--schema', schemaPath);
    // Anything that is not data would corrupt the pipe.
    assert.ok(r.text.startsWith('event,match,team'), r.text.slice(0, 60));
    assert.ok(!/pseudonym/.test(r.text));
    assert.match(r.stderr!, /Scout ids are per-event pseudonyms/);
  } finally {
    s.cleanup();
  }
});

test('the privacy note appears even on a clean run', async () => {
  const s = scratch();
  try {
    const { wsDir, schemaPath } = fixture(s.dir, DEFAULT_LINES);
    const r = await go(wsDir, '--schema', schemaPath);
    // The Bridge profiles all declare scoutIdInBody, so the raw handle is in a
    // column here. Saying so once, every time, beats saying it in a doc.
    assert.match(r.stderr!, /that name is in a column here too/);
    assert.ok(!r.stderr!.startsWith('\n'), 'a clean run opened with a blank line');
  } finally {
    s.cleanup();
  }
});

test('the order is stable, so two laptops produce the same file', async () => {
  const s = scratch();
  try {
    const { wsDir, schemaPath } = fixture(s.dir, [
      tsv('cy', 10, 9143, 1, 7, 'c'),
      tsv('ada', 2, 8793, 3, 11, 'a'),
      tsv('bo', 2, 118, 2, 9, 'b'),
    ]);
    const a = await go(wsDir, '--schema', schemaPath);
    const b = await go(wsDir, '--schema', schemaPath);
    assert.equal(a.text, b.text);

    // Q2 before Q10: a plain string sort would put Q10 first and quietly
    // scramble every match-ordered chart downstream.
    const matches = a.text.trim().split('\n').slice(1).map((l) => l.split(',')[1]);
    assert.deepEqual(matches, ['Q2', 'Q2', 'Q10']);
  } finally {
    s.cleanup();
  }
});

test('extract without a schema prints usage', async () => {
  const s = scratch();
  try {
    const { wsDir } = fixture(s.dir, DEFAULT_LINES);
    const r = await run(['extract', '--dir', wsDir]);
    assert.equal(r.code, 1);
    assert.match(r.text, /usage: courier extract/);
    assert.match(r.text, /Courier moves your data/);
  } finally {
    s.cleanup();
  }
});

test('an empty store points at ingest', async () => {
  const s = scratch();
  try {
    const wsDir = join(s.dir, 'ws');
    cmd.init(new Workspace(wsDir), EVENT, 'pit-laptop');
    const schemaPath = join(s.dir, 'schema.json');
    writeFileSync(schemaPath, JSON.stringify(SCHEMA));
    const r = await go(wsDir, '--schema', schemaPath);
    assert.equal(r.code, 1);
    assert.match(r.text, /courier ingest/);
  } finally {
    s.cleanup();
  }
});
