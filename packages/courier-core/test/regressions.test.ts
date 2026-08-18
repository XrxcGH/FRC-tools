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
  supersede,
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

test('a SPLIT truncated-id collision is not stranded forever', () => {
  // The harder half of the same problem, and the one the multimap fix missed.
  // The earlier case has both colliding records in ONE store, so the counts
  // disagree (2 vs 1) and the id-list diff notices. Give one record to each
  // peer instead and every count matches at 1 == 1: no want, no give, an empty
  // reply, and the session falls silent — identically on every future session,
  // so both records are stranded permanently. Splitting the pair is strictly
  // cheaper for the same attacker the module already puts in scope.
  //
  // Forcing a real BLAKE3 collision is ~2^32 work, so as with the test above
  // this drives the decision path directly: the peer reports ONE record under a
  // prefix we also hold exactly once. An id list only ever arrives because the
  // digests disagreed, so equal counts leave a collision as the only
  // explanation and we must not conclude "nothing to do".
  const mesh = new TestMesh();
  const store = new RecordStore();
  const { envelope, record } = mesh.seal({
    device: 'tablet-1',
    scout: 'ada',
    matchKey: `${EVENT}_qm42`,
    team: 8793,
    body: utf8('ours'),
  });
  assert.equal(store.admit(envelope, mesh.resolver).status, 'admitted');

  const mineTrunc = recordId(record).slice(0, ID_PREFIX_BYTES);
  const session = new AntiEntropySession(store, mesh.resolver);
  const peerMessage: SyncMessage = { idLists: [{ prefix: '', ids: [mineTrunc] }] };
  const reply = session.receive(decodeSyncMessage(encodeSyncMessage(peerMessage)));

  assert.ok(reply, 'fell silent on a split collision — both records strand forever');
  assert.ok(reply!.want?.length, 'must ask, since counts cannot tell these apart');
  assert.equal(toHex(reply!.want![0]!), toHex(mineTrunc));
  // And offer ours in the same breath, or the peer is still missing it after
  // we have been made whole.
  assert.ok(reply!.records?.length, 'must offer our side of the pair too');
});

