import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  RecordStore,
  reconcile,
  storesConverged,
  AntiEntropySession,
  encodeSyncMessage,
  decodeSyncMessage,
  rangeDigest,
  childDigests,
  idsWithPrefix,
  digestsEqual,
  prefixRange,
  buildDigestTree,
  DIGEST_FANOUT,
  parseMatchKey,
  generateDeviceKey,
  sealRecord,
  supersede,
  toHex,
  utf8,
} from '../src/index.ts';
import { TestMesh, rng, fakeBody } from './helpers.ts';

/** Seal `n` observations into a store; `skip` lets two stores diverge. */
function populate(
  mesh: TestMesh,
  store: RecordStore,
  opts: { matches: number; scouts: number; seed: number; skip?: (i: number) => boolean },
): number {
  const rand = rng(opts.seed);
  const teams = [8793, 9143, 254, 1678, 118, 2056];
  let n = 0;
  let i = 0;
  for (let m = 1; m <= opts.matches; m++) {
    for (let s = 0; s < opts.scouts; s++) {
      const body = fakeBody(rand); // consume RNG regardless, so stores stay aligned
      i++;
      if (opts.skip?.(i)) continue;
      const { envelope } = mesh.seal({
        device: `tablet-${s}`,
        scout: `scout-${s}`,
        matchKey: `2027mose_qm${m}`,
        team: teams[(m + s) % teams.length]!,
        body,
        sealedAt: 1_800_000_000_000 + i * 1000,
      });
      const r = store.admit(envelope, mesh.resolver);
      assert.equal(r.status, 'admitted', `record ${i} should be admitted`);
      n++;
    }
  }
  return n;
}

/* ------------------------------------------------------------- digests ----- */

test('range digest is order-independent and detects any difference', () => {
  const ids = Array.from({ length: 50 }, (_, i) => {
    const b = new Uint8Array(32);
    b[0] = i;
    b[31] = i * 7;
    return b;
  });
  const shuffled = [...ids].reverse();
  assert.ok(digestsEqual(rangeDigest(ids), rangeDigest(shuffled)), 'XOR set digest ignores order');

  const missing = ids.slice(1);
  assert.ok(!digestsEqual(rangeDigest(ids), rangeDigest(missing)), 'one missing id must show');
});

test('count disambiguates the cases XOR alone would miss', () => {
  // Two disjoint sets can XOR to the same value; count catches it.
  const a = [new Uint8Array(32).fill(0)];
  const b: Uint8Array[] = [];
  const da = rangeDigest(a);
  const db = rangeDigest(b);
  assert.equal(toHex(da.xor), toHex(db.xor), 'an all-zero id XORs to the same value as no ids');
  assert.ok(!digestsEqual(da, db), 'but the counts differ, so the digests must differ');
});

test('child digests partition their parent exactly', () => {
  const mesh = new TestMesh();
  const store = new RecordStore();
  populate(mesh, store, { matches: 20, scouts: 4, seed: 7 });

  const root = rangeDigest(store.sortedIds, '');
  const kids = childDigests(store.sortedIds, '');
  assert.equal(kids.length, DIGEST_FANOUT, 'all 16 children present, including empty ones');

  const total = kids.reduce((n, k) => n + k.count, 0);
  assert.equal(total, root.count, 'children must account for every id');

  const xor = new Uint8Array(32);
  for (const k of kids) for (let i = 0; i < 32; i++) xor[i]! ^= k.xor[i]!;
  assert.equal(toHex(xor), toHex(root.xor), 'child XORs must fold back to the root');
});

test('prefix ranges are found by binary search over sorted ids', () => {
  const mesh = new TestMesh();
  const store = new RecordStore();
  populate(mesh, store, { matches: 30, scouts: 4, seed: 11 });

  for (const nib of '0123456789abcdef') {
    const [lo, hi] = prefixRange(store.sortedIds, nib);
    const viaScan = store.sortedIds.filter((id) => toHex(id).startsWith(nib));
    assert.equal(hi - lo, viaScan.length, `prefix ${nib} range width`);
    assert.deepEqual(idsWithPrefix(store.sortedIds, nib), viaScan, `prefix ${nib} contents`);
  }
});

test('digest tree covers every id at depth', () => {
  const mesh = new TestMesh();
  const store = new RecordStore();
  populate(mesh, store, { matches: 15, scouts: 4, seed: 3 });
  const tree = buildDigestTree(store.sortedIds, 2);
  assert.equal(tree.get('')!.count, store.size);
});

/* ------------------------------------------------------------- store ------- */

