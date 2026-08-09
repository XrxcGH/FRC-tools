/**
 * Bulk export — free, current, account-free data.
 *
 * The single highest-feasibility item in the research, and genuinely missing:
 * The Blue Alliance's advertised bulk archives have not moved since 2019 while
 * its docs still point at them, and the only current bulk path is a BigQuery
 * dataset behind a Google Cloud billing account. A sixteen-year-old without a
 * credit card cannot get a season of FRC data in one download. That is the
 * whole gap.
 *
 * ── Why files, and why these formats ────────────────────────────────────────
 * Everything here is a static file. No server, no database, no API key, no
 * account, and — critically for a project whose maintainers graduate — no
 * billing relationship tied to anyone's personal card. A bucket of files
 * survives its founders leaving in a way that a running service does not.
 *
 * NDJSON and CSV rather than Parquet: Parquet is the better analytical format
 * and the wrong one here. The audience is a student with a spreadsheet, a
 * scripting language, and no patience for a toolchain. NDJSON streams and every
 * language reads it; CSV opens in Excel. Neither needs a dependency.
 *
 * ── Content addressing ──────────────────────────────────────────────────────
 * Artifacts are named by the hash of their contents, so they can be served with
 * an immutable cache header forever and a consumer can tell whether anything
 * changed without downloading it. A small mutable index points at the current
 * set. That split — immutable bodies, one tiny mutable pointer — is what makes
 * the whole thing cacheable at the edge for free.
 */

import { hash256, toHex, utf8 } from '@courier/core';
import { attributionFor, type SourceId } from './sources.ts';
import type { MatchEntry, TeamEntry } from './venue-pack.ts';
import { unpackMatch } from '@courier/core';

export const BULK_FORMAT_VERSION = 1;

export class BulkError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BulkError';
  }
}

export type ContentType = 'application/x-ndjson' | 'text/csv' | 'application/json' | 'text/plain';

export interface BulkArtifact {
  /** Content-addressed path. Safe to serve `immutable` forever. */
  readonly path: string;
  readonly digest: Uint8Array;
  readonly bytes: Uint8Array;
  readonly contentType: ContentType;
  readonly rows: number;
}

export interface BulkManifest {
  readonly formatVersion: number;
  readonly eventKey: string;
  readonly generatedAt: number;
  readonly sources: readonly SourceId[];
  readonly artifacts: ReadonlyArray<{
    readonly kind: string;
    readonly path: string;
    readonly digest: string;
    readonly rows: number;
    readonly contentType: ContentType;
  }>;
  /** Disagreements between sources, if any were reconciled. Never hidden. */
  readonly conflicts: number;
}

export interface BulkExport {
  readonly manifest: BulkManifest;
  readonly artifacts: readonly BulkArtifact[];
  /** Path -> bytes, ready to write to a directory or upload to a bucket. */
  files(): Map<string, Uint8Array>;
}

/* -------------------------------------------------------------------------- */
/* Writers                                                                     */
/* -------------------------------------------------------------------------- */

export function toNdjson(rows: readonly Record<string, unknown>[]): string {
  return rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : '');
}

/**
 * RFC 4180 CSV.
 *
 * Note the asymmetry with the Bridge, which refuses comma-delimited input: this
 * project will happily WRITE csv and will not PARSE somebody else's. Writing is
 * safe because we control the quoting; parsing is not, because a field
 * containing a comma silently shifts every column and there is no way to know
 * whether the producer quoted it.
 */
