/**
 * The whole loop, end to end: QR text in, picklist out.
 *
 * These tests go through the real CLI entry point rather than calling the
 * command function, because the argument parsing is where a picklist command
 * gets silently wrong — a team list that half-parses produces a plausible board
 * for the wrong alliance and nobody notices until the pick is made.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { supersede, sealRecord, utf8 } from '@courier/core';
import { Workspace, run, loadProfilesForTest } from './helpers.ts';
import * as cmd from '../src/commands.ts';

function scratch(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'courier-pick-'));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

const EVENT = '2027mose';
const PROFILES = loadProfilesForTest();
const tsv = (...f: (string | number)[]): string => f.join('\t');

/** The team's own decoder for the shipped generic TSV layout. */
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

/**
 * A small event: eight teams, five matches each, scouted by three people.
 *
 * Means are deliberately separated so the ranking is checkable, and the spread
 * differs per team so floor and ceiling are not just the mean repeated.
 */
function fixture(dir: string): { wsDir: string; schemaPath: string } {
  const wsDir = join(dir, 'ws');
  const ws = new Workspace(wsDir);
  cmd.init(ws, EVENT, 'pit-laptop');

  const teams: Array<[number, number[]]> = [
    [8793, [40, 44, 38, 42, 41]], // best, and steady
    [9143, [50, 20, 55, 15, 48]], // higher ceiling, much shakier
    [1114, [30, 32, 28, 31, 29]],
    [2056, [25, 24, 26, 25, 24]],
    [118, [20, 22, 18, 21, 19]],
    [254, [15, 14, 16, 15, 15]],
    [971, [10, 12, 8, 11, 9]],
    [1678, [5, 6, 4, 5, 6]],
  ];
  const scouts = ['s1', 's2', 's3'];

  const lines: string[] = [];
  for (const [team, values] of teams) {
    values.forEach((v, i) => {
      lines.push(tsv(scouts[i % scouts.length]!, i + 1, team, Math.round(v / 4), v, 'park'));
    });
  }

  const scans = join(dir, 'scans.txt');
  writeFileSync(scans, lines.join('\n'));
  const r = cmd.ingest(ws, scans, PROFILES);
  assert.equal(r.code, 0, r.text);
  assert.equal(ws.store().size, teams.length * 5);

  const schemaPath = join(dir, 'schema.json');
  writeFileSync(schemaPath, JSON.stringify(SCHEMA));
  return { wsDir, schemaPath };
}

const pick = (wsDir: string, ...args: string[]) =>
  run(['picklist', '--dir', wsDir, ...args]);

/* ------------------------------------------------------------------ ranks -- */

test('a picklist comes out of the team\'s own scouting, in order', async () => {
  const s = scratch();
  try {
    const { wsDir, schemaPath } = fixture(s.dir);
    const r = await pick(wsDir, '--schema', schemaPath, '--field', 'teleop', '--alliance', '8793');

    assert.equal(r.code, 0, r.text);
    assert.match(r.text, new RegExp(EVENT));
    assert.match(r.text, /40 decoded record/);

    // The alliance's own team must not appear as a candidate to pick.
    const board = r.text.slice(r.text.indexOf('this team alone'));
    assert.ok(!/\b8793\b/.test(board.split('risk =')[0]!), 'ranked yourself');

    // Order: the strongest remaining team should top the board.
    const order = [...board.matchAll(/^\s*\d+\s+(\d+)\s/gm)].map((m) => Number(m[1]));
    assert.equal(order[0], 9143, `board started ${order.join(', ')}`);
    assert.equal(order.at(-1), 1678);
  } finally {
    s.cleanup();
  }
});

test('a steadier team out-floors a streakier one with the same reach', async () => {
  const s = scratch();
  try {
    const { wsDir, schemaPath } = fixture(s.dir);
    const r = await pick(wsDir, '--schema', schemaPath, '--field', 'teleop', '--alliance', '254');

    const rows = [...r.text.matchAll(/^\s*\d+\s+(\d+)\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)/gm)].map(
      (m) => ({ team: Number(m[1]), floor: Number(m[3]), ceiling: Number(m[4]) }),
    );
    const steady = rows.find((x) => x.team === 8793)!;
    const streaky = rows.find((x) => x.team === 9143)!;

    assert.ok(steady.floor > streaky.floor, 'the streaky team had the better bad day');
    assert.ok(streaky.ceiling > steady.ceiling, 'the streaky team had no upside');
  } finally {
    s.cleanup();
  }
});

