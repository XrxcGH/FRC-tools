import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  FirstClient,
  FirstApiError,
  PoliteClient,
  splitEventKey,
  compLevelFor,
  normaliseFirstMatches,
  normaliseFirstTeams,
  reconcileSnapshots,
  summariseConflicts,
  type FetchLike,
  type HttpResponse,
  type FirstMatch,
  type MatchEntry,
} from '../src/index.ts';
import { packMatch, unpackMatch } from '@courier/core';

const clock = { now: () => 0, sleep: async () => {} };
const qm = (n: number) => packMatch({ level: 'qm', set: 0, number: n });

/* ------------------------------------------------------------- identity --- */

test('a TBA event key splits into the year and code FIRST expects', () => {
  assert.deepEqual(splitEventKey('2027mose'), { year: 2027, code: 'MOSE' });
  assert.deepEqual(splitEventKey('2027wamo'), { year: 2027, code: 'WAMO' });
  assert.throws(() => splitEventKey('mose'), FirstApiError);
  assert.throws(() => splitEventKey('2027'), FirstApiError);
});

test('tournament levels map explicitly, and unknown ones map to nothing', () => {
  assert.equal(compLevelFor('Qualification'), 'qm');
  assert.equal(compLevelFor('Playoff'), 'sf');
  assert.equal(compLevelFor('Bananas'), null);
  assert.equal(compLevelFor(undefined), null);
});

/* -------------------------------------------------------- normalisation --- */

const FIRST_MATCHES: FirstMatch[] = [
  {
    matchNumber: 1,
    tournamentLevel: 'Qualification',
    description: 'Qualification 1',
    postResultTime: '2027-03-05T10:00:00',
    scoreRedFinal: 88,
    scoreBlueFinal: 91,
    teams: [
      { teamNumber: 8793, station: 'Red1' },
      { teamNumber: 254, station: 'Red2' },
      { teamNumber: 118, station: 'Red3' },
      { teamNumber: 9143, station: 'Blue1' },
      { teamNumber: 1678, station: 'Blue2' },
      { teamNumber: 2056, station: 'Blue3' },
    ],
  },
  {
    matchNumber: 2,
    tournamentLevel: 'Qualification',
    description: 'Qualification 2',
    postResultTime: null,
    scoreRedFinal: null,
    scoreBlueFinal: null,
    teams: [
      { teamNumber: 9143, station: 'Red1' },
      { teamNumber: 118, station: 'Red2' },
      { teamNumber: 254, station: 'Red3' },
      { teamNumber: 8793, station: 'Blue1' },
      { teamNumber: 2056, station: 'Blue2' },
      { teamNumber: 1678, station: 'Blue3' },
    ],
  },
];

test('FIRST matches normalise, and stations sort into alliances', () => {
  const { matches, skipped } = normaliseFirstMatches(FIRST_MATCHES);
  assert.equal(skipped.length, 0);
  assert.deepEqual(matches[0]!.red, [8793, 254, 118]);
  assert.deepEqual(matches[0]!.blue, [9143, 1678, 2056]);
  assert.equal(matches[0]!.redScore, 88);
  assert.equal(matches[1]!.redScore, undefined, 'no post-result time means not played');
});

test('an unmapped level is skipped and reported rather than guessed', () => {
  const { matches, skipped } = normaliseFirstMatches([
    ...FIRST_MATCHES,
    { matchNumber: 1, tournamentLevel: 'Bananas', description: 'weird' },
    { matchNumber: 3, tournamentLevel: 'Qualification', description: 'no teams' },
  ]);
  assert.equal(matches.length, 2);
  assert.equal(skipped.length, 2);
  assert.ok(skipped.some((s) => /unmapped tournament level/.test(s)));
  assert.ok(skipped.some((s) => /missing an alliance roster/.test(s)));
});

test('teams normalise with a fallback nickname', () => {
  const teams = normaliseFirstTeams([
    { teamNumber: 254, nameShort: 'Example' },
    { teamNumber: 118 },
    { nameShort: 'orphan' },
  ]);
  assert.deepEqual(teams.map((t) => t.team), [118, 254]);
  assert.equal(teams[0]!.nickname, 'Team 118');
});

