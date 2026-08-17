import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  picklistFromPack,
  parseTeamList,
  buildVenuePack,
  type RatingEntry,
} from '../src/index.ts';
import { run } from '../src/main.ts';
import { generateDeviceKey, packMatch } from '@courier/core';

const NOW = 1_800_000_000_000;
const signer = generateDeviceKey('software');
const stranger = generateDeviceKey('software');

const RATINGS: RatingEntry[] = [
  { team: 100, mean: 50, sigma: 4, matchesPlayed: 10 },
  { team: 101, mean: 44, sigma: 4, matchesPlayed: 10 },
  { team: 102, mean: 38, sigma: 4, matchesPlayed: 10 },
  { team: 103, mean: 32, sigma: 4, matchesPlayed: 10 },
  { team: 104, mean: 26, sigma: 4, matchesPlayed: 10 },
  { team: 105, mean: 20, sigma: 4, matchesPlayed: 10 },
];

function pack(opts: { ratings?: RatingEntry[]; asOf?: number; key?: typeof signer } = {}): Uint8Array {
  return buildVenuePack(
    {
      eventKey: '2027mose',
      generatedAt: NOW,
      officialResultsAsOfMatch: opts.asOf ?? packMatch({ level: 'qm', set: 0, number: 60 }),
      sources: ['tba'],
      seasonPackId: 'x@1.0.0',
      teams: (opts.ratings ?? RATINGS).map((r) => ({ team: r.team, nickname: `T${r.team}` })),
      matches: [],
      ratings: opts.ratings ?? RATINGS,
    },
    opts.key ?? signer,
  );
}

/** Serve the pack and key from memory, so no test touches the filesystem. */
function files(packBytes: Uint8Array, secret = signer.secretKey) {
  return (p: string): Uint8Array => {
    if (p === 'pack') return packBytes;
    if (p === 'key') return secret;
    throw new Error(`no such file ${p}`);
  };
}

const base = {
  packPath: 'pack',
  keyPath: 'key',
  now: () => NOW,
};

/* ----------------------------------------------------------------- args --- */

test('team lists parse from commas or spaces, and refuse nonsense', () => {
  assert.deepEqual(parseTeamList('100,101 102'), [100, 101, 102]);
  assert.deepEqual(parseTeamList(undefined), []);
  assert.deepEqual(parseTeamList(''), []);
  assert.throws(() => parseTeamList('100,abc'), /not a team number/);
  assert.throws(() => parseTeamList('0'), /not a team number/);
});

/* ------------------------------------------------------------ the ranking -- */

test('a picklist ranks the board and never lists your own alliance', () => {
  const r = picklistFromPack({
    ...base,
    alliance: [100],
    readFile: files(pack()),
  });

  assert.equal(r.code, 0);
  assert.match(r.text, /2027mose — picklist for 100/);
  assert.ok(!/^\s+\d+\s+100\s/m.test(r.text), 'the captain is not a candidate');
  assert.match(r.text, /5 on the board/);
  assert.match(r.text, /floor = 20th percentile/);
});

test('excluded teams are gone from the list entirely', () => {
  const r = picklistFromPack({
    ...base,
    alliance: [100],
    exclude: [101, 102],
    readFile: files(pack()),
  });
  assert.equal(r.code, 0);
  assert.ok(!/\s101\s/.test(r.text));
  assert.ok(!/\s102\s/.test(r.text));
});

test('contingencies are precomputed, because the room has no internet', () => {
  const r = picklistFromPack({ ...base, alliance: [100], readFile: files(pack()) });
  assert.match(r.text, /If the top of the list is gone when your turn comes:/);
  assert.match(r.text, /taken\s+->\s+take \d+/);
});

test('the same pack and seed give the same list', () => {
  // A picklist that reorders itself when recomputed mid-meeting destroys trust
  // faster than being slightly wrong would.
  const bytes = pack();
  const a = picklistFromPack({ ...base, alliance: [100], readFile: files(bytes), seed: 9 });
  const b = picklistFromPack({ ...base, alliance: [100], readFile: files(bytes), seed: 9 });
  assert.equal(a.text, b.text);
});

