import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SOURCES,
  attributionFor,
  PoliteClient,
  MemoryCache,
  SourceError,
  buildVenuePack,
  openVenuePack,
  describeStaleness,
  VenuePackError,
  type FetchLike,
  type Clock,
  type HttpResponse,
} from '../src/index.ts';
import { generateDeviceKey, packMatch, toHex } from '@courier/core';

/* ------------------------------------------------------------- harness ---- */

/** A clock that never actually waits, so retry behaviour is tested instantly. */
function fakeClock(): Clock & { elapsed: number } {
  const c = {
    elapsed: 0,
    now: () => c.elapsed,
    sleep: async (ms: number) => {
      c.elapsed += ms;
    },
  };
  return c;
}

function response(
  status: number,
  body = '',
  headers: Record<string, string> = {},
): HttpResponse {
  return { status, headers, body: new TextEncoder().encode(body) };
}

function scriptedFetch(script: HttpResponse[]): FetchLike & { calls: Array<Record<string, string>> } {
  const calls: Array<Record<string, string>> = [];
  const fn = (async (_url: string, init: { headers: Record<string, string> }) => {
    calls.push(init.headers);
    const next = script.shift();
    if (!next) throw new Error('fetch called more times than the script allows');
    return next;
  }) as FetchLike & { calls: Array<Record<string, string>> };
  fn.calls = calls;
  return fn;
}

const KEY = { token: 'test-key' };

/* -------------------------------------------------------------- sources --- */

test('every source declares a self-imposed rate, since none publishes one', () => {
  for (const s of Object.values(SOURCES)) {
    assert.ok(s.requestsPerSecond > 0 && s.requestsPerSecond <= 3, `${s.id} rate is conservative`);
    assert.ok(s.notes.length > 40, `${s.id} explains its constraints`);
  }
  // Statbotics is one unpaid maintainer whose guidance is "be nice to our
  // servers" — it must be the slowest of the three.
  assert.ok(SOURCES.statbotics.requestsPerSecond < SOURCES.tba.requestsPerSecond);
});

test('FIRST attribution is mandatory and lands in the emitted block', () => {
  assert.equal(SOURCES.first.attribution, 'Event Data provided by FIRST');
  const text = attributionFor(['tba', 'first']);
  assert.match(text, /Event Data provided by FIRST/);
  assert.match(text, /frc-events\.firstinspires\.org/);
  assert.match(text, /generates revenue/, 'the non-commercial condition travels with the data');
  assert.match(text, /The Blue Alliance/);
});

/* --------------------------------------------------------- polite client -- */

test('a first fetch goes to the network and is cached with its validator', async () => {
  const fetch = scriptedFetch([
    response(200, '{"ok":true}', { ETag: 'W/"abc"', 'Cache-Control': 'max-age=60' }),
  ]);
  const clock = fakeClock();
  const client = new PoliteClient('tba', { fetch, clock, credentials: KEY });

  const r = await client.get('/status');
  assert.equal(r.origin, 'network');
  assert.equal(new TextDecoder().decode(r.body), '{"ok":true}');
  assert.equal(fetch.calls[0]!['X-TBA-Auth-Key'], 'test-key');
});

test('a repeat fetch inside the freshness window never leaves the device', async () => {
  const fetch = scriptedFetch([
    response(200, 'body', { ETag: '"v1"', 'Cache-Control': 'max-age=300' }),
  ]);
  const clock = fakeClock();
  const client = new PoliteClient('tba', { fetch, clock, credentials: KEY });

  await client.get('/x');
  const second = await client.get('/x');

  assert.equal(second.origin, 'fresh-cache');
  assert.equal(client.stats.freshCacheHits, 1);
  assert.equal(client.stats.requests, 1, 'the upstream saw exactly one request');
});

test('past the freshness window it revalidates, and a 304 costs one round trip', async () => {
  const fetch = scriptedFetch([
    response(200, 'body', { ETag: '"v1"', 'Cache-Control': 'max-age=10' }),
    response(304, '', { 'Cache-Control': 'max-age=10' }),
  ]);
  const clock = fakeClock();
  const client = new PoliteClient('tba', { fetch, clock, credentials: KEY });

  await client.get('/x');
  clock.elapsed += 20_000;
  const second = await client.get('/x');

  assert.equal(second.origin, 'revalidated');
  assert.equal(new TextDecoder().decode(second.body), 'body', 'the cached body is served');
  assert.equal(fetch.calls[1]!['If-None-Match'], '"v1"');
  assert.equal(client.stats.revalidations, 1);
});

