/**
 * `courier scouts` — end to end, from sealed QR payloads to a drift alarm.
 *
 * The event fixture below has exactly one bad scout. Everything here is really
 * one question: does the tool name that person, and only that person.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Workspace, run, loadProfilesForTest } from './helpers.ts';
import * as cmd from '../src/commands.ts';

function scratch(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'courier-scouts-'));
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
    { name: 'auto', type: 'integer', source: 3, min: 0, max: 200 },
    { name: 'teleop', type: 'integer', source: 4, min: 0, max: 500 },
    { name: 'endgame', type: 'string', source: 5 },
  ],
};

/** Deterministic, so an alarm is never a coincidence of the seed. */
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 0x100000000);
}

interface EventOptions {
  /** Scout who under-counts, and the match they start. Omit for a clean event. */
  readonly drifter?: { scout: string; fromMatch: number; by: number };
  readonly matches?: number;
  /** Scouts per robot per match. 1 means nobody has a second opinion. */
  readonly perRobot?: number;
}

function eventFixture(dir: string, opts: EventOptions = {}): { wsDir: string; schemaPath: string } {
  const wsDir = join(dir, 'ws');
  cmd.init(new Workspace(wsDir), EVENT, 'pit-laptop');

  const teams = [8793, 9143, 1114, 2056, 118, 254];
  const truth = new Map(teams.map((t, i) => [t, 40 - i * 5]));
  const scouts = ['ada', 'bo', 'cy', 'di'];
  const perRobot = opts.perRobot ?? 2;
  const matches = opts.matches ?? 16;
  const rand = lcg(4242);

  const lines: string[] = [];
  for (let m = 1; m <= matches; m++) {
    for (const team of teams) {
      const real = truth.get(team)!;
      // Rotate which scouts cover which robot, so the effects fit has the
      // cross-pairings it needs to attribute a disagreement to one person.
      const start = (m * 3 + team) % scouts.length;
      for (let k = 0; k < perRobot; k++) {
        const scout = scouts[(start + k) % scouts.length]!;
        let v = real + Math.round((rand() - 0.5) * 6);
        if (opts.drifter && scout === opts.drifter.scout && m >= opts.drifter.fromMatch) {
          v -= opts.drifter.by;
        }
        lines.push(tsv(scout, m, team, Math.max(0, Math.round(v / 4)), Math.max(0, v), 'park'));
      }
    }
  }

  const scans = join(dir, 'scans.txt');
  writeFileSync(scans, lines.join('\n'));
  const r = cmd.ingest(new Workspace(wsDir), scans, PROFILES);
  assert.equal(r.code, 0, r.text);

  const schemaPath = join(dir, 'schema.json');
  writeFileSync(schemaPath, JSON.stringify(SCHEMA));
  return { wsDir, schemaPath };
}

const look = (wsDir: string, schemaPath: string, field = 'teleop') =>
  run(['scouts', '--dir', wsDir, '--schema', schemaPath, '--field', field]);

/** Pseudonym prefixes named in the DRIFT block. */
function alarmed(text: string): string[] {
  const i = text.indexOf('DRIFT DETECTED:');
  if (i === -1) return [];
  const block = text.slice(i).split('\n\n')[0]!;
  return [...block.matchAll(/^ {2}([0-9a-f]{8}) —/gm)].map((m) => m[1]!);
}

/* ------------------------------------------------------------------ finds -- */

test('the drifting scout is named, and nobody else is', async () => {
  const s = scratch();
  try {
    const { wsDir, schemaPath } = eventFixture(s.dir, {
      drifter: { scout: 'cy', fromMatch: 9, by: 14 },
    });
    const r = await look(wsDir, schemaPath);
    assert.equal(r.code, 0, r.text);

    const names = alarmed(r.text);
    assert.equal(names.length, 1, `alarmed on ${names.length}: ${r.text}`);
    assert.match(r.text, /under-counting/);
    assert.match(r.text, /still watching the right robot/);
  } finally {
    s.cleanup();
  }
});

test('a clean event raises no alarm at all', async () => {
  const s = scratch();
  try {
    const { wsDir, schemaPath } = eventFixture(s.dir);
    const r = await look(wsDir, schemaPath);
    assert.equal(r.code, 0, r.text);
    // The property the CUSUM constants were re-measured for. At the old
    // textbook 0.5/4 this fired on an innocent scout most events, and a table
    // that is usually wrong stops being read.
    assert.deepEqual(alarmed(r.text), [], r.text);
    assert.ok(!/DRIFT DETECTED/.test(r.text));
  } finally {
    s.cleanup();
  }
});

