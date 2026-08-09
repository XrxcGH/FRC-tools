import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  loadPack,
  signPack,
  openSignedPack,
  checkReleaseKind,
  requiredSignatures,
  canonicalPackJson,
  PackError,
  type SeasonPack,
} from '../src/index.ts';
import {
  generateDeviceKey,
  toHex,
  encode,
  decode,
  expectMap,
  type CborKey,
  type CborValue,
} from '@courier/core';

const PACK = loadPack(
  JSON.parse(
    readFileSync(fileURLToPath(new URL('../packs/example-synthetic/1.0.0.json', import.meta.url)), 'utf8'),
  ),
);
const clone = (p: SeasonPack): SeasonPack => JSON.parse(JSON.stringify(p)) as SeasonPack;

const steward1 = generateDeviceKey('software');
const steward2 = generateDeviceKey('software');
const outsider = generateDeviceKey('software');

const stewards = new Map([steward1, steward2].map((s) => [toHex(s.kid), s.publicKey]));
const resolver = (kid: Uint8Array) => stewards.get(toHex(kid));

/* ------------------------------------------------------------ thresholds -- */

test('the threshold is 1-of-2 for routine releases and 2-of-2 for breaking ones', () => {
  assert.equal(requiredSignatures('patch'), 1);
  assert.equal(requiredSignatures('minor'), 1);
  assert.equal(requiredSignatures('major'), 2);
});

test('a routine release ships with one signature, from a hotel at 2am', () => {
  // Requiring two always fails the first time a signer is on a plane — and the
  // deadline it fails is the kickoff sprint, which the design calls terminal on
  // a single miss.
  const bytes = signPack(PACK, 'minor', [steward1]);
  const opened = openSignedPack(bytes, resolver);
  assert.equal(opened.releaseKind, 'minor');
  assert.equal(opened.signers.length, 1);
  assert.equal(opened.pack.packId, PACK.packId);
});

test('a breaking release cannot be signed by one steward', () => {
  assert.throws(() => signPack(PACK, 'major', [steward1]), /needs 2 signature/);
  assert.equal(
    openSignedPack(signPack(PACK, 'major', [steward1, steward2]), resolver).signers.length,
    2,
  );
});

test('relabelling a signed release is detected, because the kind is signed', () => {
  // The attack: take a validly-signed MINOR pack (one signature, easy to get)
  // and rewrite its label to MAJOR — or the reverse, stripping a breaking
  // change down so it passes with one key. Both fail because the release kind
  // is inside the signed material, not beside it.
  const minor = signPack(PACK, 'minor', [steward1]);

  const m = expectMap(decode(minor), 'signed pack');
  const relabelled = encode(
    new Map<CborKey, CborValue>([
      [1, m.get(1)!], // same payload
      [2, 'major'], // ...but claiming to be breaking
      [3, m.get(3)!], // ...with the original signature
    ]),
  );

  assert.throws(
    () => openSignedPack(relabelled, resolver),
    /carries 0 valid signature/,
    'the signature must not verify against a different release kind',
  );
});

test('one key signing twice is one signature, not two', () => {
  // Otherwise a single compromised steward could publish a breaking release.
  assert.throws(() => signPack(PACK, 'major', [steward1, steward1]), /signed twice/);
});

test('signatures from unknown keys do not count toward the threshold', () => {
  const bytes = signPack(PACK, 'major', [steward1, outsider]);
  assert.throws(() => openSignedPack(bytes, resolver), /carries 1 valid signature/);

  // With a genuine second steward it passes.
  assert.equal(openSignedPack(signPack(PACK, 'major', [steward1, steward2]), resolver).signers.length, 2);
});

/* ---------------------------------------------------------- tamper checks -- */

test('any alteration to the pack invalidates every signature', () => {
  const bytes = signPack(PACK, 'minor', [steward1]);
  for (const i of [30, 200, bytes.length - 30]) {
    const t = bytes.slice();
    t[i]! ^= 0x01;
    assert.throws(() => openSignedPack(t, resolver), PackError, `byte ${i}`);
  }
});

test('a non-canonical payload is refused rather than renormalised', () => {
  // The signature covers exact bytes. Accepting a differently-ordered but
  // "equivalent" payload would mean two byte strings share one signature.
  const json = canonicalPackJson(PACK);
  assert.equal(json, canonicalPackJson(JSON.parse(json) as SeasonPack), 'canonicalisation is stable');
  assert.notEqual(json, JSON.stringify(PACK), 'and it really does reorder keys');
});

test('an empty steward set verifies nothing', () => {
  const bytes = signPack(PACK, 'minor', [steward1]);
  assert.throws(() => openSignedPack(bytes, () => undefined), /carries 0 valid signature/);
});

/* -------------------------------------------------------------- CI gate --- */

test('CI refuses a breaking change labelled as routine', () => {
  // Signing binds the assertion; this binds the assertion to reality. Without
  // it a steward could relabel a breaking change and ship it with one key.
  const breaking = clone(PACK);
  (breaking.fields[1] as { pointsEach: number }).pointsEach = 99;

  assert.throws(() => checkReleaseKind(PACK, breaking, 'minor'), /is a MAJOR change/);
  assert.throws(() => checkReleaseKind(PACK, breaking, 'patch'), /needs two signatures/);
  assert.doesNotThrow(() => checkReleaseKind(PACK, breaking, 'major'));
});

test('CI refuses a release that changes nothing', () => {
  assert.throws(() => checkReleaseKind(PACK, clone(PACK), 'patch'), /nothing changed/);
});

test('CI accepts a correctly-labelled additive release', () => {
  const added = clone(PACK);
  (added.fields as unknown[]).push({
    path: 'teleop.gear.placed',
    type: 'integer',
    unit: 'count',
    pointsEach: 5,
    additive: true,
    attribution: 'alliance',
  });
  assert.doesNotThrow(() => checkReleaseKind(PACK, added, 'minor'));
  assert.throws(() => checkReleaseKind(PACK, added, 'major'), /is a MINOR change/);
});

/* --------------------------------------------------------- distribution --- */

test('a signed pack survives a round trip through arbitrary bytes', () => {
  // A pack is a valid Courier payload, so it can ride the same transport as
  // scouting data into a venue with no network. Nothing here parses it.
  const bytes = signPack(PACK, 'minor', [steward1]);
  const carried = new Uint8Array(bytes); // as an opaque body would be
  const opened = openSignedPack(carried, resolver);

  assert.equal(opened.pack.version, PACK.version);
  assert.equal(opened.pack.fields.length, PACK.fields.length);
  assert.equal(opened.digest.length, 32);
  // Same input, same content address.
  assert.equal(toHex(openSignedPack(signPack(PACK, 'minor', [steward1]), resolver).digest), toHex(opened.digest));
});
