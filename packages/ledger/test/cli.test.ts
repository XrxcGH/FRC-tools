import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  fetchEvent,
  makeVenuePack,
  credentialsFromEnv,
  observationsFrom,
  openVenuePack,
  type FetchLike,
  type HttpResponse,
  type FirstMatch,
  type TbaMatch,
} from '../src/index.ts';
import { run } from '../src/main.ts';
import { generateDeviceKey, toHex } from '@courier/core';

const NOW = 1_800_000_000_000;

const TBA_TEAMS = [
  { team_number: 8793, nickname: 'Example A' },
  { team_number: 9143, nickname: 'Example B' },
];

const TBA_MATCHES: TbaMatch[] = [
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
];

const FIRST_TEAMS = [{ teamNumber: 8793, nameShort: 'A' }];
const FIRST_MATCHES: FirstMatch[] = [
  {
    matchNumber: 1,
    tournamentLevel: 'Qualification',
    description: 'Qualification 1',
    postResultTime: '2027-03-05T10:00:00',
    // Deliberately different from TBA, so reconciliation has something to find.
    scoreRedFinal: 90,
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
];

function fakeFetch(): FetchLike {
  return async (url): Promise<HttpResponse> => {
    const json = (v: unknown): HttpResponse => ({
      status: 200,
      headers: {},
      body: new TextEncoder().encode(JSON.stringify(v)),
    });
    if (url.includes('thebluealliance')) {
      if (url.endsWith('/teams')) return json(TBA_TEAMS);
      if (url.endsWith('/matches')) return json(TBA_MATCHES);
    }
    if (url.includes('frc-api')) {
      if (url.includes('/teams')) return json({ teams: FIRST_TEAMS });
      if (url.includes('/matches/')) return json({ Matches: FIRST_MATCHES });
    }
    return { status: 404, headers: {}, body: new Uint8Array() };
  };
}

function collector(): { write: (p: string, b: Uint8Array) => void; files: Map<string, Uint8Array> } {
  const files = new Map<string, Uint8Array>();
  return { write: (p, b) => files.set(p.replace(/\\/g, '/'), b), files };
}

/* ------------------------------------------------------------ credentials -- */

test('credentials come from the environment, and their absence is explained', async () => {
  assert.deepEqual(credentialsFromEnv({ TBA_AUTH_KEY: 'k' }), {
    tbaKey: 'k',
    firstUser: undefined,
    firstToken: undefined,
  });

  const r = await fetchEvent({
    eventKey: '2027mose',
    outDir: 'out',
    credentials: {},
    fetch: fakeFetch(),
    now: () => NOW,
    writeFile: () => {},
  });
  assert.equal(r.code, 1);
  assert.match(r.text, /TBA_AUTH_KEY/);
  assert.match(r.text, /Both are free and self-serve/);
});

/* ------------------------------------------------------------------ fetch -- */

test('fetching both sources reconciles them and reports the disagreement', async () => {
  const c = collector();
  const r = await fetchEvent({
    eventKey: '2027mose',
    outDir: 'out',
    credentials: { tbaKey: 'k', firstUser: 'u', firstToken: 't' },
    fetch: fakeFetch(),
    now: () => NOW,
    writeFile: c.write,
  });

  assert.equal(r.code, 0);
  assert.match(r.text, /sources: tba \+ first/);
  assert.match(r.text, /score-mismatch/, 'the planted disagreement must surface');
  assert.match(r.text, /TBA 88-91, FIRST 90-91/);

  // Files landed, namespaced by event, with the manifest and attribution.
  assert.ok([...c.files.keys()].some((p) => p.endsWith('2027mose/index.json')));
  assert.ok([...c.files.keys()].some((p) => p.endsWith('2027mose/ATTRIBUTION.txt')));
  assert.ok([...c.files.keys()].some((p) => p.includes('matches-') && p.endsWith('.csv')));

  const manifest = JSON.parse(
    new TextDecoder().decode([...c.files.entries()].find(([p]) => p.endsWith('index.json'))![1]),
  ) as { conflicts: number; sources: string[] };
  assert.equal(manifest.conflicts, 1, 'the manifest records that something disagreed');
  assert.deepEqual(manifest.sources, ['tba', 'first']);
});

test('one source still works, and says plainly that nothing was cross-checked', async () => {
  // Refusing to run for a team that only has a TBA key would be worse than
  // running and being honest about what the result is worth.
  const c = collector();
  const r = await fetchEvent({
    eventKey: '2027mose',
    outDir: 'out',
    credentials: { tbaKey: 'k' },
    fetch: fakeFetch(),
    now: () => NOW,
    writeFile: c.write,
  });

  assert.equal(r.code, 0);
  assert.match(r.text, /sources: tba$/m);
  assert.match(r.text, /NOTHING was cross-checked/);
  assert.ok(c.files.size > 0);
});

test('an upstream failure is reported against the source that failed', async () => {
  const r = await fetchEvent({
    eventKey: '2027mose',
    outDir: 'out',
    credentials: { tbaKey: 'k' },
    fetch: async () => ({ status: 401, headers: {}, body: new Uint8Array() }),
    now: () => NOW,
    writeFile: () => {},
  });
  assert.equal(r.code, 1);
  assert.match(r.text, /^tba:/);
  assert.match(r.text, /401/);
});

/* ------------------------------------------------------------- venue pack -- */

test('a venue pack is signed, and carries no ratings rather than fake ones', async () => {
  const signer = generateDeviceKey('software');
  const c = collector();

  const r = await makeVenuePack({
    eventKey: '2027mose',
    outDir: 'out',
    outFile: 'out/2027mose.pack',
    credentials: { tbaKey: 'k' },
    fetch: fakeFetch(),
    now: () => NOW,
    writeFile: c.write,
    signer,
    seasonPackId: 'example-synthetic@1.0.0',
  });

  assert.equal(r.code, 0);
  assert.match(r.text, /No ratings were supplied/);
  assert.match(r.text, /worse than one with none/);

  const bytes = [...c.files.entries()].find(([p]) => p.endsWith('.pack'))![1];
  const { pack } = openVenuePack(bytes, (kid) =>
    toHex(kid) === toHex(signer.kid) ? signer.publicKey : undefined,
  );
  assert.equal(pack.eventKey, '2027mose');
  assert.equal(pack.ratings.length, 0);
  assert.equal(pack.teams.length, 2);
  assert.match(pack.attribution, /The Blue Alliance/);
});

test('observations come only from played matches', () => {
  // Treating a missing result as a zero would drag every team on that alliance
  // down, which is worse than having no observation at all.
  const obs = observationsFrom([
    { match: 1, red: [1, 2, 3], blue: [4, 5, 6], redScore: 80, blueScore: 70 },
    { match: 2, red: [1, 4, 5], blue: [2, 3, 6] }, // unplayed
    { match: 3, red: [1, 3, 5], blue: [2, 4, 6], redScore: 0, blueScore: 0 }, // real 0-0
  ]);
  assert.equal(obs.length, 4, 'two alliances each from the two played matches');
  assert.ok(obs.some((o) => o.score === 0), 'a genuine shutout is an observation');
});

test('--ratings on a thin event omits everyone and says why', async () => {
  // One played match means every team has a single appearance. An estimate from
  // that, formatted like a real one, is how a picklist ends up ranking noise.
  const signer = generateDeviceKey('software');
  const c = collector();

  const r = await makeVenuePack({
    eventKey: '2027mose',
    outDir: 'out',
    outFile: 'out/thin.pack',
    credentials: { tbaKey: 'k' },
    fetch: fakeFetch(),
    now: () => NOW,
    writeFile: c.write,
    signer,
    seasonPackId: 'x@1.0.0',
    computeRatings: true,
  });

  assert.equal(r.code, 0);
  assert.match(r.text, /omitted for fewer than 4 appearances|nothing to fit/);

  const bytes = [...c.files.entries()].find(([p]) => p.endsWith('.pack'))![1];
  const { pack } = openVenuePack(bytes, (kid) =>
    toHex(kid) === toHex(signer.kid) ? signer.publicKey : undefined,
  );
  assert.equal(pack.ratings.length, 0, 'no ratings rather than unreliable ones');
});

test('supplied ratings survive into the pack with their uncertainty', async () => {
  const signer = generateDeviceKey('software');
  const c = collector();

  await makeVenuePack({
    eventKey: '2027mose',
    outDir: 'out',
    outFile: 'out/p.pack',
    credentials: { tbaKey: 'k' },
    fetch: fakeFetch(),
    now: () => NOW,
    writeFile: c.write,
    signer,
    seasonPackId: 'x@1.0.0',
    ratings: [{ team: 8793, mean: 42.5, sigma: 6.25, matchesPlayed: 8 }],
  });

  const bytes = [...c.files.entries()].find(([p]) => p.endsWith('.pack'))![1];
  const { pack } = openVenuePack(bytes, (kid) =>
    toHex(kid) === toHex(signer.kid) ? signer.publicKey : undefined,
  );
  assert.equal(pack.ratings[0]!.sigma, 6.25);
});

/* ------------------------------------------------------------ arg parsing -- */

test('the arg parser explains itself and rejects incomplete commands', async () => {
  const help = await run([]);
  assert.equal(help.code, 0);
  assert.match(help.text, /ledger fetch/);
  assert.match(help.text, /free and self-serve/);

  assert.equal((await run(['fetch'])).code, 1);
  assert.equal((await run(['pack', '2027mose'])).code, 1);
  assert.match((await run(['frobnicate'])).text, /unknown command/);
});

test('pack fetches each source once and reports the cross-check', async () => {
  // The defect this exists for. makeVenuePack called fetchEvent with a no-op
  // writeFile, checked only its exit code, and never read its text — the sole
  // place the TBA/FIRST cross-check is ever rendered. Every disagreement found
  // during a `ledger pack` run was computed and thrown away. It then built a
  // fresh client and fetched the same TBA event AGAIN, doubling the load on a
  // service run by four unpaid trustees.
  const hits: string[] = [];
  const inner = fakeFetch();
  const counting: FetchLike = async (url, init) => {
    hits.push(url);
    return inner(url, init);
  };

  const r = await makeVenuePack({
    eventKey: '2027mose',
    outDir: 'out',
    outFile: 'out/2027mose.pack',
    credentials: { tbaKey: 'k', firstUser: 'u', firstToken: 't' },
    fetch: counting,
    now: () => NOW,
    writeFile: () => {},
    signer: generateDeviceKey('software'),
    seasonPackId: 'example-synthetic@1.0.0',
  });
  assert.equal(r.code, 0, r.text);

  const tbaHits = hits.filter((u) => u.includes('thebluealliance'));
  const perPath = new Map<string, number>();
  for (const u of tbaHits) perPath.set(u, (perPath.get(u) ?? 0) + 1);
  for (const [url, n] of perPath) {
    assert.equal(n, 1, `fetched ${url} ${n} times — the pack re-fetched what it already had`);
  }

  // And it names both sources rather than claiming TBA alone.
  assert.match(r.text, /sources: tba \+ first/);
});
