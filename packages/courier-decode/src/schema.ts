/**
 * The decoder seam.
 *
 * DESIGN.md §0 D-4 names this as the largest hand-wave in the draft: Courier
 * bodies are opaque by construction, but every analytics feature — the
 * constrained blend, scout reliability, the picklist — consumes DECODED values,
 * and nothing said where a decoder came from.
 *
 * ── The boundary this must not cross ────────────────────────────────────────
 * A decoder is a TEAM'S OWN description of THEIR OWN body format, registered on
 * their own device, and applied at analysis time. It is not a shared schema, it
 * is not negotiated with anyone, and it never travels with a record. Courier
 * still never parses a body in transit; `record.body` reaches the far side byte
 * for byte and the far side does whatever it likes with it.
 *
 * That distinction is the whole product. Every previous attempt to unify FRC
 * scouting data tried to standardise what payloads MEAN and died, because teams
 * have a positive incentive to diverge — they treat differing data as
 * competitive advantage and mentors use app-building as curriculum. Courier
 * standardises the envelope so nobody has to agree, and this module lets a team
 * read back what they themselves wrote.
 *
 * ── What happens without one ────────────────────────────────────────────────
 * Nothing breaks and nothing is invented. A record whose `schema_id` has no
 * registered decoder yields `{ decoded: false }`, transport and envelope
 * metadata still work, and every downstream consumer is expected to say so
 * rather than substitute a zero. `decodeAll` reports exactly how many records
 * it could not read.
 */

export class SchemaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SchemaError';
  }
}

export type FieldType = 'integer' | 'number' | 'boolean' | 'enum' | 'string';

export interface FieldSpec {
  /** The name analytics will use. Dotted names are conventional, not parsed. */
  readonly name: string;
  readonly type: FieldType;
  /** Column index for `delimited`, or a dotted key path for `json`. */
  readonly source: number | string;
  /** Required for `enum`. A value outside this list is a decode failure. */
  readonly values?: readonly string[];
  /**
   * Strings that count as true for a boolean field.
   *
   * Explicit rather than guessed, because scouting apps disagree: "1", "true",
   * "yes", "Y", "x" are all in the wild, and silently treating an unrecognised
   * string as false turns a climb into a no-climb.
   */
  readonly trueValues?: readonly string[];
  /** Reject values outside this range as implausible rather than storing them. */
  readonly min?: number;
  readonly max?: number;
}

export interface BodySchema {
  /** Must match the `schema_id` in the records this decodes. */
  readonly schemaId: string;
  readonly format: 'delimited' | 'json';
  /** For `delimited`. Tab only, for the same reason the Bridge accepts tab only. */
  readonly delimiter?: string;
  readonly fields: readonly FieldSpec[];
}

const DEFAULT_TRUE = ['1', 'true', 'yes', 'y', 't'];
/** Same rule as the Bridge: no quoting support, so no delimiter that can appear in a value. */
const ALLOWED_DELIMITERS = new Set(['\t', '', '|']);

export function validateSchema(s: BodySchema): void {
  if (!s.schemaId) throw new SchemaError('a schema needs a schemaId');
  if (s.format !== 'delimited' && s.format !== 'json') {
    throw new SchemaError(`${s.schemaId}: unknown format "${s.format}"`);
  }
  if (s.format === 'delimited') {
    if (!s.delimiter) throw new SchemaError(`${s.schemaId}: delimited schemas need a delimiter`);
    if (!ALLOWED_DELIMITERS.has(s.delimiter)) {
      throw new SchemaError(
        `${s.schemaId}: delimiter ${JSON.stringify(s.delimiter)} is not permitted. There is no ` +
          `quoting, so a delimiter that can appear inside a value shifts every column.`,
      );
    }
  }
  if (s.fields.length === 0) throw new SchemaError(`${s.schemaId}: no fields declared`);

  const names = new Set<string>();
  for (const f of s.fields) {
    if (!f.name) throw new SchemaError(`${s.schemaId}: a field has no name`);
    if (names.has(f.name)) throw new SchemaError(`${s.schemaId}: duplicate field "${f.name}"`);
    names.add(f.name);

    if (s.format === 'delimited' && typeof f.source !== 'number') {
      throw new SchemaError(`${s.schemaId}: "${f.name}" needs a column index`);
    }
    if (s.format === 'json' && typeof f.source !== 'string') {
      throw new SchemaError(`${s.schemaId}: "${f.name}" needs a key path`);
    }
    if (typeof f.source === 'number' && (!Number.isInteger(f.source) || f.source < 0)) {
      throw new SchemaError(`${s.schemaId}: "${f.name}" has a negative or fractional index`);
    }
    if (f.type === 'enum' && (!f.values || f.values.length === 0)) {
      throw new SchemaError(`${s.schemaId}: enum field "${f.name}" must list its values`);
    }
    if (f.type !== 'enum' && f.values) {
      throw new SchemaError(`${s.schemaId}: only enum fields may list values`);
    }
    if (f.min !== undefined && f.max !== undefined && f.min > f.max) {
      throw new SchemaError(`${s.schemaId}: "${f.name}" has min above max`);
    }
  }
}

