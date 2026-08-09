import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MemoryLink,
  syncOverLink,
  syncBothEnds,
  writeBundle,
  readBundle,
  peekBundle,
  mergeBundle,
  BundleError,
} from '../src/index.ts';
import {
  RecordStore,
  storesConverged,
  makeRecord,
  sealRecord,
  generateDeviceKey,
  generateMeshKey,
  mintScoutPseudonym,
  parseMatchKey,
  toHex,
  utf8,
  type DeviceKeyPair,
  type KeyResolver,
} from '@courier/core';

/* ------------------------------------------------------------- fixtures --- */

const meshKey = generateMeshKey();
const devices = new Map<string, DeviceKeyPair>();
function device(name: string): DeviceKeyPair {
  let d = devices.get(name);
  if (!d) {
    d = generateDeviceKey('software');
    devices.set(name, d);
  }
  return d;
}
const resolver: KeyResolver = (kid) => {
  for (const d of devices.values()) if (toHex(d.kid) === toHex(kid)) return d.publicKey;
  return undefined;
};

function fill(store: RecordStore, opts: { from: number; to: number; event?: string }): number {
  const eventKey = opts.event ?? '2027mose';
  let n = 0;
  for (let i = opts.from; i <= opts.to; i++) {
    const rec = makeRecord({
      eventKey,
      match: parseMatchKey(`${eventKey}_qm${(i % 80) + 1}`).packed,
      team: 8000 + (i % 40),
      scout: mintScoutPseudonym(`scout-${i % 6}`, eventKey, meshKey),
      schema: 'demo.scout.v1',
      body: utf8(`observation-${i}`),
      sealedAt: 1_800_000_000_000 + i,
    });
    if (store.admit(sealRecord(rec, device(`tablet-${i % 6}`)), resolver).status === 'admitted') n++;
  }
  return n;
}

/* ------------------------------------------------------------ link pair --- */

test('a paired link delivers frames in order, both ways', async () => {
  const [a, b] = MemoryLink.pair();
  await a.send(utf8('one'));
  await a.send(utf8('two'));
  assert.equal(new TextDecoder().decode((await b.receive())!), 'one');
  assert.equal(new TextDecoder().decode((await b.receive())!), 'two');

  await b.send(utf8('back'));
  assert.equal(new TextDecoder().decode((await a.receive())!), 'back');
});

test('receive resolves null once the link closes, rather than hanging', async () => {
  const [a, b] = MemoryLink.pair();
  const pending = b.receive();
  await a.close();
  assert.equal(await pending, null, 'a waiter must be released on close');
  assert.equal(await b.receive(), null, 'and stay resolved afterwards');
});

/* --------------------------------------------------------- sync over it --- */

test('two stores converge over a link, with both ends driven independently', async () => {
  const a = new RecordStore();
  const b = new RecordStore();
  fill(a, { from: 1, to: 120 });
  fill(b, { from: 100, to: 200 }); // overlapping, so both sides have news

  const [la, lb] = MemoryLink.pair('phone', 'laptop');
  const [oa, ob] = await syncBothEnds({ store: a, link: la }, { store: b, link: lb }, resolver);

  assert.ok(storesConverged(a, b), 'stores must hold the same set');
  assert.equal(a.size, 200);
  assert.equal(oa.rejected, 0);
  assert.equal(ob.rejected, 0);
  assert.ok(
    oa.ending === 'complete' || ob.ending === 'complete',
    `at least one side should see a clean finish, got ${oa.ending}/${ob.ending}`,
  );
  assert.ok(oa.bytesSent > 0 && ob.bytesSent > 0);
});

test('a link that dies mid-transfer leaves a valid, partially-synced store', async () => {
  // A scout walking out of range is the normal case, not an edge case. The
  // grow-only store means a half-finished session is simply a smaller one.
  const a = new RecordStore();
  const b = new RecordStore();
  fill(a, { from: 1, to: 300 });

  const [la, lb] = MemoryLink.pair();
  la.failAfterSends = 2; // drop after the second frame

  const [oa, ob] = await syncBothEnds({ store: a, link: la }, { store: b, link: lb }, resolver);

  assert.equal(a.size, 300, 'the sending store is untouched');
  assert.ok(b.size < 300, 'the receiver got less than everything');
  assert.ok(
    oa.ending === 'peer-hung-up' || ob.ending === 'peer-hung-up',
    `expected a hang-up, got ${oa.ending}/${ob.ending}`,
  );

  // Every record that did arrive is intact and verifiable — a partial sync must
  // never leave a torn record behind.
  for (const id of b.sortedIds) assert.ok(b.get(id), 'store stays self-consistent');

  // And a second session picks up from where the first stopped.
  const [la2, lb2] = MemoryLink.pair();
  await syncBothEnds({ store: a, link: la2 }, { store: b, link: lb2 }, resolver);
  assert.ok(storesConverged(a, b), 'the retry completes the job');
});