test('contingencies are printed, so the list works off paper', async () => {
  const s = scratch();
  try {
    const { wsDir, schemaPath } = fixture(s.dir);
    const r = await pick(wsDir, '--schema', schemaPath, '--field', 'teleop', '--alliance', '8793');
    assert.match(r.text, /If the top of the list is gone/);
    assert.match(r.text, /taken  ->  take/);
  } finally {
    s.cleanup();
  }
});

test('the output says what it is not', async () => {
  const s = scratch();
  try {
    const { wsDir, schemaPath } = fixture(s.dir);
    const r = await pick(wsDir, '--schema', schemaPath, '--field', 'teleop', '--alliance', '8793');
    // The caveat is not decoration. These numbers have never been checked
    // against the official record, and a picklist that does not say so gets
    // read as authoritative.
    assert.match(r.text, /not a fit against official/);
    assert.match(r.text, /reconciled against what the field actually reported/);
  } finally {
    s.cleanup();
  }
});

/* --------------------------------------------------------------- refusals -- */

test('an alliance of several teams is accepted, comma or space separated', async () => {
  const s = scratch();
  try {
    const { wsDir, schemaPath } = fixture(s.dir);
    const a = await pick(wsDir, '--schema', schemaPath, '--field', 'teleop', '--alliance', '8793,1114');
    const b = await pick(wsDir, '--schema', schemaPath, '--field', 'teleop', '--alliance', '8793 1114');
    assert.equal(a.code, 0, a.text);
    assert.equal(b.code, 0, b.text);
    assert.equal(a.text, b.text);
  } finally {
    s.cleanup();
  }
});

test('a team number that is not a number is refused, not silently dropped', async () => {
  const s = scratch();
  try {
    const { wsDir, schemaPath } = fixture(s.dir);
    const r = await pick(wsDir, '--schema', schemaPath, '--field', 'teleop', '--alliance', '8793,frc1114');
    assert.equal(r.code, 1);
    assert.match(r.text, /"frc1114" is not a team number/);
  } finally {
    s.cleanup();
  }
});

test('an alliance member with no estimate stops the run rather than ranking without them', async () => {
  const s = scratch();
  try {
    const { wsDir, schemaPath } = fixture(s.dir);
    const r = await pick(wsDir, '--schema', schemaPath, '--field', 'teleop', '--alliance', '8793,4');
    assert.equal(r.code, 1);
    assert.match(r.text, /no estimate for team\(s\) 4/);
    assert.match(r.text, /min-observations/);
  } finally {
    s.cleanup();
  }
});

test('an unknown field names the fields that do exist', async () => {
  const s = scratch();
  try {
    const { wsDir, schemaPath } = fixture(s.dir);
    const r = await pick(wsDir, '--schema', schemaPath, '--field', 'climb', '--alliance', '8793');
    assert.equal(r.code, 1);
    assert.match(r.text, /no field named "climb"/);
    assert.match(r.text, /Fields available: auto, endgame, teleop/);
  } finally {
    s.cleanup();
  }
});

test('a text field is refused as a ranking field, and the refusal says why', async () => {
  const s = scratch();
  try {
    const { wsDir, schemaPath } = fixture(s.dir);
    const r = await pick(wsDir, '--schema', schemaPath, '--field', 'endgame', '--alliance', '8793');
    assert.equal(r.code, 1);
    // Distinct from "no such field" on purpose: the field IS there, spelled
    // right, and telling the reader to check the spelling wastes their evening.
    assert.match(r.text, /holds text, not a quantity/);
    assert.match(r.text, /Values seen: "park"/);
    assert.match(r.text, /no ordering that you declared/);
    assert.ok(!/field name is wrong/.test(r.text));
  } finally {
    s.cleanup();
  }
});

test('a floor nobody meets yet reports it as early, with the counts so far', async () => {
  const s = scratch();
  try {
    const { wsDir, schemaPath } = fixture(s.dir);
    const r = await pick(
      wsDir, '--schema', schemaPath, '--field', 'teleop',
      '--alliance', '8793', '--min-observations', '9',
    );
    assert.equal(r.code, 1);
    assert.match(r.text, /it is early/);
    assert.match(r.text, /8793 \(5\)/, 'the counts so far are shown, not just the shortfall');
    assert.ok(!/no field named/.test(r.text));
  } finally {
    s.cleanup();
  }
});

test('a schema that does not match the stored records reports the gap, it does not zero it', async () => {
  const s = scratch();
  try {
    const { wsDir } = fixture(s.dir);
    const wrong = join(s.dir, 'wrong.json');
    writeFileSync(wrong, JSON.stringify({ ...SCHEMA, schemaId: 'someone.elses.format.v3' }));

    const r = await pick(wsDir, '--schema', wrong, '--field', 'teleop', '--alliance', '8793');
    assert.equal(r.code, 1);
    assert.match(r.text, /none of the 40 records could be decoded/);
    assert.match(r.text, /cannot read: courier\.generic\.tsv\.v1/);
    assert.match(r.text, /sync onward untouched/);
  } finally {
    s.cleanup();
  }
});