export function loadSchema(raw: unknown): BodySchema {
  if (typeof raw !== 'object' || raw === null) throw new SchemaError('schema is not an object');
  const s = raw as BodySchema;
  if (!Array.isArray(s.fields)) throw new SchemaError('schema has no fields array');
  validateSchema(s);
  return s;
}

/* -------------------------------------------------------------------------- */
/* Decoding                                                                    */
/* -------------------------------------------------------------------------- */

export type FieldValue = number | boolean | string;

export interface DecodeSuccess {
  readonly decoded: true;
  readonly schemaId: string;
  readonly values: Readonly<Record<string, FieldValue>>;
  /** Fields the schema declares that this body did not supply. */
  readonly missing: readonly string[];
}

export interface DecodeFailure {
  readonly decoded: false;
  readonly schemaId: string;
  readonly reason: string;
}

export type DecodeResult = DecodeSuccess | DecodeFailure;

function readPath(obj: Record<string, unknown>, path: string): unknown {
  let cur: unknown = obj;
  for (const part of path.split('.')) {
    if (typeof cur !== 'object' || cur === null) return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

function coerce(f: FieldSpec, raw: string): FieldValue | undefined {
  const text = raw.trim();
  if (text === '') return undefined;

  switch (f.type) {
    case 'integer': {
      if (!/^-?\d+$/.test(text)) return undefined;
      const n = Number(text);
      return Number.isSafeInteger(n) ? n : undefined;
    }
    case 'number': {
      const n = Number(text);
      return Number.isFinite(n) ? n : undefined;
    }
    case 'boolean': {
      const truthy = (f.trueValues ?? DEFAULT_TRUE).map((v) => v.toLowerCase());
      // An unrecognised string is a FAILURE, not false. Silently treating "Deep"
      // as false turns a climb into a no-climb and nobody ever finds out.
      const lower = text.toLowerCase();
      if (truthy.includes(lower)) return true;
      if (['0', 'false', 'no', 'n', 'f'].includes(lower)) return false;
      return undefined;
    }
    case 'enum':
      return f.values!.includes(text) ? text : undefined;
    case 'string':
      return text;
  }
}

/** Decode one body against one schema. Never throws for bad data. */
export function decodeBody(schema: BodySchema, body: Uint8Array): DecodeResult {
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(body);
  } catch {
    return { decoded: false, schemaId: schema.schemaId, reason: 'body is not valid UTF-8' };
  }

  let read: (f: FieldSpec) => string | undefined;

  if (schema.format === 'json') {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return { decoded: false, schemaId: schema.schemaId, reason: 'body is not valid JSON' };
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return { decoded: false, schemaId: schema.schemaId, reason: 'body is not a JSON object' };
    }
    const obj = parsed as Record<string, unknown>;
    read = (f) => {
      const v = readPath(obj, f.source as string);
      return v === undefined || v === null ? undefined : String(v);
    };
  } else {
    // Strip only line endings, never the delimiter: tab is whitespace, and
    // trimming a tab-delimited body eats an empty leading column and shifts
    // every field left. Same bug the Bridge had.
    const parts = text.replace(/^﻿/, '').replace(/[\r\n]+$/, '').split(schema.delimiter!);
    read = (f) => parts[f.source as number];
  }

  const values: Record<string, FieldValue> = {};
  const missing: string[] = [];

  for (const f of schema.fields) {
    const raw = read(f);
    if (raw === undefined) {
      missing.push(f.name);
      continue;
    }
    const v = coerce(f, raw);
    if (v === undefined) {
      return {
        decoded: false,
        schemaId: schema.schemaId,
        reason: `field "${f.name}" could not be read as ${f.type}`,
      };
    }
    if (typeof v === 'number') {
      if (f.min !== undefined && v < f.min) {
        return {
          decoded: false,
          schemaId: schema.schemaId,
          reason: `field "${f.name}" is ${v}, below the declared minimum ${f.min}`,
        };
      }
      if (f.max !== undefined && v > f.max) {
        return {
          decoded: false,
          schemaId: schema.schemaId,
          reason: `field "${f.name}" is ${v}, above the declared maximum ${f.max}`,
        };
      }
    }
    values[f.name] = v;
  }

  return { decoded: true, schemaId: schema.schemaId, values, missing };
}