test('FIRST uses If-Modified-Since, not ETag', async () => {
  const fetch = scriptedFetch([
    response(200, 'x', { 'Last-Modified': 'Wed, 21 Oct 2026 07:28:00 GMT' }),
    response(304),
  ]);
  const clock = fakeClock();
  const client = new PoliteClient('first', {
    fetch,
    clock,
    credentials: { username: 'u', token: 't' },
  });

  await client.get('/teams');
  await client.get('/teams');

  assert.equal(fetch.calls[1]!['If-Modified-Since'], 'Wed, 21 Oct 2026 07:28:00 GMT');
  assert.ok(!('If-None-Match' in fetch.calls[1]!));
  assert.match(fetch.calls[0]!['Authorization']!, /^Basic /);
});

test('the token bucket paces requests at the source rate', async () => {
  const fetch = scriptedFetch([response(200, 'a'), response(200, 'b'), response(200, 'c')]);
  const clock = fakeClock();
  // 3 rps for TBA -> ~333 ms between requests.
  const client = new PoliteClient('tba', { fetch, clock, credentials: KEY });

  await client.get('/a');
  await client.get('/b');
  await client.get('/c');

  assert.ok(clock.elapsed >= 666, `expected pacing, only ${clock.elapsed} ms elapsed`);
  assert.ok(client.stats.throttledMs > 0);
});

test('a 429 backs off and retries, and Retry-After is honoured when offered', async () => {
  const fetch = scriptedFetch([
    response(429, '', { 'Retry-After': '2' }),
    response(200, 'finally'),
  ]);
  const clock = fakeClock();
  const client = new PoliteClient('tba', { fetch, clock, credentials: KEY, random: () => 0.5 });

  const r = await client.get('/x');
  assert.equal(new TextDecoder().decode(r.body), 'finally');
  assert.equal(r.attempts, 2);
  assert.equal(client.stats.retries, 1);
  assert.ok(clock.elapsed >= 2000, 'Retry-After: 2 must be respected');
});

test('5xx retries with full jitter, and gives up with a useful error', async () => {
  const fetch = scriptedFetch([
    response(503),
    response(503),
    response(503),
  ]);
  const clock = fakeClock();
  const client = new PoliteClient('tba', {
    fetch,
    clock,
    credentials: KEY,
    random: () => 0.9,
    maxAttempts: 3,
  });

  await assert.rejects(
    () => client.get('/x'),
    (err: unknown) => {
      assert.ok(err instanceof SourceError);
      assert.equal((err as SourceError).status, 503);
      assert.match((err as Error).message, /after 3 attempts/);
      return true;
    },
  );
  assert.equal(client.stats.retries, 2, 'two waits between three attempts');
});

test('a 4xx is not retried — repeating our own mistake is noise the upstream did not ask for', async () => {
  const fetch = scriptedFetch([response(404)]);
  const clock = fakeClock();
  const client = new PoliteClient('tba', { fetch, clock, credentials: KEY });

  await assert.rejects(() => client.get('/nope'), /returned 404/);
  assert.equal(client.stats.retries, 0);
  assert.equal(client.stats.requests, 1);
});

test('missing credentials fail before any request is made', async () => {
  const fetch = scriptedFetch([]);
  const client = new PoliteClient('tba', { fetch, clock: fakeClock() });
  await assert.rejects(() => client.get('/x'), /needs an API key/);
  assert.equal(fetch.calls.length, 0);
});

test('the cache is pluggable so a real deployment can persist it', async () => {
  const cache = new MemoryCache();
  const clock = fakeClock();
  const a = new PoliteClient('tba', {
    fetch: scriptedFetch([response(200, 'shared', { 'Cache-Control': 'max-age=600' })]),
    clock,
    cache,
    credentials: KEY,
  });
  await a.get('/x');

  // A second client sharing the cache does not re-fetch.
  const b = new PoliteClient('tba', { fetch: scriptedFetch([]), clock, cache, credentials: KEY });
  const r = await b.get('/x');
  assert.equal(r.origin, 'fresh-cache');
  assert.equal(cache.size, 1);
});

/* ----------------------------------------------------------- venue packs -- */

const signer = generateDeviceKey('software');
const resolver = (kid: Uint8Array) =>
  toHex(kid) === toHex(signer.kid) ? signer.publicKey : undefined;

