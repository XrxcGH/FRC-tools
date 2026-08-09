/**
 * Deterministic CBOR (RFC 8949 §4.2.1), restricted to the subset the Courier
 * record uses. See spec/canonical-cbor.md — that document is normative and this
 * file implements it.
 *
 * The decoder is deliberately strict. It rejects non-canonical input rather
 * than accepting and renormalising it, because a permissive decoder paired with
 * a canonical encoder produces records that verify on one device and fail on
 * another — the worst possible failure mode for a format whose entire job is to
 * give two independent implementations the same bytes.
 */

export type CborKey = number | string;
export type CborValue =
  | number
  | bigint
  | Uint8Array
  | string
  | boolean
  | null
  | CborValue[]
  | Map<CborKey, CborValue>;

const MT_UINT = 0;
const MT_NEGINT = 1;
const MT_BSTR = 2;
const MT_TSTR = 3;
const MT_ARRAY = 4;
const MT_MAP = 5;
const MT_TAG = 6;
const MT_SIMPLE = 7;

export class CborError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CborError';
  }
}

/* -------------------------------------------------------------------------- */
/* Encoding                                                                    */
/* -------------------------------------------------------------------------- */

class Writer {
  #buf = new Uint8Array(256);
  #len = 0;

  #grow(need: number): void {
    if (this.#len + need <= this.#buf.length) return;
    let cap = this.#buf.length;
    while (cap < this.#len + need) cap *= 2;
    const next = new Uint8Array(cap);
    next.set(this.#buf.subarray(0, this.#len));
    this.#buf = next;
  }

  byte(b: number): void {
    this.#grow(1);
    this.#buf[this.#len++] = b;
  }

  bytes(b: Uint8Array): void {
    this.#grow(b.length);
    this.#buf.set(b, this.#len);
    this.#len += b.length;
  }

  /** Emit a major-type head with its argument in the shortest legal form. */
  head(mt: number, arg: number | bigint): void {
    const v = typeof arg === 'bigint' ? arg : BigInt(arg);
    if (v < 0n) throw new CborError('head argument must be non-negative');
    const base = mt << 5;
    if (v < 24n) {
      this.byte(base | Number(v));
    } else if (v < 0x100n) {
      this.byte(base | 24);
      this.byte(Number(v));
    } else if (v < 0x10000n) {
      this.byte(base | 25);
      this.byte(Number(v >> 8n) & 0xff);
      this.byte(Number(v) & 0xff);
    } else if (v < 0x100000000n) {
      this.byte(base | 26);
      for (let s = 24n; s >= 0n; s -= 8n) this.byte(Number((v >> s) & 0xffn));
    } else if (v < 0x10000000000000000n) {
      this.byte(base | 27);
      for (let s = 56n; s >= 0n; s -= 8n) this.byte(Number((v >> s) & 0xffn));
    } else {
      throw new CborError('integer exceeds 64 bits');
    }
  }

  take(): Uint8Array {
    return this.#buf.slice(0, this.#len);
  }
}

const UTF8_ENCODER = new TextEncoder();

function encodeInto(w: Writer, value: CborValue): void {
  if (value === null) {
    w.byte((MT_SIMPLE << 5) | 22);
    return;
  }
  if (value === true) {
    w.byte((MT_SIMPLE << 5) | 21);
    return;
  }
  if (value === false) {
    w.byte((MT_SIMPLE << 5) | 20);
    return;
  }
  if (typeof value === 'number') {
    if (!Number.isInteger(value)) {
      throw new CborError(
        `non-integer number ${value}: the record schema has no float field, and ` +
          `permitting floats would raise NaN canonicalisation`,
      );
    }
    if (value >= 0) w.head(MT_UINT, value);
    else w.head(MT_NEGINT, -value - 1);
    return;
  }
  if (typeof value === 'bigint') {
    if (value >= 0n) w.head(MT_UINT, value);
    else w.head(MT_NEGINT, -value - 1n);
    return;
  }
  if (typeof value === 'string') {
    // NFC-normalise so two spellings of "the same" string cannot produce two
    // different record ids.
    const bytes = UTF8_ENCODER.encode(value.normalize('NFC'));
    w.head(MT_TSTR, bytes.length);
    w.bytes(bytes);
    return;
  }
  if (value instanceof Uint8Array) {
    w.head(MT_BSTR, value.length);
    w.bytes(value);
    return;
  }
  if (Array.isArray(value)) {
    w.head(MT_ARRAY, value.length);
    for (const item of value) encodeInto(w, item);
    return;
  }
  if (value instanceof Map) {
    // Sort by ENCODED key bytes, not numeric or insertion order. For the small
    // positive labels used today the orderings coincide; they diverge as soon
    // as a negative label appears, which a v2 record may well introduce.
    const entries: Array<{ k: Uint8Array; v: CborValue }> = [];
    for (const [k, v] of value) {
      const kw = new Writer();
      encodeInto(kw, k);
      entries.push({ k: kw.take(), v });
    }
    entries.sort((a, b) => compareBytes(a.k, b.k));
    for (let i = 1; i < entries.length; i++) {
      if (compareBytes(entries[i - 1]!.k, entries[i]!.k) === 0) {
        throw new CborError('duplicate map key');
      }
    }
    w.head(MT_MAP, entries.length);
    for (const e of entries) {
      w.bytes(e.k);
      encodeInto(w, e.v);
    }
    return;
  }
  throw new CborError(`unsupported value of type ${typeof value}`);
}

export function encode(value: CborValue): Uint8Array {
  const w = new Writer();
  encodeInto(w, value);
  return w.take();
}

/** Encode a CBOR tag wrapping an already-encoded item. Only used for COSE's #6.18. */
export function encodeTagged(tag: number, value: CborValue): Uint8Array {
  const w = new Writer();
  w.head(MT_TAG, tag);
  encodeInto(w, value);
  return w.take();
}

export function compareBytes(a: Uint8Array, b: Uint8Array): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    if (a[i]! !== b[i]!) return a[i]! - b[i]!;
  }
  return a.length - b.length;
}

