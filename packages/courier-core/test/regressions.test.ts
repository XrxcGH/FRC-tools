/**
 * Regressions for defects found by adversarial review that the original suite
 * was shaped around rather than over.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  RecordStore,
  AntiEntropySession,
  reconcile,
  storesConverged,
  encodeSyncMessage,
  decodeSyncMessage,
  makeRecord,
  sealRecord,
  recordId,
  parseMatchKey,
  toHex,
  utf8,
  ID_PREFIX_BYTES,
  HASH_BYTES,
  type SyncMessage,
} from '../src/index.ts';
import { TestMesh } from './helpers.ts';

const EVENT = '2027mose';
const MATCH = parseMatchKey(`${EVENT}_qm42`).packed;

/* ------------------------------------------------------------- Finding 1 -- */

test('a peer holding two records under one truncated id gets both requested', () => {
  // Truncated ids are 8 bytes and are NOT record identities. When a peer's leaf
  // holds two records sharing a prefix, presence-based comparison sees the
  // prefix already present locally and never asks for the sibling — leaving the
  // stores permanently divergent while the protocol falls silent.
  //
  // Forcing a real BLAKE3 collision would take ~2^32 work, so this drives the
  // decision path directly: the peer's id list reports one prefix twice, we
  // hold one record with it, and we must ask for more.
  const mesh = new TestMesh();
  const store = new RecordStore();
  const { envelope, record } = mesh.seal({
    device: 'tablet-1',
    scout: 'ada',
    matchKey: `${EVENT}_qm42`,
    team: 8793,
    body: utf8('mine'),
  });
  assert.equal(store.admit(envelope, mesh.resolver).status, 'admitted');

  const mineTrunc = recordId(record).slice(0, ID_PREFIX_BYTES);
  const session = new AntiEntropySession(store, mesh.resolver);

  // The peer reports the SAME truncated id twice: two records, one prefix.
  const peerMessage: SyncMessage = {
    idLists: [{ prefix: '', ids: [mineTrunc, mineTrunc] }],
  };
  const reply = session.receive(decodeSyncMessage(encodeSyncMessage(peerMessage)));

  assert.ok(reply, 'must not fall silent while the peer holds a record we lack');
  assert.ok(reply!.want?.length, 'must ask for the colliding sibling');
  assert.equal(toHex(reply!.want![0]!), toHex(mineTrunc));
});

test('a want for a truncated id is served with every record sharing it', () => {
  const mesh = new TestMesh();
  const store = new RecordStore();
  const { envelope, record } = mesh.seal({
    device: 'tablet-1',
    scout: 'ada',
    matchKey: `${EVENT}_qm42`,
    team: 8793,
    body: utf8('x'),
  });
  store.admit(envelope, mesh.resolver);

  const session = new AntiEntropySession(store, mesh.resolver);
  const reply = session.receive({ want: [recordId(record).slice(0, ID_PREFIX_BYTES)] });

  assert.ok(reply?.records?.length === 1, 'the requested record is served');
  assert.equal(toHex(reply!.records![0]!), toHex(envelope));
});

test('reconcile reports convergence only when the sets actually match', () => {
  // Reporting success off "the conversation went quiet" is how a stranded
  // record reaches a picklist while the operator is told the sync worked.
  const mesh = new TestMesh();
  const a = new RecordStore();
  const b = new RecordStore();
  for (let i = 0; i < 12; i++) {
    const { envelope } = mesh.seal({
      device: `tablet-${i % 3}`,
      scout: `scout-${i % 3}`,
      matchKey: `${EVENT}_qm${i + 1}`,
      team: 8793,
      body: utf8(`obs-${i}`),
    });
    a.admit(envelope, mesh.resolver);
  }

  const res = reconcile(a, b, mesh.resolver);
  assert.equal(res.converged, true);
  assert.equal(res.quiet, true);
  assert.equal(res.setsEqual, true);
  assert.ok(storesConverged(a, b));

  // A capped run that cannot finish must not claim convergence.
  const c = new RecordStore();
  const capped = reconcile(a, c, mesh.resolver, 1);
  assert.equal(capped.converged, false, 'a truncated exchange is not convergence');
  assert.equal(capped.setsEqual, false);
});

/* ------------------------------------------------------------- Finding 2 -- */