const PACK_INPUT = {
  eventKey: '2027mose',
  generatedAt: 1_800_000_000_000,
  officialResultsAsOfMatch: packMatch({ level: 'qm', set: 0, number: 42 }),
  sources: ['tba', 'first'] as const,
  seasonPackId: 'example-synthetic@1.0.0',
  teams: [
    { team: 8793, nickname: 'Example A' },
    { team: 9143, nickname: 'Example B' },
  ],
  matches: [
    {
      match: packMatch({ level: 'qm', set: 0, number: 42 }),
      red: [8793, 254, 118],
      blue: [9143, 1678, 2056],
      redScore: 88,
      blueScore: 91,
    },
    {
      match: packMatch({ level: 'qm', set: 0, number: 43 }),
      red: [9143, 118, 254],
      blue: [8793, 2056, 1678],
    },
  ],
  ratings: [
    { team: 8793, mean: 42.5, sigma: 6.25, matchesPlayed: 8 },
    { team: 9143, mean: 51.125, sigma: 4.5, matchesPlayed: 9 },
  ],
};

test('a venue pack round-trips, preserving scores, ratings, and uncertainty', () => {
  const bytes = buildVenuePack(PACK_INPUT, signer);
  const { pack, digest } = openVenuePack(bytes, resolver);

  assert.equal(pack.eventKey, '2027mose');
  assert.equal(pack.teams.length, 2);
  assert.equal(pack.matches[0]!.redScore, 88);
  assert.equal(pack.ratings[0]!.mean, 42.5);
  assert.equal(pack.ratings[1]!.sigma, 4.5, 'uncertainty survives — a picklist needs it');
  assert.equal(digest.length, 32);
});

test('an unplayed match is distinguishable from a genuine nil-nil result', () => {
  const bytes = buildVenuePack(PACK_INPUT, signer);
  const { pack } = openVenuePack(bytes, resolver);

  assert.equal(pack.matches[1]!.redScore, undefined, 'not yet played');
  assert.ok('redScore' in pack.matches[0]!, 'played');

  const withZero = buildVenuePack(
    { ...PACK_INPUT, matches: [{ ...PACK_INPUT.matches[0]!, redScore: 0, blueScore: 0 }] },
    signer,
  );
  assert.equal(openVenuePack(withZero, resolver).pack.matches[0]!.redScore, 0);
});

test('a pack must name its sources, so attribution cannot be omitted', () => {
  assert.throws(
    () => buildVenuePack({ ...PACK_INPUT, sources: [] }, signer),
    /name its sources/,
  );
  const { pack } = openVenuePack(buildVenuePack(PACK_INPUT, signer), resolver);
  assert.match(pack.attribution, /Event Data provided by FIRST/);
});

test('a tampered or foreign-signed pack is refused', () => {
  const bytes = buildVenuePack(PACK_INPUT, signer);

  // Unlike a Courier bundle, a venue pack is one aggregate assertion, so the
  // container itself is what has to be authenticated.
  assert.throws(() => openVenuePack(bytes, () => undefined), /unknown key/);

  const stranger = generateDeviceKey();
  const foreign = buildVenuePack(PACK_INPUT, stranger);
  assert.throws(() => openVenuePack(foreign, resolver), /unknown key/);

  const tampered = bytes.slice();
  tampered[tampered.length - 20]! ^= 0x01;
  assert.throws(() => openVenuePack(tampered, resolver), VenuePackError);
});

test('staleness is reported concretely enough to put on a banner', () => {
  const bytes = buildVenuePack(PACK_INPUT, signer);
  const { pack } = openVenuePack(bytes, resolver);

  const fresh = describeStaleness(pack, pack.generatedAt + 30 * 60_000);
  assert.match(fresh.ageLabel, /min old/);
  assert.equal(fresh.resultsIncomplete, false);

  const overnight = describeStaleness(pack, pack.generatedAt + 14 * 3_600_000);
  assert.match(overnight.ageLabel, /h old/);

  const ancient = describeStaleness(pack, pack.generatedAt + 5 * 24 * 3_600_000);
  assert.match(ancient.ageLabel, /days old/);
});

test('a pit with no uplink is told its analysis is running unconstrained', () => {
  // The hole the design review found: Saturday's official totals cannot reach a
  // pit with no internet, so anything depending on them is unconstrained until
  // someone physically carries results in.
  const bytes = buildVenuePack(PACK_INPUT, signer);
  const { pack } = openVenuePack(bytes, resolver);

  const played = packMatch({ level: 'qm', set: 0, number: 68 });
  const s = describeStaleness(pack, pack.generatedAt + 6 * 3_600_000, played);

  assert.ok(s.matchesBehind > 0);
  assert.equal(s.resultsIncomplete, true, 'the UI must be able to say so');
});