test('the split-collision fallback stays quiet when the counts explain the difference', () => {
  // The fallback must not fire on ordinary syncs, or every leaf gets dumped
  // wholesale on every round and the ≤2 round-trip budget is gone.
  const mesh = new TestMesh();
  const store = new RecordStore();
  const seal = (body: string) =>
    mesh.seal({
      device: 'tablet-1',
      scout: 'ada',
      matchKey: `${EVENT}_qm42`,
      team: 8793,
      body: utf8(body),
    });

  const ours = seal('ours');
  store.admit(ours.envelope, mesh.resolver);
  const theirs = seal('theirs');

  const session = new AntiEntropySession(store, mesh.resolver);
  const reply = session.receive(
    decodeSyncMessage(
      encodeSyncMessage({
        idLists: [
          {
            prefix: '',
            ids: [
              recordId(ours.record).slice(0, ID_PREFIX_BYTES),
              recordId(theirs.record).slice(0, ID_PREFIX_BYTES),
            ],
          },
        ],
      }),
    ),
  );

  assert.ok(reply);
  // One want, for the record we genuinely lack — not one per prefix in the list.
  assert.equal(reply!.want?.length, 1);
  assert.equal(
    toHex(reply!.want![0]!),
    toHex(recordId(theirs.record).slice(0, ID_PREFIX_BYTES)),
  );
  assert.ok(!reply!.records?.length, 'offered records the peer already listed');
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

test('the current view of the whole store drops superseded revisions', () => {
  // The bug this guards, found by reading the picklist command rather than by a
  // failing test: analysis read `sortedIds`, which is the SYNC view — every
  // record ever admitted, because a peer that has not seen a correction still
  // needs the original to reconcile against. Averaged, a scout who fixed a typo
  // counts twice, once at the wrong number and once at the right one, and both
  // values are individually plausible so nothing catches it.
  const mesh = new TestMesh();
  const store = new RecordStore();

  const first = mesh.seal({
    device: 'tablet-1',
    scout: 'ada',
    matchKey: `${EVENT}_qm7`,
    team: 8793,
    body: utf8('{"teleop":110}'), // a slipped keystroke
  });
  store.admit(first.envelope, mesh.resolver);

  const fixed = supersede(first.record, utf8('{"teleop":11}'), 1_800_000_060_000);
  store.admit(sealRecord(fixed, mesh.device('tablet-1')), mesh.resolver);

  // A second scout on the same robot must survive: a correction by one scout is
  // not a correction of anyone else's observation.
  const bo = mesh.seal({
    device: 'tablet-2',
    scout: 'bo',
    matchKey: `${EVENT}_qm7`,
    team: 8793,
    body: utf8('{"teleop":12}'),
  });
  store.admit(bo.envelope, mesh.resolver);

  assert.equal(store.size, 3, 'the log keeps all three');
  const current = store.currentRecords();
  assert.equal(current.length, 2, 'the current view keeps one per scout');
  assert.equal(store.supersededCount(), 1);

  const bodies = current.map((s) => new TextDecoder().decode(s.record.body)).sort();
  assert.deepEqual(bodies, ['{"teleop":11}', '{"teleop":12}']);
});

test('the current view is ordered identically on two devices', () => {
  // Two devices that hold the same records must produce the same sequence, or
  // an analysis that depends on order — CUSUM over a scout's matches — reports
  // different answers in the pit and in the stands.
  const mesh = new TestMesh();
  const a = new RecordStore();
  const b = new RecordStore();

  const sealed = [];
  for (let m = 1; m <= 6; m++) {
    for (const scout of ['ada', 'bo']) {
      sealed.push(
        mesh.seal({
          device: 'tablet-1',
          scout,
          matchKey: `${EVENT}_qm${m}`,
          team: 8790 + (m % 3),
          body: utf8(`{"teleop":${m}}`),
        }),
      );
    }
  }
  for (const s of sealed) a.admit(s.envelope, mesh.resolver);
  for (const s of [...sealed].reverse()) b.admit(s.envelope, mesh.resolver);

  const key = (store: RecordStore) =>
    store.currentRecords().map((s) => toHex(s.recordId)).join(',');
  assert.equal(key(a), key(b), 'admission order leaked into the analysis view');
});

test('a same-scout re-scan is a conflict, not a correction', () => {
  // A scout who fixes an entry and re-prints the QR produces two scans. The
  // Bridge seals both with revision 0 and supersedes null — it cannot know the
  // second is a correction — so the store has two heads from one scout and
  // breaks the tie on record-id bytes. That is a hash deciding which number the
  // team believes, and reporting it as "superseded, the corrections are what
  // you have" says the opposite of what happened about half the time.
  const mesh = new TestMesh();
  const store = new RecordStore();
  const scan = (body: string, at: number) =>
    mesh.seal({
      device: 'tablet-1',
      scout: 'ada',
      matchKey: `${EVENT}_qm1`,
      team: 8793,
      body: utf8(body),
      sealedAt: at,
    });

  store.admit(scan('first try', 1_800_000_000_000).envelope, mesh.resolver);
  store.admit(scan('corrected', 1_800_000_060_000).envelope, mesh.resolver);

  assert.equal(store.size, 2);
  assert.equal(store.currentRecords().length, 1, 'the store must still resolve to one');

  const conflicts = store.conflicts();
  assert.equal(conflicts.length, 1);
  assert.equal(conflicts[0]!.team, 8793);
  assert.equal(conflicts[0]!.dropped.length, 1);
  assert.equal(toHex(conflicts[0]!.kept), toHex(store.currentRecords()[0]!.recordId));
});

test('an explicit correction is a supersession and not reported as a conflict', () => {
  const mesh = new TestMesh();
  const store = new RecordStore();
  const first = mesh.seal({
    device: 'tablet-1',
    scout: 'ada',
    matchKey: `${EVENT}_qm1`,
    team: 8793,
    body: utf8('typo'),
  });
  store.admit(first.envelope, mesh.resolver);
  const fixed = supersede(first.record, utf8('right'), 1_800_000_060_000);
  store.admit(sealRecord(fixed, mesh.device('tablet-1')), mesh.resolver);

  assert.equal(store.currentRecords().length, 1);
  assert.deepEqual(store.conflicts(), [], 'a real correction is not a coin toss');
  assert.equal(
    new TextDecoder().decode(store.currentRecords()[0]!.record.body),
    'right',
    'the correction must win, not the hash',
  );
});

test('two identical scans from one scout are not a conflict', () => {
  // Whichever survives says the same thing. Flagging it would train people to
  // ignore the warning that matters.
  const mesh = new TestMesh();
  const store = new RecordStore();
  for (const at of [1_800_000_000_000, 1_800_000_030_000]) {
    store.admit(
      mesh.seal({
        device: 'tablet-1',
        scout: 'ada',
        matchKey: `${EVENT}_qm1`,
        team: 8793,
        body: utf8('same'),
        sealedAt: at,
      }).envelope,
      mesh.resolver,
    );
  }
  assert.equal(store.size, 2);
  assert.deepEqual(store.conflicts(), []);
});

test('two scouts disagreeing is not a conflict — it is the point', () => {
  const mesh = new TestMesh();
  const store = new RecordStore();
  for (const scout of ['ada', 'bo']) {
    store.admit(
      mesh.seal({
        device: 'tablet-1',
        scout,
        matchKey: `${EVENT}_qm1`,
        team: 8793,
        body: utf8(`${scout} saw it differently`),
      }).envelope,
      mesh.resolver,
    );
  }
  assert.equal(store.currentRecords().length, 2, 'both opinions must survive');
  assert.deepEqual(store.conflicts(), []);
});