/* --------------------------------------------------------------- refusals -- */

test('a pack signed by someone else is refused, loudly', () => {
  // The whole point of signing: from inside a pit, a pack with substituted
  // ratings looks exactly like a real one.
  const r = picklistFromPack({
    ...base,
    alliance: [100],
    readFile: files(pack({ key: stranger })),
  });
  assert.equal(r.code, 1);
  assert.match(r.text, /Do not draft on it/);
  assert.match(r.text, /looks exactly like a real one/);
});

test('a tampered pack is refused', () => {
  const bytes = pack();
  bytes[bytes.length - 30]! ^= 0x01;
  const r = picklistFromPack({ ...base, alliance: [100], readFile: files(bytes) });
  assert.equal(r.code, 1);
  assert.match(r.text, /Do not draft on it/);
});

test('a pack with no ratings says so rather than ranking nothing', () => {
  const r = picklistFromPack({
    ...base,
    alliance: [100],
    readFile: files(pack({ ratings: [] })),
  });
  assert.equal(r.code, 1);
  assert.match(r.text, /carries no ratings/);
  assert.match(r.text, /priors dressed up as/);
});

test('an unrated captain is named rather than silently dropped', () => {
  const r = picklistFromPack({
    ...base,
    alliance: [999],
    readFile: files(pack()),
  });
  assert.equal(r.code, 1);
  assert.match(r.text, /no rating in this pack for team\(s\) 999/);
  assert.match(r.text, /on purpose rather than guessing/);
});

test('an alliance that has already taken everyone is an error, not an empty list', () => {
  const r = picklistFromPack({
    ...base,
    alliance: RATINGS.map((x) => x.team),
    readFile: files(pack()),
  });
  assert.equal(r.code, 1);
  assert.match(r.text, /nobody left to pick/);
});

test('a missing file fails with the reason, not a stack trace', () => {
  const r = picklistFromPack({
    ...base,
    alliance: [100],
    readFile: () => {
      throw new Error('ENOENT: no such file');
    },
  });
  assert.equal(r.code, 1);
  assert.match(r.text, /could not read an input/);
});

/* -------------------------------------------------------------- staleness -- */

test('a stale pack warns before it ranks anything', () => {
  const r = picklistFromPack({
    ...base,
    alliance: [100],
    readFile: files(pack()),
    now: () => NOW + 30 * 3_600_000,
  });
  assert.equal(r.code, 0);
  assert.match(r.text, /WARNING: this pack is \d+ h old/);
  assert.match(r.text, /Regenerate it rather than drafting on it/);
});

test('a fresh pack does not cry wolf', () => {
  const r = picklistFromPack({
    ...base,
    alliance: [100],
    readFile: files(pack()),
    now: () => NOW + 20 * 60_000,
  });
  assert.ok(!/WARNING: this pack is/.test(r.text));
});

/* ------------------------------------------------------------ arg parsing -- */

test('the command explains itself, including why the key is required', async () => {
  const usage = await run(['picklist']);
  assert.equal(usage.code, 1);
  assert.match(usage.text, /usage: ledger picklist/);
  assert.match(usage.text, /fabricated-ratings problem/);

  const help = await run([]);
  assert.match(help.text, /ledger picklist/);
  assert.match(help.text, /Runs entirely offline/);
  assert.match(help.text, /Needs no credentials/);
});

test('a malformed --picks-between is rejected before any work happens', async () => {
  const r = await run(['picklist', 'p', '--key', 'k', '--alliance', '100', '--picks-between', 'x']);
  assert.equal(r.code, 1);
  assert.match(r.text, /non-negative whole number/);
});

test('a malformed --alliance is reported as a message, not thrown', async () => {
  const r = await run(['picklist', 'p', '--key', 'k', '--alliance', 'abc']);
  assert.equal(r.code, 1);
  assert.match(r.text, /not a team number/);
});
