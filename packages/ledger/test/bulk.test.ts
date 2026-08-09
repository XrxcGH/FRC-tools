import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildBulkExport,
  toNdjson,
  toCsv,
  cacheControlFor,
  BulkError,
  type MatchEntry,
  type TeamEntry,
} from '../src/index.ts';
import { packMatch } from '@courier/core';

const qm = (n: number) => packMatch({ level: 'qm', set: 0, number: n });

const TEAMS: TeamEntry[] = [
  { team: 8793, nickname: 'Example A' },
  { team: 9143, nickname: 'Comma, Inc' },
  { team: 254, nickname: 'Quote "Quoted" Team' },
];

const MATCHES: MatchEntry[] = [
  { match: qm(1), red: [8793, 254, 118], blue: [9143, 1678, 2056], redScore: 88, blueScore: 91 },
  { match: qm(2), red: [9143, 118, 254], blue: [8793, 2056, 1678] }, // unplayed
  {
    match: packMatch({ level: 'sf', set: 1, number: 2 }),
    red: [254, 8793, 118],
    blue: [1678, 9143, 2056],
    redScore: 0,
    blueScore: 0, // a real shutout, not "unplayed"
  },
];

const INPUT = {
  eventKey: '2027mose',
  generatedAt: 1_800_000_000_000,
  sources: ['tba', 'first'] as const,
  teams: TEAMS,
  matches: MATCHES,
};

/* --------------------------------------------------------------- writers -- */

test('NDJSON is one object per line, and empty input is empty', () => {
  const text = toNdjson([{ a: 1 }, { a: 2 }]);
  assert.equal(text, '{"a":1}\n{"a":2}\n');
  assert.equal(toNdjson([]), '');
  for (const line of text.trim().split('\n')) JSON.parse(line); // every line parses alone
});

test('CSV quotes commas, quotes, and newlines per RFC 4180', () => {
  const csv = toCsv(
    [{ a: 'plain', b: 'has,comma', c: 'has"quote', d: 'has\nnewline' }],
    ['a', 'b', 'c', 'd'],
  );
  // Records are separated by CRLF; a newline INSIDE a quoted field stays put,
  // which is the whole point of the quoting.
  const lines = csv.split('\r\n');
  assert.equal(lines[0], 'a,b,c,d');
  assert.equal(lines[1], 'plain,"has,comma","has""quote","has\nnewline"');
  assert.match(csv, /""quote/, 'a quote is doubled, not dropped');
});

test('CSV renders null and undefined as empty, not as the words', () => {
  const csv = toCsv([{ a: null, b: undefined, c: 0, d: false }], ['a', 'b', 'c', 'd']);
  assert.equal(csv.split('\r\n')[1], ',,0,false');
});

/* ---------------------------------------------------------------- export -- */

test('an export produces both formats for both tables, plus an index', () => {
  const files = buildBulkExport(INPUT).files();
  const paths = [...files.keys()].sort();

  assert.equal(paths.filter((p) => p.endsWith('.ndjson')).length, 2);
  assert.equal(paths.filter((p) => p.endsWith('.csv')).length, 2);
  assert.ok(paths.includes('2027mose/index.json'));
  assert.ok(paths.includes('2027mose/ATTRIBUTION.txt'));
  for (const p of paths) assert.ok(p.startsWith('2027mose/'), `${p} is namespaced by event`);
});

test('artifacts are content-addressed, so identical data yields identical paths', () => {
  const a = buildBulkExport(INPUT);
  const b = buildBulkExport(INPUT);
  assert.deepEqual(
    a.artifacts.map((x) => x.path),
    b.artifacts.map((x) => x.path),
  );

  // Change one value and every path for that table moves.
  const changed = buildBulkExport({
    ...INPUT,
    matches: [{ ...MATCHES[0]!, redScore: 89 }, ...MATCHES.slice(1)],
  });
  const before = a.artifacts.find((x) => x.contentType === 'text/csv' && x.rows === 3)!;
  const after = changed.artifacts.find((x) => x.contentType === 'text/csv' && x.rows === 3)!;
  assert.notEqual(before.path, after.path, 'the digest must move when the body does');
});

