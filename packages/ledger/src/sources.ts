/**
 * The upstream FRC data sources, and the constraints each one imposes.
 *
 * These are not configuration knobs. Every number and rule below traces to
 * something documented (or conspicuously undocumented) about a real service,
 * and getting them wrong risks the one thing the whole community shares: FIRST
 * reserves the right to "terminate and discontinue allowing any use of the
 * APIs, API Documentation, and/or Events Data, for any or all Users." A tool
 * that hammers the API does not just break itself.
 */

export type SourceId = 'tba' | 'first' | 'statbotics';

export type AuthScheme =
  | { kind: 'header'; header: string }
  | { kind: 'basic' }
  | { kind: 'none' };

export interface SourceProfile {
  readonly id: SourceId;
  readonly name: string;
  readonly baseUrl: string;
  readonly auth: AuthScheme;
  /**
   * Requests per second we allow ourselves.
   *
   * NONE of these are published limits — none of the three services publishes
   * one. FIRST's terms go further and prohibit exceeding "rate limits as
   * defined in the API Documentation", a clause that references a number which
   * does not exist anywhere. In the absence of a stated contract the only
   * defensible posture is to pick a conservative number, honour caching
   * aggressively, and assume throttling can appear without warning.
   */
  readonly requestsPerSecond: number;
  /** Conditional-request mechanism this source actually supports. */
  readonly conditional: 'etag' | 'last-modified' | 'none';
  /** Text that MUST appear wherever data from this source is published onward. */
  readonly attribution?: string;
  readonly notes: string;
}

export const SOURCES: Readonly<Record<SourceId, SourceProfile>> = {
  tba: {
    id: 'tba',
    name: 'The Blue Alliance',
    baseUrl: 'https://www.thebluealliance.com/api/v3',
    auth: { kind: 'header', header: 'X-TBA-Auth-Key' },
    requestsPerSecond: 3,
    conditional: 'etag',
    notes:
      'No published rate limit, no SLA, no status page. ETag/If-None-Match and Cache-Control ' +
      'are the documented primitives and the only contract available, so honour them ' +
      'aggressively. Run by four unpaid trustees on roughly $5,000 a year: a 304 costs them ' +
      'almost nothing and a 200 costs them real money.',
  },
  first: {
    id: 'first',
    name: 'FIRST FRC Events API',
    baseUrl: 'https://frc-api.firstinspires.org/v3.0',
    auth: { kind: 'basic' },
    requestsPerSecond: 1,
    conditional: 'last-modified',
    attribution: 'Event Data provided by FIRST',
    notes:
      'Attribution is mandatory when sharing data beyond your own team, and must link to the ' +
      'API portal. Commercial use is prohibited outright — "any commercial use (i.e. use that ' +
      'generates revenue)" — which is why nothing built on this can ever have a business ' +
      'model. FIRST may terminate access for any or all users at any time, so it must never ' +
      'be the single upstream for anything that matters.',
  },
  statbotics: {
    id: 'statbotics',
    name: 'Statbotics',
    baseUrl: 'https://api.statbotics.io/v3',
    auth: { kind: 'none' },
    requestsPerSecond: 0.5,
    conditional: 'none',
    notes:
      'One maintainer. Operational guidance is literally "be nice to our servers", and two ' +
      'full-outage reports in 2026 went unanswered. Nightly bulk pulls only, never per-request ' +
      'pass-through, and treat every field as optional: the maintainer has announced removal ' +
      'of the TeamMatch object, offseason events, and the Python client, so the contract ' +
      'narrows rather than widens.',
  },
} as const;

/**
 * The attribution block that must accompany any published export.
 *
 * Emitted into every bulk artifact rather than left to a UI, because the
 * obligation attaches to the data and outlives whatever page happened to
 * display it.
 */
export function attributionFor(sources: readonly SourceId[]): string {
  const lines = [
    'This dataset is derived from the following sources.',
    '',
  ];
  for (const id of sources) {
    const s = SOURCES[id];
    lines.push(`${s.name} — ${s.baseUrl}`);
    if (s.attribution) {
      lines.push(`  ${s.attribution}`);
      lines.push('  https://frc-events.firstinspires.org/services/API');
    }
  }
  lines.push('');
  lines.push(
    'Redistributed for non-commercial use. FIRST prohibits any use of its Events Data that ' +
      'generates revenue.',
  );
  return lines.join('\n');
}

export class SourceError extends Error {
  readonly source: SourceId;
  readonly status?: number;

  constructor(source: SourceId, message: string, status?: number) {
    super(message);
    this.name = 'SourceError';
    this.source = source;
    this.status = status;
  }
}