/* ---------------------------------------------------------- the client --- */

function jsonFetch(routes: Record<string, unknown>): FetchLike & { hits: string[] } {
  const hits: string[] = [];
  const fn = (async (url: string): Promise<HttpResponse> => {
    hits.push(url);
    for (const [needle, body] of Object.entries(routes)) {
      if (url.includes(needle)) {
        return {
          status: 200,
          headers: {},
          body: new TextEncoder().encode(JSON.stringify(body)),
        };
      }
    }
    return { status: 404, headers: {}, body: new Uint8Array() };
  }) as FetchLike & { hits: string[] };
  fn.hits = hits;
  return fn;
}

test('the FIRST client addresses the year-and-code URL shape', async () => {
  const fetch = jsonFetch({
    '/teams': { teams: [{ teamNumber: 8793, nameShort: 'A' }] },
    '/matches/': { Matches: FIRST_MATCHES },
  });
  const client = new FirstClient(
    new PoliteClient('first', { fetch, clock, credentials: { username: 'u', token: 't' } }),
  );
  const snap = await client.eventSnapshot('2027mose');

  assert.ok(fetch.hits.some((u) => u.includes('/2027/teams?eventCode=MOSE')));
  assert.ok(fetch.hits.some((u) => u.includes('/2027/matches/MOSE')));
  assert.equal(snap.matches.length, 2);
});

test('an unexpected FIRST response shape is an error, not an empty event', async () => {
  const fetch = jsonFetch({ '/teams': { teams: 'nope' }, '/matches/': { Matches: [] } });
  const client = new FirstClient(
    new PoliteClient('first', { fetch, clock, credentials: { username: 'u', token: 't' } }),
  );
  await assert.rejects(() => client.eventSnapshot('2027mose'), /unexpected teams response/);
});

/* -------------------------------------------------------- reconciliation -- */

const base = (n: number, red: number[], blue: number[], scores?: [number, number]): MatchEntry => ({
  match: qm(n),
  red,
  blue,
  ...(scores ? { redScore: scores[0], blueScore: scores[1] } : {}),
});

test('agreeing sources reconcile clean, with no conflicts invented', () => {
  const matches = [base(1, [1, 2, 3], [4, 5, 6], [50, 60]), base(2, [4, 5, 6], [1, 2, 3])];
  const out = reconcileSnapshots({
    eventKey: '2027mose',
    tbaTeams: [{ team: 1, nickname: 'One' }],
    tbaMatches: matches,
    firstTeams: [{ team: 1, nickname: 'Uno' }],
    firstMatches: matches,
  });

  assert.equal(out.clean, true);
  assert.equal(out.conflicts.length, 0);
  assert.equal(out.matches.length, 2);
  assert.equal(summariseConflicts(out.conflicts), '');
  // TBA nicknames win for display.
  assert.equal(out.teams[0]!.nickname, 'One');
});

test('a score disagreement is recorded, and FIRST is preferred as the upstream', () => {
  const out = reconcileSnapshots({
    eventKey: '2027mose',
    tbaTeams: [],
    tbaMatches: [base(1, [1, 2, 3], [4, 5, 6], [50, 60])],
    firstTeams: [],
    firstMatches: [base(1, [1, 2, 3], [4, 5, 6], [52, 60])],
  });

  assert.equal(out.clean, false);
  const c = out.conflicts.find((x) => x.kind === 'score-mismatch')!;
  assert.equal(c.preferred, 'first');
  assert.equal(c.tba, '50-60');
  assert.equal(c.first, '52-60');
  assert.match(c.note, /TBA bug worth reporting/);

  // The chosen value is FIRST's, and BOTH are still on the record.
  assert.equal(out.matches[0]!.redScore, 52);
  assert.match(summariseConflicts(out.conflicts), /score-mismatch/);
});