test('the manifest describes every artifact by digest and row count', () => {
  const { manifest, artifacts } = buildBulkExport(INPUT);
  assert.equal(manifest.eventKey, '2027mose');
  assert.equal(manifest.artifacts.length, artifacts.length);
  for (const entry of manifest.artifacts) {
    assert.match(entry.digest, /^[0-9a-f]{64}$/);
    assert.ok(artifacts.some((a) => a.path === entry.path));
  }
  const matchEntries = manifest.artifacts.filter((a) => a.kind === 'matches');
  assert.equal(matchEntries.length, 2);
  for (const e of matchEntries) assert.equal(e.rows, 3);
});

test('source disagreements are surfaced in the manifest, never hidden', () => {
  const { manifest } = buildBulkExport({ ...INPUT, conflicts: 4 });
  assert.equal(manifest.conflicts, 4);
  assert.deepEqual([...manifest.sources], ['tba', 'first']);
});

test('an export must name its sources, so attribution cannot be omitted', () => {
  assert.throws(() => buildBulkExport({ ...INPUT, sources: [] }), BulkError);

  const files = buildBulkExport(INPUT).files();
  const attribution = new TextDecoder().decode(files.get('2027mose/ATTRIBUTION.txt')!);
  assert.match(attribution, /Event Data provided by FIRST/);
  assert.match(attribution, /The Blue Alliance/);
  assert.match(attribution, /generates revenue/, 'the non-commercial condition rides with the data');
});

/* ------------------------------------------------------------ row shapes -- */

test('an unplayed match is distinguishable from a genuine nil-nil in the export', () => {
  // The distinction survives all the way to the file a stranger downloads: a
  // null score with played=false, versus 0 with played=true.
  const files = buildBulkExport(INPUT).files();
  const ndjsonPath = [...files.keys()].find((p) => p.includes('matches-') && p.endsWith('.ndjson'))!;
  const rows = new TextDecoder()
    .decode(files.get(ndjsonPath)!)
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l) as Record<string, unknown>);

  const q1 = rows.find((r) => r.match_key === '2027mose_qm1')!;
  const q2 = rows.find((r) => r.match_key === '2027mose_qm2')!;
  const sf = rows.find((r) => r.match_key === '2027mose_sf1m2')!;

  assert.equal(q1.played, true);
  assert.equal(q1.red_score, 88);
  assert.equal(q2.played, false);
  assert.equal(q2.red_score, null);
  assert.equal(sf.played, true);
  assert.equal(sf.red_score, 0, 'a real shutout is not an absence');
});

test('match keys in the export round-trip to TBA form', () => {
  const files = buildBulkExport(INPUT).files();
  const path = [...files.keys()].find((p) => p.includes('matches-') && p.endsWith('.ndjson'))!;
  const keys = new TextDecoder()
    .decode(files.get(path)!)
    .trim()
    .split('\n')
    .map((l) => (JSON.parse(l) as { match_key: string }).match_key);

  assert.deepEqual(keys.sort(), ['2027mose_qm1', '2027mose_qm2', '2027mose_sf1m2']);
});

test('a nickname containing a comma survives the CSV intact', () => {
  const files = buildBulkExport(INPUT).files();
  const path = [...files.keys()].find((p) => p.includes('teams-') && p.endsWith('.csv'))!;
  const csv = new TextDecoder().decode(files.get(path)!);
  assert.match(csv, /"Comma, Inc"/);
  assert.match(csv, /"Quote ""Quoted"" Team"/);
});

/* ---------------------------------------------------------------- caching -- */

test('content-addressed bodies are immutable and only the index is not', () => {
  // Immutable bodies plus one tiny mutable pointer is what makes the whole
  // thing cacheable at the edge for nothing.
  const files = buildBulkExport(INPUT).files();
  for (const path of files.keys()) {
    const cc = cacheControlFor(path);
    if (path.endsWith('index.json')) assert.match(cc, /max-age=60/);
    else if (path.endsWith('ATTRIBUTION.txt')) assert.match(cc, /max-age=3600/);
    else assert.match(cc, /immutable/, `${path} should be immutable`);
  }
});

test('an empty event still produces a valid, downloadable export', () => {
  const files = buildBulkExport({ ...INPUT, teams: [], matches: [] }).files();
  assert.ok(files.has('2027mose/index.json'));
  const index = JSON.parse(new TextDecoder().decode(files.get('2027mose/index.json')!)) as {
    artifacts: { rows: number }[];
  };
  for (const a of index.artifacts) assert.equal(a.rows, 0);
});