export function toCsv(
  rows: readonly Record<string, unknown>[],
  columns: readonly string[],
): string {
  const cell = (v: unknown): string => {
    if (v === null || v === undefined) return '';
    const s = String(v);
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [columns.join(',')];
  for (const r of rows) lines.push(columns.map((c) => cell(r[c])).join(','));
  return lines.join('\r\n') + '\r\n';
}

function artifact(
  kind: string,
  eventKey: string,
  body: string,
  contentType: ContentType,
  rows: number,
): BulkArtifact & { kind: string } {
  const bytes = utf8(body);
  const digest = hash256(bytes);
  const ext = contentType === 'text/csv' ? 'csv' : contentType === 'application/x-ndjson' ? 'ndjson' : 'json';
  return {
    kind,
    // Hash in the path, so the body can be cached immutably and a consumer can
    // skip the download entirely when the digest has not moved.
    path: `${eventKey}/${kind}-${toHex(digest).slice(0, 16)}.${ext}`,
    digest,
    bytes,
    contentType,
    rows,
  };
}

/* -------------------------------------------------------------------------- */
/* Row shapes                                                                  */
/* -------------------------------------------------------------------------- */

const MATCH_COLUMNS = [
  'event_key',
  'match_key',
  'comp_level',
  'set_number',
  'match_number',
  'red1',
  'red2',
  'red3',
  'blue1',
  'blue2',
  'blue3',
  'red_score',
  'blue_score',
  'played',
] as const;

const TEAM_COLUMNS = ['event_key', 'team', 'nickname'] as const;

function matchRows(eventKey: string, matches: readonly MatchEntry[]): Record<string, unknown>[] {
  return matches.map((m) => {
    const u = unpackMatch(m.match);
    const key = u.level === 'qm' ? `${eventKey}_qm${u.number}` : `${eventKey}_${u.level}${u.set}m${u.number}`;
    return {
      event_key: eventKey,
      match_key: key,
      comp_level: u.level,
      set_number: u.set,
      match_number: u.number,
      red1: m.red[0] ?? null,
      red2: m.red[1] ?? null,
      red3: m.red[2] ?? null,
      blue1: m.blue[0] ?? null,
      blue2: m.blue[1] ?? null,
      blue3: m.blue[2] ?? null,
      // An unplayed match has no score, and 0 is a real result — so `played` is
      // carried explicitly rather than inferred from a null, which every
      // consumer would otherwise have to guess at.
      red_score: m.redScore ?? null,
      blue_score: m.blueScore ?? null,
      played: m.redScore !== undefined,
    };
  });
}

function teamRows(eventKey: string, teams: readonly TeamEntry[]): Record<string, unknown>[] {
  return teams.map((t) => ({ event_key: eventKey, team: t.team, nickname: t.nickname }));
}

/* -------------------------------------------------------------------------- */
/* Build                                                                       */
/* -------------------------------------------------------------------------- */

export interface BuildBulkInput {
  readonly eventKey: string;
  readonly generatedAt: number;
  readonly sources: readonly SourceId[];
  readonly teams: readonly TeamEntry[];
  readonly matches: readonly MatchEntry[];
  /** Count of source disagreements, surfaced in the manifest rather than hidden. */
  readonly conflicts?: number;
}

export function buildBulkExport(input: BuildBulkInput): BulkExport {
  if (input.sources.length === 0) {
    throw new BulkError('an export must name its sources so attribution can be emitted');
  }

  const mRows = matchRows(input.eventKey, input.matches);
  const tRows = teamRows(input.eventKey, input.teams);

  const artifacts = [
    artifact('matches', input.eventKey, toNdjson(mRows), 'application/x-ndjson', mRows.length),
    artifact('matches', input.eventKey, toCsv(mRows, MATCH_COLUMNS), 'text/csv', mRows.length),
    artifact('teams', input.eventKey, toNdjson(tRows), 'application/x-ndjson', tRows.length),
    artifact('teams', input.eventKey, toCsv(tRows, TEAM_COLUMNS), 'text/csv', tRows.length),
  ];

  const manifest: BulkManifest = {
    formatVersion: BULK_FORMAT_VERSION,
    eventKey: input.eventKey,
    generatedAt: input.generatedAt,
    sources: input.sources,
    conflicts: input.conflicts ?? 0,
    artifacts: artifacts.map((a) => ({
      kind: a.kind,
      path: a.path,
      digest: toHex(a.digest),
      rows: a.rows,
      contentType: a.contentType,
    })),
  };

  return {
    manifest,
    artifacts,
    files(): Map<string, Uint8Array> {
      const out = new Map<string, Uint8Array>();
      for (const a of artifacts) out.set(a.path, a.bytes);
      // The one mutable file. Everything else is content-addressed and can be
      // served immutable forever.
      out.set(`${input.eventKey}/index.json`, utf8(JSON.stringify(manifest, null, 2) + '\n'));
      // Attribution rides with the data, not with whatever page displayed it.
      out.set(`${input.eventKey}/ATTRIBUTION.txt`, utf8(attributionFor(input.sources) + '\n'));
      return out;
    },
  };
}

/**
 * Cache-control for a static host.
 *
 * Content-addressed bodies never change, so they get a year and `immutable`.
 * The index is the only thing a consumer must re-check, and it is tiny.
 */
export function cacheControlFor(path: string): string {
  if (path.endsWith('index.json')) return 'public, max-age=60';
  if (path.endsWith('ATTRIBUTION.txt')) return 'public, max-age=3600';
  return 'public, max-age=31536000, immutable';
}
