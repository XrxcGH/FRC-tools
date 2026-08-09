import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  TbaClient,
  TbaError,
  PoliteClient,
  normaliseTeams,
  normaliseMatches,
  teamNumberFromKey,
  lastOfficialMatch,
  buildVenuePack,
  openVenuePack,
  describeStaleness,
  type FetchLike,
  type HttpResponse,
  type TbaMatch,
} from '../src/index.ts';
import { generateDeviceKey, unpackMatch, packMatch, toHex } from '@courier/core';

const clock = { now: () => 0, sleep: async () => {} };

function jsonFetch(routes: Record<string, unknown>): FetchLike & { hits: string[] } {
  const hits: string[] = [];
  const fn = (async (url: string): Promise<HttpResponse> => {
    hits.push(url);
    for (const [suffix, body] of Object.entries(routes)) {
      if (url.endsWith(suffix)) {
        return {
          status: 200,
          headers: { 'Cache-Control': 'max-age=60' },
          body: new TextEncoder().encode(JSON.stringify(body)),
        };
      }
    }
    return { status: 404, headers: {}, body: new Uint8Array() };
  }) as FetchLike & { hits: string[] };
  fn.hits = hits;
  return fn;
}

const TEAMS = [
  { key: 'frc8793', nickname: 'Example A' },
  { team_number: 254, nickname: 'Example B' },
  { team_number: 118, name: 'Fallback Name' },
];

const MATCHES: TbaMatch[] = [
  {
    key: '2027mose_qm1',
    comp_level: 'qm',
    match_number: 1,
    actual_time: 1_800_000_000,
    alliances: {
      red: { score: 88, team_keys: ['frc8793', 'frc254', 'frc118'] },
      blue: { score: 91, team_keys: ['frc9143', 'frc1678', 'frc2056'] },
    },
  },
  {
    key: '2027mose_qm2',
    comp_level: 'qm',
    match_number: 2,
    actual_time: null, // not yet played
    alliances: {
      red: { score: -1, team_keys: ['frc9143', 'frc118', 'frc254'] },
      blue: { score: -1, team_keys: ['frc8793', 'frc2056', 'frc1678'] },
    },
  },
  {
    key: '2027mose_sf1m2',
    comp_level: 'sf',
    set_number: 1,
    match_number: 2,
    actual_time: 1_800_009_000,
    alliances: {
      red: { score: 0, team_keys: ['frc254', 'frc8793', 'frc118'] },
      blue: { score: 0, team_keys: ['frc1678', 'frc9143', 'frc2056'] },
    },
  },
];

/* --------------------------------------------------------- normalisation -- */

test('team keys parse, and nicknames fall back sensibly', () => {
  assert.equal(teamNumberFromKey('frc8793'), 8793);
  assert.throws(() => teamNumberFromKey('8793'), TbaError);
  assert.throws(() => teamNumberFromKey('frcABC'), TbaError);

  const teams = normaliseTeams(TEAMS);
  assert.deepEqual(teams.map((t) => t.team), [118, 254, 8793]);
  assert.equal(teams.find((t) => t.team === 118)!.nickname, 'Fallback Name');
});

test('a match with no nickname or number is skipped, not guessed at', () => {
  const teams = normaliseTeams([{ nickname: 'orphan' }, { team_number: 7 }]);
  assert.deepEqual(teams.map((t) => t.team), [7]);
  assert.equal(teams[0]!.nickname, 'Team 7');
});

test('matches normalise, and elimination sets survive', () => {
  const { matches, skipped } = normaliseMatches(MATCHES);
  assert.equal(skipped.length, 0);
  assert.equal(matches.length, 3);

  const sf = matches.find((m) => unpackMatch(m.match).level === 'sf')!;
  assert.deepEqual(unpackMatch(sf.match), { level: 'sf', set: 1, number: 2 });
  assert.deepEqual(sf.red, [254, 8793, 118]);
});

test('an unplayed match is distinguished from a genuine nil-nil', () => {
  // TBA reports -1 for unplayed and 0 for a real shutout, and `actual_time` is
  // the only reliable "has this happened" signal. Conflating them puts a fake
  // 0-0 result into a picklist.
  const { matches } = normaliseMatches(MATCHES);
  const q1 = matches.find((m) => unpackMatch(m.match).number === 1 && unpackMatch(m.match).level === 'qm')!;
  const q2 = matches.find((m) => unpackMatch(m.match).number === 2 && unpackMatch(m.match).level === 'qm')!;
  const sf = matches.find((m) => unpackMatch(m.match).level === 'sf')!;

  assert.equal(q1.redScore, 88);
  assert.equal(q2.redScore, undefined, 'unplayed');
  assert.equal(sf.redScore, 0, 'a real 0-0 is preserved');
});