test('one scout cannot supersede another scout observation', () => {
  // `supersedes` is an arbitrary 32-byte value chosen by whoever seals the
  // record. Honouring it across scouts lets any mesh member delete a rival's
  // observation from the current view — destroying the second opinion the
  // reliability model exists to consume.
  const mesh = new TestMesh();
  const store = new RecordStore();

  const bo = mesh.seal({
    device: 'tablet-2',
    scout: 'bo',
    matchKey: `${EVENT}_qm42`,
    team: 8793,
    body: utf8('{"teleop":11}'),
  });
  store.admit(bo.envelope, mesh.resolver);

  // Ada points at Bo's record and claims to supersede it.
  const hostile = makeRecord({
    eventKey: EVENT,
    match: MATCH,
    team: 8793,
    scout: mesh.scout('ada', EVENT),
    schema: 'demo.scout.v1',
    body: utf8('{"teleop":0}'),
    revision: 1,
    supersedes: recordId(bo.record),
    sealedAt: 1_800_000_060_000,
  });
  store.admit(sealRecord(hostile, mesh.device('tablet-1')), mesh.resolver);

  const current = store.currentForObservation(EVENT, MATCH, 8793);
  assert.equal(current.length, 2, "Bo's observation must survive Ada's pointer");

  const scouts = new Set(current.map((s) => toHex(s.record.scout)));
  assert.ok(scouts.has(toHex(mesh.scout('bo', EVENT))), 'bo is still present');
  assert.ok(scouts.has(toHex(mesh.scout('ada', EVENT))), 'ada is present too');
});

test('a scout can still supersede their own earlier revision', () => {
  const mesh = new TestMesh();
  const store = new RecordStore();

  const first = mesh.seal({
    device: 'tablet-1',
    scout: 'ada',
    matchKey: `${EVENT}_qm42`,
    team: 8793,
    body: utf8('{"teleop":11}'),
  });
  store.admit(first.envelope, mesh.resolver);

  const corrected = makeRecord({
    eventKey: EVENT,
    match: MATCH,
    team: 8793,
    scout: mesh.scout('ada', EVENT),
    schema: 'demo.scout.v1',
    body: utf8('{"teleop":13}'),
    revision: 1,
    supersedes: recordId(first.record),
    sealedAt: 1_800_000_060_000,
  });
  store.admit(sealRecord(corrected, mesh.device('tablet-1')), mesh.resolver);

  const current = store.currentForObservation(EVENT, MATCH, 8793);
  assert.equal(current.length, 1, 'the correction replaces the original');
  assert.equal(current[0]!.record.revision, 1);
  assert.equal(store.size, 2, 'and both stay in the append-only log');
});

test('a supersede pointer at a record from another observation is ignored', () => {
  const mesh = new TestMesh();
  const store = new RecordStore();

  const other = mesh.seal({
    device: 'tablet-1',
    scout: 'ada',
    matchKey: `${EVENT}_qm1`,
    team: 8793,
    body: utf8('elsewhere'),
  });
  store.admit(other.envelope, mesh.resolver);

  const here = makeRecord({
    eventKey: EVENT,
    match: MATCH,
    team: 8793,
    scout: mesh.scout('ada', EVENT),
    schema: 'demo.scout.v1',
    body: utf8('here'),
    revision: 1,
    supersedes: recordId(other.record),
    sealedAt: 1_800_000_060_000,
  });
  store.admit(sealRecord(here, mesh.device('tablet-1')), mesh.resolver);

  assert.equal(store.currentForObservation(EVENT, parseMatchKey(`${EVENT}_qm1`).packed, 8793).length, 1);
  assert.equal(store.currentForObservation(EVENT, MATCH, 8793).length, 1);
});

/* ------------------------------------------------------------- Finding 3 -- */

test('crafted sync messages are rejected at decode, not thrown from receive', () => {
  const mesh = new TestMesh();
  const store = new RecordStore();
  const session = new AntiEntropySession(store, mesh.resolver);

  const hostile: Array<[string, SyncMessage]> = [
    ['non-hex prefix', { digests: [{ prefix: 'zz', count: 1, xor: new Uint8Array(HASH_BYTES) }] }],
    [
      'oversized prefix',
      { digests: [{ prefix: 'a'.repeat(5000), count: 1, xor: new Uint8Array(HASH_BYTES) }] },
    ],
    ['uppercase prefix', { digests: [{ prefix: 'AB', count: 1, xor: new Uint8Array(HASH_BYTES) }] }],
    ['short xor', { digests: [{ prefix: '', count: 1, xor: new Uint8Array(4) }] }],
    ['non-hex id list prefix', { idLists: [{ prefix: 'q', ids: [] }] }],
  ];

  for (const [name, msg] of hostile) {
    const wire = encodeSyncMessage(msg);
    assert.throws(() => decodeSyncMessage(wire), /prefix|xor|hex|depth|bytes/i, `${name} must be refused`);
  }

  // And a well-formed message still works, so the guards are not over-broad.
  const ok = decodeSyncMessage(encodeSyncMessage(session.start()));
  assert.equal(ok.digests!.length, 1);
});

test('a truncated id of the wrong width is refused', () => {
  const bad = encodeSyncMessage({ want: [new Uint8Array(4)] });
  assert.throws(() => decodeSyncMessage(bad), /truncated id/);
});
