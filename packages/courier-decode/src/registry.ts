/**
 * The registry: `schema_id` to decoder, on this device only.
 *
 * Records carry a `schema_id`, which is an opaque string chosen by whoever
 * sealed them. It is a LOOKUP KEY, not an agreement: two teams can use the same
 * string for different formats and nothing breaks, because a registry is local
 * and a team only ever decodes bodies it can already read.
 *
 * The degradation path is the important part. A record whose schema is not
 * registered is not an error, not a warning, and not a zero — it is simply not
 * decoded, and every consumer is told how many of those there were.
 */

import { decodeBody, validateSchema, type BodySchema, type DecodeResult } from './schema.ts';

export class RegistryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RegistryError';
  }
}

export interface StoredRecordLike {
  readonly record: {
    readonly schema: string;
    readonly body: Uint8Array;
    readonly team: number;
    readonly match: number;
    readonly eventKey: string;
    readonly scout: Uint8Array;
  };
}

export interface DecodedRecord {
  readonly team: number;
  readonly match: number;
  readonly eventKey: string;
  /** Opaque scout pseudonym, hex. Never a name. */
  readonly scout: string;
  readonly values: Readonly<Record<string, number | boolean | string>>;
}

export interface DecodeReport {
  readonly records: DecodedRecord[];
  /** Records whose `schema_id` had no registered decoder. */
  readonly unknownSchema: number;
  /** Records whose schema was known but whose body would not decode. */
  readonly failed: number;
  /** Distinct schema ids seen with no decoder, for an actionable message. */
  readonly missingSchemas: string[];
  readonly reasons: string[];
}

const toHex = (b: Uint8Array): string => {
  let s = '';
  for (const x of b) s += x.toString(16).padStart(2, '0');
  return s;
};

export class DecoderRegistry {
  readonly #schemas = new Map<string, BodySchema>();

  static from(schemas: Iterable<BodySchema>): DecoderRegistry {
    const r = new DecoderRegistry();
    for (const s of schemas) r.register(s);
    return r;
  }

  register(schema: BodySchema): void {
    validateSchema(schema);
    this.#schemas.set(schema.schemaId, schema);
  }

  has(schemaId: string): boolean {
    return this.#schemas.has(schemaId);
  }

  get size(): number {
    return this.#schemas.size;
  }

  ids(): string[] {
    return [...this.#schemas.keys()].sort();
  }

  /** Decode one body, or say why not. */
  decode(schemaId: string, body: Uint8Array): DecodeResult | null {
    const schema = this.#schemas.get(schemaId);
    if (!schema) return null;
    return decodeBody(schema, body);
  }

  /**
   * Decode a whole store.
   *
   * Undecodable records are counted, not dropped silently and not defaulted to
   * zero. A caller that ignores `unknownSchema` and `failed` is presenting a
   * partial dataset as a complete one, which is exactly the failure the design
   * warns about — so both are non-optional in the report.
   */
  decodeAll(stored: Iterable<StoredRecordLike>): DecodeReport {
    const records: DecodedRecord[] = [];
    const missing = new Set<string>();
    const reasons: string[] = [];
    let unknownSchema = 0;
    let failed = 0;

    for (const s of stored) {
      const r = this.decode(s.record.schema, s.record.body);
      if (r === null) {
        unknownSchema++;
        missing.add(s.record.schema);
        continue;
      }
      if (!r.decoded) {
        failed++;
        if (reasons.length < 8) reasons.push(`${s.record.schema}: ${r.reason}`);
        continue;
      }
      records.push({
        team: s.record.team,
        match: s.record.match,
        eventKey: s.record.eventKey,
        scout: toHex(s.record.scout),
        values: r.values,
      });
    }

    return {
      records,
      unknownSchema,
      failed,
      missingSchemas: [...missing].sort(),
      reasons,
    };
  }
}

/**
 * An operator-facing summary of what could not be read.
 *
 * Empty string when everything decoded, so a caller can print it
 * unconditionally without producing a reassuring "0 problems" line that trains
 * people to ignore it.
 */
export function describeGaps(report: DecodeReport, total: number): string {
  if (report.unknownSchema === 0 && report.failed === 0) return '';
  const lines: string[] = [];

  if (report.unknownSchema > 0) {
    lines.push(
      `${report.unknownSchema} of ${total} records use a schema this device cannot read: ` +
        `${report.missingSchemas.join(', ')}.`,
      'They are stored and will sync onward untouched — Courier never needed to understand',
      'them — but nothing here can turn them into numbers. Register a decoder for that',
      'schema id, or analyse on the device that wrote them.',
    );
  }
  if (report.failed > 0) {
    lines.push(
      `${report.failed} record(s) matched a known schema but would not decode:`,
      ...report.reasons.map((r) => `  - ${r}`),
    );
  }
  return lines.join('\n');
}