test('a roster disagreement is recorded, and TBA is preferred for identity', () => {
  const out = reconcileSnapshots({
    eventKey: '2027mose',
    tbaTeams: [],
    tbaMatches: [base(1, [1, 2, 3], [4, 5, 6])],
    firstTeams: [],
    firstMatches: [base(1, [1, 2, 9], [4, 5, 6])],
  });

  const c = out.conflicts.find((x) => x.kind === 'roster-mismatch')!;
  assert.equal(c.preferred, 'tba');
  assert.deepEqual(out.matches[0]!.red, [1, 2, 3]);
  assert.match(c.note, /replay or a substitution/);
});

test('alliance order does not count as a disagreement', () => {
  // Station order is not roster identity; flagging it would bury the real
  // conflicts under noise on every single match.
  const out = reconcileSnapshots({
    eventKey: '2027mose',
    tbaTeams: [],
    tbaMatches: [base(1, [1, 2, 3], [4, 5, 6])],
    firstTeams: [],
    firstMatches: [base(1, [3, 1, 2], [6, 4, 5])],
  });
  assert.equal(out.conflicts.length, 0);
});

test('one source lagging on results is flagged as presence, not as a wrong score', () => {
  const out = reconcileSnapshots({
    eventKey: '2027mose',
    tbaTeams: [],
    tbaMatches: [base(1, [1, 2, 3], [4, 5, 6])],
    firstTeams: [],
    firstMatches: [base(1, [1, 2, 3], [4, 5, 6], [50, 60])],
  });

  const c = out.conflicts.find((x) => x.kind === 'result-presence-mismatch')!;
  assert.equal(c.preferred, 'first');
  assert.equal(out.matches[0]!.redScore, 50, 'the result that exists is used');
  assert.match(c.note, /suspicious hours later/);
});

test('a match missing from one source is kept, not silently dropped', () => {
  const out = reconcileSnapshots({
    eventKey: '2027mose',
    tbaTeams: [],
    tbaMatches: [base(1, [1, 2, 3], [4, 5, 6]), base(2, [4, 5, 6], [1, 2, 3])],
    firstTeams: [],
    firstMatches: [base(1, [1, 2, 3], [4, 5, 6])],
  });

  assert.equal(out.matches.length, 2, 'dropping it would silently shrink the event');
  const c = out.conflicts.find((x) => x.kind === 'missing-from-source')!;
  assert.equal(c.preferred, 'tba');
});

test('elimination matches are reported unreconcilable rather than matched hopefully', () => {
  // FIRST's tournamentLevel carries no set number, so aligning elims would mean
  // guessing. Saying so beats a confident wrong join.
  const sf = packMatch({ level: 'sf', set: 1, number: 2 });
  const out = reconcileSnapshots({
    eventKey: '2027mose',
    tbaTeams: [],
    tbaMatches: [{ match: sf, red: [1, 2, 3], blue: [4, 5, 6], redScore: 70, blueScore: 60 }],
    firstTeams: [],
    firstMatches: [],
  });

  const c = out.conflicts.find((x) => x.kind === 'unreconcilable-level')!;
  assert.ok(c, 'the limitation must be surfaced');
  assert.match(c.note, /NOT\s+cross-checked/);
  assert.equal(unpackMatch(out.matches[0]!.match).level, 'sf');
  assert.equal(out.matches[0]!.redScore, 70, 'the data is still carried');
});

test('the summary leads with the disagreements worth chasing', () => {
  const out = reconcileSnapshots({
    eventKey: '2027mose',
    tbaTeams: [],
    tbaMatches: [base(1, [1, 2, 3], [4, 5, 6], [50, 60]), base(2, [1, 2, 3], [4, 5, 6], [10, 20])],
    firstTeams: [],
    firstMatches: [base(1, [1, 2, 3], [4, 5, 6], [52, 60]), base(2, [1, 2, 3], [4, 5, 6], [10, 20])],
  });

  const text = summariseConflicts(out.conflicts);
  assert.match(text, /1 disagreement/);
  assert.match(text, /both sources claim an official total/);
  assert.match(text, /Q1: TBA 50-60, FIRST 52-60/);
});