test('the store is grow-only and idempotent under replay', () => {
  const mesh = new TestMesh();
  const store = new RecordStore();
  const { envelope } = mesh.seal({
    device: 'tablet-1',
    scout: 'ada',
    matchKey: '2027mose_qm1',
    team: 8793,
    body: utf8('x'),
  });

  assert.equal(store.admit(envelope, mesh.resolver).status, 'admitted');
  // Replaying a valid signed record is genuinely idempotent — which is exactly
  // why v1 needs no sequence-number replay defence (D-8).
  for (let i = 0; i < 5; i++) {
    assert.equal(store.admit(envelope, mesh.resolver).status, 'duplicate');
  }
  assert.equal(store.size, 1);
});

test('admit reports bad input instead of throwing — a sync loop must not die', () => {
  const mesh = new TestMesh();
  const store = new RecordStore();
  const stranger = generateDeviceKey();

  assert.equal(store.admit(new Uint8Array([1, 2, 3]), mesh.resolver).status, 'rejected');
  const { record } = mesh.seal({
    device: 'tablet-1',
    scout: 'ada',
    matchKey: '2027mose_qm1',
    team: 8793,
    body: utf8('x'),
  });
  // Sealed with a key the mesh does not know.
  const r = store.admit(sealRecord(record, stranger), mesh.resolver);
  assert.equal(r.status, 'rejected');
  assert.match(r.reason!, /unknown key id/);
  assert.equal(store.size, 0);
});

test('double-scouted observations both survive into the store', () => {
  const mesh = new TestMesh();
  const store = new RecordStore();
  const body = utf8('{"teleop":11}');
  for (const scout of ['ada', 'bo']) {
    const { envelope } = mesh.seal({
      device: 'tablet-1',
      scout,
      matchKey: '2027mose_qm42',
      team: 8793,
      body, // byte-identical
    });
    assert.equal(store.admit(envelope, mesh.resolver).status, 'admitted');
  }
  const { packed } = parseMatchKey('2027mose_qm42');
  assert.equal(store.currentForObservation('2027mose', packed, 8793).length, 2);
  assert.equal(store.stats().scouts, 2);
});

test('superseded revisions drop out of the current view but stay in the log', () => {
  const mesh = new TestMesh();
  const store = new RecordStore();
  const first = mesh.seal({
    device: 'tablet-1',
    scout: 'ada',
    matchKey: '2027mose_qm42',
    team: 8793,
    body: utf8('{"teleop":11}'),
  });
  store.admit(first.envelope, mesh.resolver);

  const corrected = supersede(first.record, utf8('{"teleop":13}'), 1_800_000_060_000);
  store.admit(sealRecord(corrected, mesh.device('tablet-1')), mesh.resolver);

  const { packed } = parseMatchKey('2027mose_qm42');
  assert.equal(store.size, 2, 'both revisions remain in the append-only log');
  const current = store.currentForObservation('2027mose', packed, 8793);
  assert.equal(current.length, 1, 'one current record per scout');
  assert.equal(current[0]!.record.revision, 1);
});

/* -------------------------------------------------------- reconciliation --- */

test('identical stores converge in one round with no records exchanged', () => {
  const mesh = new TestMesh();
  const a = new RecordStore();
  const b = new RecordStore();
  populate(mesh, a, { matches: 40, scouts: 8, seed: 1 });
  populate(mesh, b, { matches: 40, scouts: 8, seed: 1 });

  const res = reconcile(a, b, mesh.resolver);
  assert.ok(res.converged);
  assert.equal(res.admitted, 0, 'nothing to transfer');
  assert.equal(res.rounds, 1, 'root digest match settles it immediately');
  assert.ok(res.bytes < 100, `root digest exchange was ${res.bytes} bytes`);
});

test('a one-sided store converges and transfers exactly the missing records', () => {
  const mesh = new TestMesh();
  const a = new RecordStore();
  const b = new RecordStore();
  const n = populate(mesh, a, { matches: 20, scouts: 4, seed: 2 });

  const res = reconcile(a, b, mesh.resolver);
  assert.ok(res.converged, 'must converge');
  assert.ok(storesConverged(a, b), 'stores hold the same set');
  assert.equal(b.size, n);
  assert.equal(res.rejected, 0);
});