test('a corrupted frame can never admit an invalid record', async () => {
  // Corruption has two possible outcomes and both are safe: the frame fails to
  // decode as canonical CBOR, or it decodes but the envelope inside fails
  // signature verification. It is NOT true that corruption always breaks
  // decoding — flipping a byte inside a digest's XOR field yields a perfectly
  // valid message carrying a wrong digest — so the invariant worth asserting is
  // about admission, not about the error.
  const a = new RecordStore();
  const b = new RecordStore();
  fill(a, { from: 1, to: 40 });

  const [la, lb] = MemoryLink.pair();
  la.corruptEverySend = 1;

  const [, ob] = await syncBothEnds({ store: a, link: la }, { store: b, link: lb }, resolver);

  // Whatever happened, every record that reached the store is genuine.
  for (const id of b.sortedIds) {
    const stored = b.get(id);
    assert.ok(stored, 'store stays self-consistent');
    assert.equal(toHex(stored!.recordId), toHex(id), 'record id matches its index entry');
  }
  assert.ok(
    ob.ending === 'protocol-error' || ob.ending === 'peer-hung-up' || ob.ending === 'complete',
    `unexpected ending ${ob.ending}`,
  );
  // Nothing forged got in: b only ever holds records a actually signed.
  assert.ok(b.size <= a.size);
});

test('records are chunked, so a drop mid-transfer keeps what already landed', async () => {
  // The design's robustness claim is that a half-finished session is simply a
  // smaller one. That is only true if records travel in more than one frame —
  // a message is atomic, so an unchunked transfer is all-or-nothing.
  const a = new RecordStore();
  const b = new RecordStore();
  fill(a, { from: 1, to: 300 });

  const [la, lb] = MemoryLink.pair();
  la.failAfterSends = 4; // die a few frames into the record transfer

  await syncBothEnds({ store: a, link: la }, { store: b, link: lb }, resolver);

  assert.equal(a.size, 300, 'the sender is untouched');
  assert.ok(b.size > 0, `partial progress must survive, got ${b.size}`);
  assert.ok(b.size < 300, `and it must genuinely be partial, got ${b.size}`);

  // Resuming finishes the job with no special-casing — the store is grow-only.
  const [la2, lb2] = MemoryLink.pair();
  await syncBothEnds({ store: a, link: la2 }, { store: b, link: lb2 }, resolver);
  assert.ok(storesConverged(a, b), 'a retry completes it');
});

test('a peer that never stops talking is cut off by the round limit', async () => {
  const a = new RecordStore();
  const b = new RecordStore();
  fill(a, { from: 1, to: 500 });
  fill(b, { from: 400, to: 900 });

  const [la, lb] = MemoryLink.pair();
  const [oa] = await Promise.all([
    syncOverLink(a, resolver, la, 'initiator', { maxRounds: 2 }),
    syncOverLink(b, resolver, lb, 'responder', { maxRounds: 2 }),
  ]);
  assert.ok(
    oa.ending === 'round-limit' || oa.ending === 'peer-hung-up',
    `a capped session must stop, got ${oa.ending}`,
  );
  assert.ok(oa.rounds <= 2);
});

test('progress is reported as records land', async () => {
  const a = new RecordStore();
  const b = new RecordStore();
  fill(a, { from: 1, to: 60 });

  const seen: number[] = [];
  const [la, lb] = MemoryLink.pair();
  await Promise.all([
    syncOverLink(a, resolver, la, 'initiator'),
    syncOverLink(b, resolver, lb, 'responder', {
      onProgress: (_rounds, admitted) => seen.push(admitted),
    }),
  ]);
  assert.ok(seen.length > 0, 'progress callback must fire');
  assert.equal(b.size, 60);
});

/* --------------------------------------------------------------- bundles -- */

test('a bundle round-trips through the wire format', () => {
  const store = new RecordStore();
  const n = fill(store, { from: 1, to: 50 });

  const bytes = writeBundle(store, { eventKey: '2027mose', producer: 'pit-laptop', createdAt: 1_800_000_000_000 });
  const bundle = readBundle(bytes);

  assert.equal(bundle.eventKey, '2027mose');
  assert.equal(bundle.producer, 'pit-laptop');
  assert.equal(bundle.count, n);
  assert.equal(bundle.envelopes.length, n);

  const meta = peekBundle(bytes);
  assert.equal(meta.count, n);
  assert.equal(meta.createdAt, 1_800_000_000_000);
});