test('the drifting scout is the one with the negative bias in the table', async () => {
  const s = scratch();
  try {
    const { wsDir, schemaPath } = eventFixture(s.dir, {
      drifter: { scout: 'cy', fromMatch: 9, by: 14 },
    });
    const r = await look(wsDir, schemaPath);

    const rows = [...r.text.matchAll(/^ {2}([0-9a-f]{8}) +(\d+) +([+-] *[\d.]+)/gm)].map((m) => ({
      scout: m[1]!,
      bias: Number(m[3]!.replace(/\s+/g, '')),
    }));
    assert.equal(rows.length, 4, 'four scouts should appear');

    const worst = rows.reduce((a, b) => (a.bias < b.bias ? a : b));
    assert.deepEqual(alarmed(r.text), [worst.scout], 'the alarm and the table disagree');
    assert.ok(worst.bias < -2, `the drifter's bias was only ${worst.bias}`);
  } finally {
    s.cleanup();
  }
});

/* --------------------------------------------------------------- honesty -- */

test('an event with no double-scouting explains the tradeoff rather than printing zeros', async () => {
  const s = scratch();
  try {
    const { wsDir, schemaPath } = eventFixture(s.dir, { perRobot: 1 });
    const r = await look(wsDir, schemaPath);
    assert.equal(r.code, 1);
    assert.match(r.text, /Nothing to compare/);
    assert.match(r.text, /none had/);
    assert.match(r.text, /costs one/);
    assert.ok(!/DRIFT/.test(r.text));
  } finally {
    s.cleanup();
  }
});

test('the output says what it does not measure, every time', async () => {
  const s = scratch();
  try {
    const { wsDir, schemaPath } = eventFixture(s.dir);
    const r = await look(wsDir, schemaPath);
    // "Reliability" reads as "correctness". It is not, and a student handed
    // this table will act on it.
    assert.match(r.text, /DISAGREEMENT WITH OTHER SCOUTS, not accuracy/);
    assert.match(r.text, /same wrong robot agree perfectly/);
    assert.match(r.text, /no third opinion to break the symmetry/);
    assert.match(r.text, /not to rank the students/);
  } finally {
    s.cleanup();
  }
});

test('the output states that scout ids are per-event pseudonyms', async () => {
  const s = scratch();
  try {
    const { wsDir, schemaPath } = eventFixture(s.dir);
    const r = await look(wsDir, schemaPath);
    assert.match(r.text, /pseudonyms, one per event/);
    assert.match(r.text, /cannot be joined across events/);
    // And no raw handle from the QR payloads leaks into the table.
    assert.ok(!/\bada\b|\bcy\b/.test(r.text.split('bias =')[0]!), r.text);
  } finally {
    s.cleanup();
  }
});

test('coverage is reported, so a thin sample is visible', async () => {
  const s = scratch();
  try {
    const { wsDir, schemaPath } = eventFixture(s.dir, { matches: 2 });
    const r = await look(wsDir, schemaPath);
    assert.equal(r.code, 0, r.text);
    assert.match(r.text, /12 of 12 observation\(s\) had a second opinion/);
    // Below the reliability floor the table must say so rather than imply the
    // numbers mean something.
    assert.match(r.text, /no \(8 needed\)/);
  } finally {
    s.cleanup();
  }
});

/* -------------------------------------------------------------- refusals -- */

test('a text field is not something scouts can disagree about numerically', async () => {
  const s = scratch();
  try {
    const { wsDir, schemaPath } = eventFixture(s.dir);
    const r = await look(wsDir, schemaPath, 'endgame');
    assert.equal(r.code, 1);
    assert.match(r.text, /Nothing to compare/);
  } finally {
    s.cleanup();
  }
});

test('scouts without its options prints usage', async () => {
  const s = scratch();
  try {
    const { wsDir } = eventFixture(s.dir);
    const r = await run(['scouts', '--dir', wsDir]);
    assert.equal(r.code, 1);
    assert.match(r.text, /usage: courier scouts/);
    assert.match(r.text, /re-tasked during the event/);
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
    const r = await look(wsDir, schemaPath);
    assert.equal(r.code, 1);
    assert.match(r.text, /courier ingest/);
  } finally {
    s.cleanup();
  }
});

test('the same store produces the same answer twice', async () => {
  const s = scratch();
  try {
    const { wsDir, schemaPath } = eventFixture(s.dir, {
      drifter: { scout: 'cy', fromMatch: 9, by: 14 },
    });
    const a = await look(wsDir, schemaPath);
    const b = await look(wsDir, schemaPath);
    assert.equal(a.text, b.text, 'an accusation that moves between runs is not evidence');
  } finally {
    s.cleanup();
  }
});
