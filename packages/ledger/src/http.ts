/**
 * A deliberately polite HTTP client.
 *
 * None of the three FRC data sources publishes a rate limit, an SLA, or a
 * status page. That absence is not permission — The Blue Alliance runs the
 * archive of record on roughly $5,000 a year and four unpaid trustees, and
 * FIRST can revoke API access "for any or all Users" at any time. So this
 * client is built to be the well-behaved client those services never got to
 * specify:
 *
 *   - a token bucket per source, at a self-imposed rate;
 *   - conditional requests always, so a repeat fetch costs the upstream a 304;
 *   - a local freshness window, so a repeat fetch inside it costs them nothing;
 *   - exponential backoff with full jitter on 429 and 5xx;
 *   - no retries on 4xx, because retrying a client error is just noise.
 *
 * Everything external is injected — fetch, clock, and jitter — so the retry and
 * rate-limit behaviour is tested deterministically rather than by waiting.
 */

import { SOURCES, SourceError, type SourceId, type SourceProfile } from './sources.ts';

export interface HttpResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: Uint8Array;
}

export type FetchLike = (
  url: string,
  init: { headers: Record<string, string> },
) => Promise<HttpResponse>;

export interface Clock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

export const systemClock: Clock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
};

export interface CacheEntry {
  readonly etag?: string;
  readonly lastModified?: string;
  readonly body: Uint8Array;
  /** When we last confirmed this entry to be current. */
  readonly validatedAt: number;
  /** Seconds the upstream told us it stays fresh. */
  readonly maxAge: number;
}

/** Pluggable so a real deployment can persist it; in-memory by default. */
export interface ConditionalCache {
  get(key: string): CacheEntry | undefined;
  set(key: string, entry: CacheEntry): void;
}

export class MemoryCache implements ConditionalCache {
  readonly #m = new Map<string, CacheEntry>();
  get(key: string): CacheEntry | undefined {
    return this.#m.get(key);
  }
  set(key: string, entry: CacheEntry): void {
    this.#m.set(key, entry);
  }
  get size(): number {
    return this.#m.size;
  }
}

export interface Credentials {
  /** TBA read key, or FIRST `username:token`. */
  readonly token?: string;
  readonly username?: string;
}

export interface PoliteClientOptions {
  readonly fetch: FetchLike;
  readonly clock?: Clock;
  readonly cache?: ConditionalCache;
  readonly credentials?: Credentials;
  /** Returns a value in [0,1). Injected so backoff jitter is testable. */
  readonly random?: () => number;
  readonly maxAttempts?: number;
  readonly baseBackoffMs?: number;
  readonly maxBackoffMs?: number;
}

export interface GetResult {
  readonly body: Uint8Array;
  /** How the body was obtained — the number that matters for upstream cost. */
  readonly origin: 'fresh-cache' | 'revalidated' | 'network';
  readonly status: number;
  readonly attempts: number;
}

export interface ClientStats {
  requests: number;
  freshCacheHits: number;
  revalidations: number;
  networkBodies: number;
  retries: number;
  throttledMs: number;
}

const DEFAULT_MAX_ATTEMPTS = 5;
const DEFAULT_BASE_BACKOFF = 500;
const DEFAULT_MAX_BACKOFF = 30_000;

export class PoliteClient {
  readonly profile: SourceProfile;
  readonly stats: ClientStats = {
    requests: 0,
    freshCacheHits: 0,
    revalidations: 0,
    networkBodies: 0,
    retries: 0,
    throttledMs: 0,
  };

  readonly #fetch: FetchLike;
  readonly #clock: Clock;
  readonly #cache: ConditionalCache;
  readonly #credentials: Credentials;
  readonly #random: () => number;
  readonly #maxAttempts: number;
  readonly #baseBackoff: number;
  readonly #maxBackoff: number;
  /** Earliest time the token bucket permits another request. */
  #nextAllowedAt = 0;

  constructor(source: SourceId | SourceProfile, opts: PoliteClientOptions) {
    this.profile = typeof source === 'string' ? SOURCES[source] : source;
    this.#fetch = opts.fetch;
    this.#clock = opts.clock ?? systemClock;
    this.#cache = opts.cache ?? new MemoryCache();
    this.#credentials = opts.credentials ?? {};
    this.#random = opts.random ?? Math.random;
    this.#maxAttempts = opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
    this.#baseBackoff = opts.baseBackoffMs ?? DEFAULT_BASE_BACKOFF;
    this.#maxBackoff = opts.maxBackoffMs ?? DEFAULT_MAX_BACKOFF;
  }