test('sneakernet: a bundle carries a full store to a machine with no radio', () => {
  const phone = new RecordStore();
  fill(phone, { from: 1, to: 200 });

  const flashDrive = writeBundle(phone, { eventKey: '2027mose', producer: 'phone-3' });

  const laptop = new RecordStore();
  const r = mergeBundle(laptop, flashDrive, resolver, '2027mose');

  assert.equal(r.admitted, 200);
  assert.equal(r.rejected, 0);
  assert.ok(storesConverged(phone, laptop));
});

test('merging the same bundle twice is idempotent', () => {
  const phone = new RecordStore();
  fill(phone, { from: 1, to: 30 });
  const bytes = writeBundle(phone, { eventKey: '2027mose', producer: 'phone-1' });

  const laptop = new RecordStore();
  assert.equal(mergeBundle(laptop, bytes, resolver).admitted, 30);
  const second = mergeBundle(laptop, bytes, resolver);
  assert.equal(second.admitted, 0);
  assert.equal(second.duplicates, 30);
  assert.equal(laptop.size, 30);
});

test('a bundle only carries records for the event it declares', () => {
  const store = new RecordStore();
  fill(store, { from: 1, to: 20, event: '2027mose' });
  fill(store, { from: 21, to: 40, event: '2027wamo' });

  const bytes = writeBundle(store, { eventKey: '2027mose', producer: 'x' });
  const bundle = readBundle(bytes);
  assert.equal(bundle.count, 20, 'records from another event must not be swept in');
});

test('a bundle for the wrong event is refused wholesale, not merged partially', () => {
  const store = new RecordStore();
  fill(store, { from: 1, to: 10, event: '2027wamo' });
  const bytes = writeBundle(store, { eventKey: '2027wamo', producer: 'x' });

  const laptop = new RecordStore();
  const r = mergeBundle(laptop, bytes, resolver, '2027mose');
  assert.equal(r.wrongEvent, 10);
  assert.equal(r.admitted, 0);
  assert.equal(laptop.size, 0, 'nothing merged at all');
});

test("a stranger's flash drive is exactly as safe as your own", () => {
  // The bundle is unsigned by design — every record inside it is already
  // independently signed, so a bundle signature would authenticate the courier
  // rather than the cargo, and the courier is a FAT32 volume anyone can write.
  const strangerDevice = generateDeviceKey('software');
  const stranger = new RecordStore();
  const rec = makeRecord({
    eventKey: '2027mose',
    match: parseMatchKey('2027mose_qm1').packed,
    team: 254,
    scout: mintScoutPseudonym('them', '2027mose', generateMeshKey()),
    schema: 'demo.scout.v1',
    body: utf8('forged'),
    sealedAt: 1_800_000_000_000,
  });
  stranger.admit(sealRecord(rec, strangerDevice), () => strangerDevice.publicKey);

  const bytes = writeBundle(stranger, { eventKey: '2027mose', producer: 'not-ours' });
  const mine = new RecordStore();
  const r = mergeBundle(mine, bytes, resolver, '2027mose');

  assert.equal(r.admitted, 0);
  assert.equal(r.rejected, 1);
  assert.match(r.reasons[0]!, /unknown key id/);
  assert.equal(mine.size, 0);
});

test('a truncated or malformed bundle is rejected with a clear reason', () => {
  const store = new RecordStore();
  fill(store, { from: 1, to: 5 });
  const bytes = writeBundle(store, { eventKey: '2027mose', producer: 'x' });

  assert.throws(() => readBundle(bytes.slice(0, bytes.length - 10)), BundleError);
  assert.throws(() => readBundle(new Uint8Array([1, 2, 3])), BundleError);
  assert.throws(() => readBundle(new Uint8Array(0)), BundleError);
});

test('bundles compose with links: sneakernet in, radio out', async () => {
  // The realistic event-day shape — a phone hands its day over by USB, and the
  // laptop then gossips it onward to a second phone over a link.
  const phone1 = new RecordStore();
  fill(phone1, { from: 1, to: 100 });

  const laptop = new RecordStore();
  mergeBundle(laptop, writeBundle(phone1, { eventKey: '2027mose', producer: 'phone-1' }), resolver);
  assert.equal(laptop.size, 100);

  const phone2 = new RecordStore();
  fill(phone2, { from: 101, to: 150 });

  const [l1, l2] = MemoryLink.pair();
  await syncBothEnds({ store: laptop, link: l1 }, { store: phone2, link: l2 }, resolver);

  assert.ok(storesConverged(laptop, phone2));
  assert.equal(laptop.size, 150);
});