test('a malformed schema file is refused with the reason', async () => {
  const s = scratch();
  try {
    const { wsDir } = fixture(s.dir);
    const bad = join(s.dir, 'bad.json');
    writeFileSync(bad, JSON.stringify({ ...SCHEMA, delimiter: ',' }));

    const r = await pick(wsDir, '--schema', bad, '--field', 'teleop', '--alliance', '8793');
    assert.equal(r.code, 1);
    assert.match(r.text, /could not load the schema/);
    assert.match(r.text, /shifts every column/);
  } finally {
    s.cleanup();
  }
});

test('an empty store points at ingest instead of printing an empty board', async () => {
  const s = scratch();
  try {
    const wsDir = join(s.dir, 'ws');
    cmd.init(new Workspace(wsDir), EVENT, 'pit-laptop');
    const schemaPath = join(s.dir, 'schema.json');
    writeFileSync(schemaPath, JSON.stringify(SCHEMA));

    const r = await pick(wsDir, '--schema', schemaPath, '--field', 'teleop', '--alliance', '8793');
    assert.equal(r.code, 1);
    assert.match(r.text, /courier ingest/);
  } finally {
    s.cleanup();
  }
});

test('picklist without its options prints usage and explains why there is no built-in decoder', async () => {
  const s = scratch();
  try {
    const { wsDir } = fixture(s.dir);
    const r = await pick(wsDir);
    assert.equal(r.code, 1);
    assert.match(r.text, /usage: courier picklist/);
    assert.match(r.text, /varies per team/);
  } finally {
    s.cleanup();
  }
});

/* ------------------------------------------------------------ thin scouting */

test('teams under the observation floor are named, not quietly omitted', async () => {
  const s = scratch();
  try {
    const { wsDir, schemaPath } = fixture(s.dir);

    // A ninth team, seen twice. It must not appear on the board, and its
    // absence must be stated — a picklist that silently omits a team is worse
    // than one that ranks it badly, because nobody goes looking for it.
    const ws = new Workspace(wsDir);
    const extra = join(s.dir, 'extra.txt');
    writeFileSync(extra, [tsv('s1', 6, 3357, 5, 33, 'park'), tsv('s2', 7, 3357, 5, 35, 'park')].join('\n'));
    assert.equal(cmd.ingest(ws, extra, PROFILES).code, 0);

    const r = await pick(wsDir, '--schema', schemaPath, '--field', 'teleop', '--alliance', '8793');
    assert.equal(r.code, 0, r.text);
    assert.match(r.text, /1 team\(s\) omitted for fewer than 3 observations: 3357 \(2\)/);

    const board = r.text.slice(r.text.indexOf('this team alone'), r.text.indexOf('alliance total ='));
    assert.ok(!/3357/.test(board), 'a two-observation team reached the board');
  } finally {
    s.cleanup();
  }
});

test('lowering the floor lets a thin team on, and the count moves with it', async () => {
  const s = scratch();
  try {
    const { wsDir, schemaPath } = fixture(s.dir);
    const ws = new Workspace(wsDir);
    const extra = join(s.dir, 'extra.txt');
    writeFileSync(extra, [tsv('s1', 6, 3357, 5, 33, 'park'), tsv('s2', 7, 3357, 5, 35, 'park')].join('\n'));
    cmd.ingest(ws, extra, PROFILES);

    const r = await pick(
      wsDir, '--schema', schemaPath, '--field', 'teleop',
      '--alliance', '8793', '--min-observations', '2',
    );
    assert.equal(r.code, 0, r.text);
    const board = r.text.slice(r.text.indexOf('this team alone'), r.text.indexOf('alliance total ='));
    assert.match(board, /3357/);
    assert.ok(!/omitted for fewer/.test(r.text));
  } finally {
    s.cleanup();
  }
});

test('--min-observations rejects a value that is not a positive whole number', async () => {
  const s = scratch();
  try {
    const { wsDir, schemaPath } = fixture(s.dir);
    for (const bad of ['0', '-1', '2.5', 'lots']) {
      const r = await pick(
        wsDir, '--schema', schemaPath, '--field', 'teleop',
        '--alliance', '8793', '--min-observations', bad,
      );
      assert.equal(r.code, 1, `accepted ${bad}`);
      assert.match(r.text, /positive whole number/);
    }
  } finally {
    s.cleanup();
  }
});