  #authHeaders(): Record<string, string> {
    const a = this.profile.auth;
    if (a.kind === 'none') return {};
    if (a.kind === 'header') {
      if (!this.#credentials.token) {
        throw new SourceError(this.profile.id, `${this.profile.name} needs an API key`);
      }
      return { [a.header]: this.#credentials.token };
    }
    const { username, token } = this.#credentials;
    if (!username || !token) {
      throw new SourceError(this.profile.id, `${this.profile.name} needs a username and token`);
    }
    const basic = Buffer.from(`${username}:${token}`).toString('base64');
    return { Authorization: `Basic ${basic}` };
  }

  /** Wait for the token bucket. Serialised per client, which is per source. */
  async #throttle(): Promise<void> {
    const interval = 1000 / this.profile.requestsPerSecond;
    const now = this.#clock.now();
    const readyAt = Math.max(now, this.#nextAllowedAt);
    const wait = readyAt - now;
    if (wait > 0) {
      this.stats.throttledMs += wait;
      await this.#clock.sleep(wait);
    }
    this.#nextAllowedAt = readyAt + interval;
  }

  /** Full jitter: sleep uniformly in [0, exponential], not exactly at it. */
  #backoffFor(attempt: number): number {
    const ceiling = Math.min(this.#maxBackoff, this.#baseBackoff * 2 ** (attempt - 1));
    return Math.floor(this.#random() * ceiling);
  }

  async get(path: string): Promise<GetResult> {
    const url = path.startsWith('http') ? path : `${this.profile.baseUrl}${path}`;
    const cached = this.#cache.get(url);
    const now = this.#clock.now();

    // Freshness window. A repeat fetch inside it never leaves the device, which
    // is the only request that costs the upstream literally nothing.
    if (cached && now - cached.validatedAt < cached.maxAge * 1000) {
      this.stats.freshCacheHits++;
      return { body: cached.body, origin: 'fresh-cache', status: 200, attempts: 0 };
    }

    const headers: Record<string, string> = {
      Accept: 'application/json',
      ...this.#authHeaders(),
    };
    if (cached) {
      if (this.profile.conditional === 'etag' && cached.etag) {
        headers['If-None-Match'] = cached.etag;
      } else if (this.profile.conditional === 'last-modified' && cached.lastModified) {
        headers['If-Modified-Since'] = cached.lastModified;
      }
    }

    let lastStatus = 0;
    for (let attempt = 1; attempt <= this.#maxAttempts; attempt++) {
      await this.#throttle();
      this.stats.requests++;

      const res = await this.#fetch(url, { headers });
      lastStatus = res.status;

      if (res.status === 304) {
        if (!cached) {
          throw new SourceError(this.profile.id, '304 with no cached entry to serve', 304);
        }
        this.stats.revalidations++;
        this.#cache.set(url, { ...cached, validatedAt: this.#clock.now(), maxAge: maxAgeOf(res, cached.maxAge) });
        return { body: cached.body, origin: 'revalidated', status: 304, attempts: attempt };
      }

      if (res.status === 200) {
        this.stats.networkBodies++;
        this.#cache.set(url, {
          etag: header(res, 'etag'),
          lastModified: header(res, 'last-modified'),
          body: res.body,
          validatedAt: this.#clock.now(),
          maxAge: maxAgeOf(res, 0),
        });
        return { body: res.body, origin: 'network', status: 200, attempts: attempt };
      }

      const retriable = res.status === 429 || (res.status >= 500 && res.status < 600);
      if (!retriable) {
        // A 4xx is our fault. Retrying it is noise the upstream did not ask for.
        throw new SourceError(
          this.profile.id,
          `${this.profile.name} returned ${res.status} for ${url}`,
          res.status,
        );
      }
      if (attempt === this.#maxAttempts) break;

      // Honour Retry-After when offered; it is the only rate signal any of
      // these services ever actually sends.
      const retryAfter = Number(header(res, 'retry-after') ?? NaN);
      const wait = Number.isFinite(retryAfter) ? retryAfter * 1000 : this.#backoffFor(attempt);
      this.stats.retries++;
      await this.#clock.sleep(wait);
    }

    throw new SourceError(
      this.profile.id,
      `${this.profile.name} failed after ${this.#maxAttempts} attempts (last status ${lastStatus})`,
      lastStatus,
    );
  }

  /** Fetch and parse JSON, keeping the raw bytes in the cache. */
  async getJson<T = unknown>(path: string): Promise<T> {
    const { body } = await this.get(path);
    return JSON.parse(new TextDecoder().decode(body)) as T;
  }
}

function header(res: HttpResponse, name: string): string | undefined {
  for (const [k, v] of Object.entries(res.headers)) {
    if (k.toLowerCase() === name) return v;
  }
  return undefined;
}

function maxAgeOf(res: HttpResponse, fallback: number): number {
  const cc = header(res, 'cache-control');
  if (!cc) return fallback;
  const m = /max-age\s*=\s*(\d+)/i.exec(cc);
  return m ? Number(m[1]) : fallback;
}