test('one malformed match does not cost the whole venue pack', () => {
  // The night before an event is the wrong time to fail hard on one bad row.
  const { matches, skipped } = normaliseMatches([
    ...MATCHES,
    { key: '2027mose_qm9', comp_level: 'qm', match_number: 9, alliances: { red: { team_keys: [] } } },
    { comp_level: 'zz', match_number: 1 } as TbaMatch,
    {} as TbaMatch,
  ]);
  assert.equal(matches.length, 3, 'the good matches survive');
  assert.equal(skipped.length, 3, 'and the skips are reported, not swallowed');
  assert.ok(skipped.some((s) => /missing an alliance roster/.test(s)));
});

test('the last official match is the newest one with a result', () => {
  const { matches } = normaliseMatches(MATCHES);
  const last = lastOfficialMatch(matches);
  assert.equal(last, packMatch({ level: 'sf', set: 1, number: 2 }));

  assert.equal(lastOfficialMatch([]), 0);
  assert.equal(lastOfficialMatch([{ match: 1, red: [1], blue: [2] }]), 0, 'no results yet');
});

/* ---------------------------------------------------------------- client -- */

test('an event snapshot costs two requests, not one per match', () => {
  // TBA serves a whole event in one call. Walking match-by-match would be a
  // hundred requests for the same bytes — the behaviour that gets an API key
  // revoked for everyone.
  const fetch = jsonFetch({ '/teams': TEAMS, '/matches': MATCHES });
  const client = new TbaClient(
    new PoliteClient('tba', { fetch, clock, credentials: { token: 'k' } }),
  );

  return client.eventSnapshot('2027mose').then((snap) => {
    assert.equal(fetch.hits.length, 2);
    assert.equal(snap.teams.length, 3);
    assert.equal(snap.matches.length, 3);
    assert.equal(snap.skipped.length, 0);
    assert.ok(snap.lastOfficialMatch > 0);
  });
});

test('a bad event key is refused before any request is made', async () => {
  const fetch = jsonFetch({});
  const client = new TbaClient(
    new PoliteClient('tba', { fetch, clock, credentials: { token: 'k' } }),
  );
  await assert.rejects(() => client.eventSnapshot('nope'), TbaError);
  assert.equal(fetch.hits.length, 0);
});

test('an unexpected response shape is an error, not a silent empty pack', async () => {
  const fetch = jsonFetch({ '/teams': { not: 'an array' }, '/matches': MATCHES });
  const client = new TbaClient(
    new PoliteClient('tba', { fetch, clock, credentials: { token: 'k' } }),
  );
  await assert.rejects(() => client.eventSnapshot('2027mose'), /unexpected teams response/);
});

/* ------------------------------------------------- fetch to venue pack ---- */

test('a snapshot becomes a signed venue pack a pit can use offline', async () => {
  const fetch = jsonFetch({ '/teams': TEAMS, '/matches': MATCHES });
  const client = new TbaClient(
    new PoliteClient('tba', { fetch, clock, credentials: { token: 'k' } }),
  );
  const snap = await client.eventSnapshot('2027mose');

  const signer = generateDeviceKey('software');
  const bytes = buildVenuePack(
    {
      eventKey: snap.eventKey,
      generatedAt: 1_800_000_000_000,
      officialResultsAsOfMatch: snap.lastOfficialMatch,
      sources: ['tba'],
      seasonPackId: 'example-synthetic@1.0.0',
      teams: snap.teams,
      matches: snap.matches,
      ratings: snap.teams.map((t) => ({
        team: t.team,
        mean: 40,
        sigma: 5,
        matchesPlayed: 1,
      })),
    },
    signer,
  );

  const resolver = (kid: Uint8Array) =>
    toHex(kid) === toHex(signer.kid) ? signer.publicKey : undefined;
  const { pack } = openVenuePack(bytes, resolver);

  assert.equal(pack.eventKey, '2027mose');
  assert.equal(pack.teams.length, 3);
  assert.equal(pack.matches.length, 3);
  assert.match(pack.attribution, /The Blue Alliance/);

  // And the pack knows how far behind it is, which is the whole point of
  // carrying it into a room with no internet.
  const stale = describeStaleness(
    pack,
    1_800_000_000_000 + 8 * 3_600_000,
    packMatch({ level: 'f', set: 1, number: 1 }),
  );
  assert.equal(stale.resultsIncomplete, true);
  assert.match(stale.ageLabel, /h old/);
});

test('a second snapshot in the freshness window costs the upstream nothing', async () => {
  const fetch = jsonFetch({ '/teams': TEAMS, '/matches': MATCHES });
  const polite = new PoliteClient('tba', { fetch, clock, credentials: { token: 'k' } });
  const client = new TbaClient(polite);

  await client.eventSnapshot('2027mose');
  await client.eventSnapshot('2027mose');

  assert.equal(fetch.hits.length, 2, 'still only the original two requests');
  assert.equal(polite.stats.freshCacheHits, 2);
});