/* ------------------------------------------------------------ pick context */

test('excluded teams do not appear', async () => {
  const s = scratch();
  try {
    const { wsDir, schemaPath } = fixture(s.dir);
    const r = await pick(
      wsDir, '--schema', schemaPath, '--field', 'teleop',
      '--alliance', '8793', '--exclude', '9143,1114',
    );
    assert.equal(r.code, 0, r.text);
    const board = r.text.slice(r.text.indexOf('this team alone'), r.text.indexOf('alliance total ='));
    assert.ok(!/9143|1114/.test(board), board);
  } finally {
    s.cleanup();
  }
});

test('picks between your turns raise availability risk at the top of the board', async () => {
  const s = scratch();
  try {
    const { wsDir, schemaPath } = fixture(s.dir);
    const risks = async (between: string): Promise<number> => {
      const r = await pick(
        wsDir, '--schema', schemaPath, '--field', 'teleop',
        '--alliance', '8793', '--picks-between', between,
      );
      assert.equal(r.code, 0, r.text);
      return Number(/^\s*1\s+\d+\s+[\d.]+\s+[\d.]+\s+[\d.]+\s+(\d+)%/m.exec(r.text)![1]);
    };
    assert.ok((await risks('8')) > (await risks('0')), 'more picks did not raise risk');
  } finally {
    s.cleanup();
  }
});

test('--picks-between rejects a value that is not a whole count', async () => {
  const s = scratch();
  try {
    const { wsDir, schemaPath } = fixture(s.dir);
    const r = await pick(
      wsDir, '--schema', schemaPath, '--field', 'teleop',
      '--alliance', '8793', '--picks-between', '-2',
    );
    assert.equal(r.code, 1);
    assert.match(r.text, /non-negative whole number/);
  } finally {
    s.cleanup();
  }
});

test('the same store and arguments produce the same board twice', async () => {
  const s = scratch();
  try {
    const { wsDir, schemaPath } = fixture(s.dir);
    // The ranking runs a Monte Carlo draft. A picklist that reshuffles between
    // two runs of the same command cannot be trusted or reviewed, so the RNG is
    // seeded rather than left to Math.random.
    const a = await pick(wsDir, '--schema', schemaPath, '--field', 'teleop', '--alliance', '8793', '--picks-between', '4');
    const b = await pick(wsDir, '--schema', schemaPath, '--field', 'teleop', '--alliance', '8793', '--picks-between', '4');
    assert.equal(a.text, b.text);
  } finally {
    s.cleanup();
  }
});

/* ------------------------------------------------------- corrected records */

test('a corrected observation counts once, at the corrected value', async () => {
  const s = scratch();
  try {
    const { wsDir, schemaPath } = fixture(s.dir);
    const ws = new Workspace(wsDir);

    // Team 254's five matches all sit near 15. Add a sixth at a slipped
    // keystroke — 150 — then correct it to 15 the way a scout actually would,
    // with an append-only supersede. The original stays in the log forever
    // because peers that have not seen the fix still reconcile against it.
    const extra = join(s.dir, 'slip.txt');
    writeFileSync(extra, tsv('s1', 6, 254, 4, 150, 'park'));
    assert.equal(cmd.ingest(ws, extra, PROFILES).code, 0);

    const store = ws.store();
    // Found by body rather than by match number: `record.match` is the PACKED
    // form (level, set, number), not the 6 that went in on the QR.
    const wrong = store
      .currentRecords()
      .find((x) => x.record.team === 254 && new TextDecoder().decode(x.record.body).includes('150'))!;
    const fixed = supersede(wrong.record, utf8(tsv('s1', 6, 254, 4, 15, 'park')));
    const admitted = store.admit(sealRecord(fixed, ws.device()), ws.registry().resolver());
    assert.equal(admitted.status, 'admitted', admitted.reason);
    ws.writeStore(store);

    const r = await pick(wsDir, '--schema', schemaPath, '--field', 'teleop', '--alliance', '8793');
    assert.equal(r.code, 0, r.text);
    assert.match(r.text, /1 superseded revision\(s\) excluded/);

    // The mean of six 15s is 15. The mean including the slip is 37.5, which
    // would put 254 near the top of a board it does not belong on.
    const rows = [...r.text.matchAll(/^\s*(\d+)\s+(\d+)\s/gm)].map((m) => Number(m[2]));
    assert.ok(rows.indexOf(254) > rows.indexOf(1114), `254 ranked at ${rows.indexOf(254)}: ${rows}`);
    assert.ok(rows.indexOf(254) > rows.indexOf(118), 'the slip is still being counted');
  } finally {
    s.cleanup();
  }
});