/* -------------------------------------------------------------------------- */
/* Decoding                                                                    */
/* -------------------------------------------------------------------------- */

const UTF8_DECODER = new TextDecoder('utf-8', { fatal: true });

class Reader {
  #b: Uint8Array;
  #p = 0;

  constructor(b: Uint8Array) {
    this.#b = b;
  }

  get offset(): number {
    return this.#p;
  }

  get remaining(): number {
    return this.#b.length - this.#p;
  }

  byte(): number {
    if (this.#p >= this.#b.length) throw new CborError('unexpected end of input');
    return this.#b[this.#p++]!;
  }

  slice(n: number): Uint8Array {
    if (n > this.remaining) throw new CborError('unexpected end of input');
    const out = this.#b.subarray(this.#p, this.#p + n);
    this.#p += n;
    return out;
  }

  /** Read a head, enforcing shortest-form encoding of the argument. */
  head(): { mt: number; arg: bigint } {
    const ib = this.byte();
    const mt = ib >> 5;
    const ai = ib & 0x1f;

    if (ai < 24) return { mt, arg: BigInt(ai) };
    if (ai === 31) throw new CborError('indefinite-length item: not canonical');
    if (ai >= 28) throw new CborError(`reserved additional information ${ai}`);

    const width = 1 << (ai - 24); // 1, 2, 4, 8
    let arg = 0n;
    for (let i = 0; i < width; i++) arg = (arg << 8n) | BigInt(this.byte());

    // Shortest-form check: the value must not have fitted in a smaller width.
    const min = ai === 24 ? 24n : 1n << BigInt(8 * (width >> 1));
    if (arg < min) {
      throw new CborError(
        `non-canonical integer: ${arg} encoded in ${width} byte(s) but fits in fewer`,
      );
    }
    return { mt, arg };
  }
}

function toNumber(v: bigint): number | bigint {
  return v <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(v) : v;
}

function decodeItem(r: Reader, depth: number): CborValue {
  if (depth > 32) throw new CborError('nesting too deep');
  const { mt, arg } = r.head();

  switch (mt) {
    case MT_UINT:
      return toNumber(arg);

    case MT_NEGINT: {
      const v = -arg - 1n;
      return v >= BigInt(Number.MIN_SAFE_INTEGER) ? Number(v) : v;
    }

    case MT_BSTR: {
      if (arg > BigInt(r.remaining)) throw new CborError('byte string longer than input');
      return r.slice(Number(arg)).slice(); // copy: callers must own their bytes
    }

    case MT_TSTR: {
      if (arg > BigInt(r.remaining)) throw new CborError('text string longer than input');
      const raw = r.slice(Number(arg));
      let s: string;
      try {
        s = UTF8_DECODER.decode(raw);
      } catch {
        throw new CborError('invalid UTF-8 in text string');
      }
      if (s.normalize('NFC') !== s) throw new CborError('text string is not NFC-normalised');
      return s;
    }

    case MT_ARRAY: {
      const n = Number(arg);
      if (n > r.remaining) throw new CborError('array longer than input');
      const out: CborValue[] = [];
      for (let i = 0; i < n; i++) out.push(decodeItem(r, depth + 1));
      return out;
    }

    case MT_MAP: {
      const n = Number(arg);
      // Every entry is at least two bytes (one key head + one value head), so a
      // declared count beyond that bound cannot be satisfied by the remaining
      // input. Guards against a huge count triggering a huge allocation.
      if (n * 2 > r.remaining) throw new CborError('map longer than input');
      const out = new Map<CborKey, CborValue>();
      let prevKey: Uint8Array | null = null;
      for (let i = 0; i < n; i++) {
        const k = decodeItem(r, depth + 1);
        if (typeof k !== 'number' && typeof k !== 'string') {
          throw new CborError('map key must be an integer or text string');
        }
        // Re-encode the key to compare ordering on canonical bytes.
        const keyBytes = encode(k);
        if (prevKey !== null) {
          const c = compareBytes(prevKey, keyBytes);
          if (c === 0) throw new CborError('duplicate map key');
          if (c > 0) throw new CborError('map keys not in canonical order');
        }
        prevKey = keyBytes;
        out.set(k, decodeItem(r, depth + 1));
      }
      return out;
    }

    case MT_TAG:
      throw new CborError(
        `unexpected tag ${arg}: tags are not permitted inside a record ` +
          `(the COSE_Sign1 tag is handled by the envelope reader)`,
      );

    case MT_SIMPLE: {
      const v = Number(arg);
      if (v === 20) return false;
      if (v === 21) return true;
      if (v === 22) return null;
      if (v === 23) throw new CborError('`undefined` is not permitted');
      throw new CborError(`unsupported simple/float value ${v}`);
    }

    default:
      throw new CborError(`unsupported major type ${mt}`);
  }
}

/** Decode exactly one item, rejecting trailing bytes. */
export function decode(bytes: Uint8Array): CborValue {
  const r = new Reader(bytes);
  const v = decodeItem(r, 0);
  if (r.remaining !== 0) {
    throw new CborError(`${r.remaining} trailing byte(s) after top-level item`);
  }
  return v;
}

/** Decode a tagged item, asserting the tag number. Used for COSE_Sign1 (#6.18). */
export function decodeTagged(bytes: Uint8Array, expectTag: number): CborValue {
  const r = new Reader(bytes);
  const { mt, arg } = r.head();
  if (mt !== MT_TAG) throw new CborError('expected a tagged item');
  if (Number(arg) !== expectTag) throw new CborError(`expected tag ${expectTag}, got ${arg}`);
  const v = decodeItem(r, 0);
  if (r.remaining !== 0) throw new CborError('trailing bytes after tagged item');
  return v;
}

/* -------------------------------------------------------------------------- */
/* Typed accessors — decoding a record should never require `as` at the callsite */
/* -------------------------------------------------------------------------- */

export function expectMap(v: CborValue, what: string): Map<CborKey, CborValue> {
  if (!(v instanceof Map)) throw new CborError(`${what}: expected a map`);
  return v;
}

export function expectArray(v: CborValue, what: string): CborValue[] {
  if (!Array.isArray(v)) throw new CborError(`${what}: expected an array`);
  return v;
}

export function expectUint(v: CborValue | undefined, what: string): number {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 0) {
    throw new CborError(`${what}: expected an unsigned integer`);
  }
  return v;
}

export function expectText(v: CborValue | undefined, what: string): string {
  if (typeof v !== 'string') throw new CborError(`${what}: expected a text string`);
  return v;
}

export function expectBytes(v: CborValue | undefined, what: string, size?: number): Uint8Array {
  if (!(v instanceof Uint8Array)) throw new CborError(`${what}: expected a byte string`);
  if (size !== undefined && v.length !== size) {
    throw new CborError(`${what}: expected ${size} bytes, got ${v.length}`);
  }
  return v;
}
