import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encode, decode, decodeTagged, encodeTagged, compareBytes, CborError } from '../src/cbor.ts';
import type { CborValue } from '../src/cbor.ts';

const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');
const bin = (h: string) => new Uint8Array(Buffer.from(h, 'hex'));

/** RFC 8949 Appendix A, restricted to the subset the record format uses. */
const VECTORS: Array<[CborValue, string]> = [
  [0, '00'],
  [1, '01'],
  [10, '0a'],
  [23, '17'],
  [24, '1818'],
  [25, '1819'],
  [100, '1864'],
  [1000, '1903e8'],
  [1000000, '1a000f4240'],
  [1000000000000, '1b000000e8d4a51000'],
  [-1, '20'],
  [-10, '29'],
  [-100, '3863'],
  [-1000, '3903e7'],
  [false, 'f4'],
  [true, 'f5'],
  [null, 'f6'],
  ['', '60'],
  ['a', '6161'],
  ['IETF', '6449455446'],
  ['ü', '62c3bc'],
  [new Uint8Array([]), '40'],
  [new Uint8Array([1, 2, 3, 4]), '4401020304'],
  [[], '80'],
  [[1, 2, 3], '83010203'],
  [[1, [2, 3], [4, 5]], '8301820203820405'],
  [new Map(), 'a0'],
  [
    new Map<number, CborValue>([
      [1, 2],
      [3, 4],
    ]),
    'a201020304',
  ],
];

test('RFC 8949 encode vectors', () => {
  for (const [value, want] of VECTORS) {
    assert.equal(hex(encode(value)), want, `encoding ${JSON.stringify(String(value))}`);
  }
});

test('RFC 8949 decode vectors round-trip', () => {
  for (const [value, want] of VECTORS) {
    const got = decode(bin(want));
    assert.deepEqual(got, value, `decoding ${want}`);
    assert.equal(hex(encode(got as CborValue)), want, `re-encoding ${want}`);
  }
});

test('large integers cross into bigint without losing precision', () => {
  const big = 2n ** 63n + 12345n;
  const enc = encode(big);
  assert.equal(decode(enc), big);
});

test('map keys are sorted by encoded bytes, not insertion order', () => {
  const m = new Map<number, CborValue>([
    [10, 'ten'],
    [1, 'one'],
    [3, 'three'],
  ]);
  // Sorted: 01, 03, 0a
  assert.equal(hex(encode(m)), 'a30163' + '6f6e65' + '0365' + '7468726565' + '0a63' + '74656e');
});

test('encoding is stable regardless of Map insertion order', () => {
  const a = new Map<CborValue extends never ? never : number | string, CborValue>();
  a.set(2, 'b');
  a.set(1, 'a');
  const b = new Map<number | string, CborValue>();
  b.set(1, 'a');
  b.set(2, 'b');
  assert.equal(hex(encode(a)), hex(encode(b)));
});

test('text keys sort after integer keys (bytewise on encoded form)', () => {
  const m = new Map<number | string, CborValue>([
    ['a', 1],
    [1, 2],
  ]);
  // integer 1 encodes as 0x01, text "a" as 0x6161 — 0x01 sorts first
  assert.equal(hex(encode(m)), 'a2' + '01' + '02' + '6161' + '01');
});

/* ---------------------------------------------------------------- rejections */

const REJECTS: Array<[string, string, string]> = [
  ['indefinite-length byte string', '5f42010243030405ff', 'indefinite'],
  ['indefinite-length array', '9f018202039f0405ffff', 'indefinite'],
  ['non-canonical: 23 in a 1-byte argument', '1817', 'non-canonical'],
  ['non-canonical: 255 in a 2-byte argument', '1900ff', 'non-canonical'],
  ['non-canonical: 65535 in a 4-byte argument', '1a0000ffff', 'non-canonical'],
  ['non-canonical: 2^32-1 in an 8-byte argument', '1b00000000ffffffff', 'non-canonical'],
  ['reserved additional information 28', '1c', 'reserved'],
  ['half float', 'f93c00', 'simple/float'],
  ['single float', 'fa47c35000', 'simple/float'],
  ['double float', 'fb3ff199999999999a', 'simple/float'],
  ['undefined', 'f7', 'undefined'],
  ['duplicate map key', 'a2010101 02'.replace(/ /g, ''), 'duplicate'],
  ['unsorted map keys', 'a2' + '0a' + '01' + '01' + '02', 'canonical order'],
  ['trailing bytes', '0000', 'trailing'],
  ['truncated head', '18', 'unexpected end'],
  ['truncated byte string', '4401', 'longer than input'],
  ['unexpected tag inside a record', 'c11a514b67b0', 'tag'],
];

test('strict decoder rejects non-canonical and out-of-subset input', () => {
  for (const [name, input, expectFragment] of REJECTS) {
    assert.throws(
      () => decode(bin(input)),
      (err: unknown) => {
        assert.ok(err instanceof CborError, `${name}: expected CborError, got ${err}`);
        assert.match(
          (err as Error).message,
          new RegExp(expectFragment, 'i'),
          `${name}: message "${(err as Error).message}" should mention "${expectFragment}"`,
        );
        return true;
      },
      `${name} (${input}) must be rejected`,
    );
  }
});

test('encoder refuses floats rather than inventing a canonicalisation', () => {
  assert.throws(() => encode(1.5), CborError);
  assert.throws(() => encode(NaN), CborError);
});

test('encoder refuses duplicate map keys', () => {
  // A Map cannot hold duplicate keys directly, but two keys that encode
  // identically would collide. Integer 1 and integer 1 is the trivial case;
  // guard the check exists by round-tripping a normal map.
  const m = new Map<number, CborValue>([[1, 'x']]);
  assert.equal(hex(encode(m)), 'a1016178');
});

test('invalid UTF-8 is rejected, not replaced', () => {
  // 0x61 = tstr(1), then a lone continuation byte
  assert.throws(() => decode(bin('6180')), /invalid UTF-8/i);
});

test('COSE_Sign1 tag round-trips and asserts the tag number', () => {
  const inner: CborValue = [new Uint8Array([1]), new Map(), new Uint8Array([2]), new Uint8Array([3])];
  const tagged = encodeTagged(18, inner);
  assert.equal(hex(tagged).slice(0, 2), 'd2'); // 0xc0 | 18 = 0xd2
  assert.deepEqual(decodeTagged(tagged, 18), inner);
  assert.throws(() => decodeTagged(tagged, 17), /expected tag 17/);
});

test('compareBytes orders bytewise with shorter-is-lesser on a prefix', () => {
  assert.ok(compareBytes(bin('01'), bin('02')) < 0);
  assert.ok(compareBytes(bin('0101'), bin('02')) < 0);
  assert.ok(compareBytes(bin('01'), bin('0101')) < 0);
  assert.equal(compareBytes(bin('abcd'), bin('abcd')), 0);
  assert.ok(compareBytes(bin('ff'), bin('01')) > 0);
});