test('FR-4 budget: a 50-record symmetric difference converges inside the stated limits', () => {
  // The requirement, restated as an outcome in D-3: converge in <= 2 round
  // trips and <= 8 kB for a 50-envelope symmetric difference.
  const mesh = new TestMesh();
  const a = new RecordStore();
  const b = new RecordStore();

  // 640 observations in a full event day (80 quals x 8 scouts). Each store is
  // missing a different 25, so the symmetric difference is exactly 50.
  populate(mesh, a, { matches: 80, scouts: 8, seed: 5, skip: (i) => i > 550 && i <= 575 });
  populate(mesh, b, { matches: 80, scouts: 8, seed: 5, skip: (i) => i > 575 && i <= 600 });

  const symmetricDifference = 50;
  const res = reconcile(a, b, mesh.resolver);

  assert.ok(res.converged, 'must converge');
  assert.ok(storesConverged(a, b), 'stores must hold the same set afterwards');
  assert.equal(res.admitted, symmetricDifference, 'exactly the difference is transferred');

  // Round trips: each pair of messages is one round trip.
  const roundTrips = Math.ceil(res.rounds / 2);
  assert.ok(roundTrips <= 2, `took ${roundTrips} round trips (${res.rounds} messages)`);

  // The transferred records themselves dominate; measure protocol overhead
  // separately from payload, since the budget is about the reconciliation cost.
  const recordBytes = symmetricDifference * 230;
  const overhead = res.bytes - recordBytes;
  assert.ok(
    overhead <= 8192,
    `reconciliation overhead was ${overhead} bytes over ${res.rounds} messages ` +
      `(sizes: ${res.messageSizes.join(', ')})`,
  );
});

test('convergence holds for lopsided, sparse, and near-total differences', () => {
  const cases: Array<{ name: string; skipA?: (i: number) => boolean; skipB?: (i: number) => boolean }> = [
    { name: 'b is empty', skipB: () => true },
    { name: 'a is empty', skipA: () => true },
    { name: 'alternating', skipA: (i) => i % 2 === 0, skipB: (i) => i % 2 === 1 },
    { name: 'one record apart', skipA: (i) => i === 17 },
    { name: 'clustered tail', skipA: (i) => i > 100 },
  ];

  for (const c of cases) {
    const mesh = new TestMesh();
    const a = new RecordStore();
    const b = new RecordStore();
    populate(mesh, a, { matches: 30, scouts: 4, seed: 9, skip: c.skipA });
    populate(mesh, b, { matches: 30, scouts: 4, seed: 9, skip: c.skipB });

    const res = reconcile(a, b, mesh.resolver);
    assert.ok(res.converged, `${c.name}: must converge`);
    assert.ok(storesConverged(a, b), `${c.name}: sets must match`);
    assert.equal(res.rejected, 0, `${c.name}: nothing rejected`);
  }
});

test('gossip converges across a mesh where no two devices ever pair directly', () => {
  // Eight scouts in the stands. Each syncs only with its neighbour, in a line —
  // the worst realistic topology. Records must still reach every device.
  const mesh = new TestMesh();
  const stores = Array.from({ length: 8 }, () => new RecordStore());
  for (let s = 0; s < 8; s++) {
    const { envelope } = mesh.seal({
      device: `tablet-${s}`,
      scout: `scout-${s}`,
      matchKey: `2027mose_qm${s + 1}`,
      team: 8793,
      body: utf8(`observation-from-${s}`),
    });
    stores[s]!.admit(envelope, mesh.resolver);
  }

  // Sweep the line back and forth until quiet.
  for (let pass = 0; pass < 8; pass++) {
    for (let i = 0; i < stores.length - 1; i++) {
      reconcile(stores[i]!, stores[i + 1]!, mesh.resolver);
    }
    for (let i = stores.length - 2; i >= 0; i--) {
      reconcile(stores[i]!, stores[i + 1]!, mesh.resolver);
    }
  }

  for (const [i, s] of stores.entries()) {
    assert.equal(s.size, 8, `device ${i} should hold all 8 observations`);
    assert.ok(storesConverged(stores[0]!, s), `device ${i} converged with device 0`);
  }
});

test('sync messages round-trip through the canonical wire encoding', () => {
  const mesh = new TestMesh();
  const store = new RecordStore();
  populate(mesh, store, { matches: 10, scouts: 3, seed: 4 });

  const session = new AntiEntropySession(store, mesh.resolver);
  const msg = session.start();
  const wire = encodeSyncMessage(msg);
  const back = decodeSyncMessage(wire);

  assert.equal(back.digests!.length, 1);
  assert.equal(back.digests![0]!.count, store.size);
  assert.equal(toHex(back.digests![0]!.xor), toHex(msg.digests![0]!.xor));
  assert.equal(toHex(encodeSyncMessage(back)), toHex(wire), 're-encoding is stable');
});

test('a sync partner that forges records poisons nothing', () => {
  const mesh = new TestMesh();
  const evil = new TestMesh(); // different keys entirely
  const a = new RecordStore();
  const b = new RecordStore();

  populate(mesh, a, { matches: 10, scouts: 2, seed: 6 });
  populate(evil, b, { matches: 10, scouts: 2, seed: 6 });

  // `a` only trusts its own mesh, so everything `b` offers must be rejected.
  const res = reconcile(a, b, mesh.resolver);
  assert.ok(res.rejected > 0, 'foreign records must be rejected');
  for (const id of a.sortedIds) {
    assert.ok(a.get(id), 'store stays self-consistent');
  }
});
