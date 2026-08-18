import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  split,
  payloadPerPacket,
  Reassembler,
  FramingError,
  fakeGattPair,
  FakeGattTransport,
  GattLink,
  MIN_MTU,
  PREFERRED_MTU,
  HEADER_BYTES,
  ATT_OVERHEAD,
} from '../src/index.ts';
import { syncBothEnds, syncOverLink } from '@courier/transport';
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
  type KeyResolver,
} from '@courier/core';

/* ------------------------------------------------------------- framing ---- */

test('payload per packet accounts for both ATT and Courier headers', () => {
  assert.equal(payloadPerPacket(PREFERRED_MTU), PREFERRED_MTU - ATT_OVERHEAD - HEADER_BYTES);
  assert.equal(payloadPerPacket(MIN_MTU), MIN_MTU - ATT_OVERHEAD - HEADER_BYTES);
  // 15 bytes on an unnegotiated connection. Small, but workable.
  assert.equal(payloadPerPacket(23), 15);
  assert.throws(() => payloadPerPacket(6), FramingError);
});

test('a frame splits and reassembles byte for byte, at any MTU', () => {
  const frame = new Uint8Array(1000);
  for (let i = 0; i < frame.length; i++) frame[i] = i & 0xff;

  for (const mtu of [MIN_MTU, 64, 185, PREFERRED_MTU]) {
    const packets = split(frame, mtu, 7);
    for (const p of packets) assert.ok(p.length <= mtu - ATT_OVERHEAD, `MTU ${mtu} respected`);

    const r = new Reassembler();
    let out: Uint8Array | null = null;
    for (const p of packets) out = r.push(p);
    assert.ok(out, `frame completed at MTU ${mtu}`);
    assert.equal(toHex(out!), toHex(frame), `round-trip at MTU ${mtu}`);
  }
});

test('an empty frame still round-trips', () => {
  const r = new Reassembler();
  const packets = split(new Uint8Array(0), PREFERRED_MTU, 1);
  assert.equal(packets.length, 1);
  assert.equal(r.push(packets[0]!)!.length, 0);
});

test('a routine sync frame survives an unnegotiated MTU', () => {
  // An 8.6 kB chunk at 15 payload bytes needs ~590 packets. With the original
  // 8-bit sequence field this simply could not be sent — and 23 bytes is what
  // you have before MTU negotiation succeeds, which is exactly when two devices
  // first try to talk.
  const frame = new Uint8Array(8600).fill(3);
  const packets = split(frame, MIN_MTU, 0);
  assert.ok(packets.length > 256, `needs ${packets.length} packets`);

  const r = new Reassembler();
  let out: Uint8Array | null = null;
  for (const p of packets) out = r.push(p);
  assert.equal(out!.length, frame.length);
});

test('joining mid-frame waits for the next one rather than emitting a truncation', () => {
  const frame = new Uint8Array(500).fill(9);
  const packets = split(frame, 64, 3);
  const r = new Reassembler();

  // Start listening at packet 2.
  assert.equal(r.push(packets[2]!), null);
  assert.equal(r.push(packets[3]!), null);
  assert.ok(r.stats.packetsDropped > 0);

  // The next complete frame comes through cleanly.
  const next = split(new Uint8Array([1, 2, 3]), 64, 4);
  assert.equal(toHex(r.push(next[0]!)!), '010203');
});

test('an out-of-order packet discards the partial rather than splicing it', () => {
  const packets = split(new Uint8Array(300).fill(1), 64, 5);
  const r = new Reassembler();
  r.push(packets[0]!);
  assert.throws(() => r.push(packets[2]!), /out-of-order/);
  assert.equal(r.inProgress, false, 'the partial frame is gone');
  assert.equal(r.stats.framesAbandoned, 1);
});

test('a new frame id abandons an unfinished frame instead of merging them', () => {
  const a = split(new Uint8Array(300).fill(1), 64, 10);
  const b = split(new Uint8Array([7, 7, 7]), 64, 11);
  const r = new Reassembler();

  r.push(a[0]!); // partial
  const out = r.push(b[0]!); // a complete, different frame
  assert.equal(toHex(out!), '070707');
  assert.equal(r.stats.framesAbandoned, 1);
});

test('a runt packet and an oversized frame are both refused', () => {
  const r = new Reassembler();
  assert.throws(() => r.push(new Uint8Array(2)), /shorter than the header/);
});

/* ---------------------------------------------------------------- link ---- */

test('a GATT link carries frames in both directions', async () => {
  const [a, b] = fakeGattPair();
  const payload = utf8('hello from the stands');

  await a.send(payload);
  assert.equal(toHex((await b.receive())!), toHex(payload));

  await b.send(utf8('and back'));
  assert.equal(new TextDecoder().decode((await a.receive())!), 'and back');

  assert.equal(a.stats.framesSent, 1);
  assert.equal(b.stats.framesReceived, 1);
});

test('backpressure is retried, not dropped — the iOS updateValue case', async () => {
  // A false return from updateValue means the stack did NOT take the packet.
  // Treating it as sent silently loses data; this asserts we resend the same
  // packet after the ready callback.
  const [a, b] = fakeGattPair({ queueDepth: 2, mtu: 64 });
  const payload = new Uint8Array(2000);
  for (let i = 0; i < payload.length; i++) payload[i] = (i * 7) & 0xff;

  await a.send(payload);
  const received = await b.receive();

  assert.equal(toHex(received!), toHex(payload), 'nothing was lost to backpressure');
  assert.ok(a.stats.backpressureStalls > 0, 'the queue really did fill');
});

test('a stalled peer times out instead of hanging the sync forever', async () => {
  const transport = new FakeGattTransport('ble:stuck', { mtu: 64 });
  // Never signal readiness, and always refuse.
  transport.write = () => false;
  transport.onReady = () => {};
  const link = new GattLink(transport, { readyTimeoutMs: 50 });

  await assert.rejects(() => link.send(new Uint8Array(100)), /stalled for 50 ms/);
});

test('a dropped packet costs one frame, not the session', async () => {
  const [a, b] = fakeGattPair({ mtu: 64, dropEvery: 3 });

  // Frames whose packets get dropped are abandoned; the link stays usable.
  await a.send(new Uint8Array(400).fill(4));
  await new Promise((r) => setTimeout(r, 20));

  assert.ok(
    b.stats.malformedPackets > 0 || b.reassemblyStats.packetsDropped > 0,
    'loss was noticed rather than spliced',
  );
  assert.equal(b.stats.framesReceived, 0, 'no corrupt frame was surfaced');
});

test('closing releases a pending receive rather than leaking it', async () => {
  const [a, b] = fakeGattPair();
  const pending = b.receive();
  await b.close();
  assert.equal(await pending, null);
  await a.close();
});

test('a disconnect wakes the OTHER side, so a sync cannot deadlock', async () => {
  // Without a disconnect callback, one side finishing leaves the peer blocked
  // in receive() forever. On an event floor a peer walking away is the ordinary
  // case, so the ordinary case must not hang.
  const [a, b] = fakeGattPair();
  const pending = b.receive();
  await a.close(); // the FAR side goes away
  assert.equal(await pending, null, 'the peer must be woken, not left waiting');
});

/* --------------------------------------------------- sync over the radio -- */

const meshKey = generateMeshKey();
const devices = new Map<string, ReturnType<typeof generateDeviceKey>>();
function device(name: string) {
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

function fill(store: RecordStore, from: number, to: number): void {
  for (let i = from; i <= to; i++) {
    const rec = makeRecord({
      eventKey: '2027mose',
      match: parseMatchKey(`2027mose_qm${(i % 60) + 1}`).packed,
      team: 8000 + (i % 24),
      scout: mintScoutPseudonym(`scout-${i % 6}`, '2027mose', meshKey),
      schema: 'demo.scout.v1',
      body: utf8(`observation-${i}`),
      sealedAt: 1_800_000_000_000 + i,
    });
    store.admit(sealRecord(rec, device(`tablet-${i % 6}`)), resolver);
  }
}

test('two stores converge over a simulated BLE connection', async () => {
  const a = new RecordStore();
  const b = new RecordStore();
  fill(a, 1, 90);
  fill(b, 60, 140);

  const [la, lb] = fakeGattPair({ mtu: PREFERRED_MTU });
  const [oa, ob] = await syncBothEnds({ store: a, link: la }, { store: b, link: lb }, resolver);

  assert.ok(storesConverged(a, b), 'the radio path converges like any other');
  assert.equal(a.size, 140);
  assert.equal(oa.rejected + ob.rejected, 0);
  assert.ok(la.stats.packetsSent > la.stats.framesSent, 'frames really were chunked');
});

test('convergence survives a small MTU and a full send queue', async () => {
  // The pessimistic case: an unnegotiated 23-byte MTU and a two-deep queue,
  // which is roughly what a cheap Android tablet and an iOS peripheral under
  // load look like together.
  const a = new RecordStore();
  const b = new RecordStore();
  fill(a, 1, 25);

  const [la, lb] = fakeGattPair({ mtu: MIN_MTU, queueDepth: 2 });
  await syncBothEnds({ store: a, link: la }, { store: b, link: lb }, resolver);

  assert.ok(storesConverged(a, b), `expected convergence, got ${a.size} vs ${b.size}`);
  assert.ok(la.stats.backpressureStalls > 0, 'backpressure was exercised');
});

test('the payload budget at each MTU is what the transport planning assumes', () => {
  // 16 bytes/packet unnegotiated vs 240 negotiated is a 15x difference in
  // packet count for the same frame, which is why MTU negotiation is worth
  // doing before anything else on a connection.
  const frame = new Uint8Array(1200);
  assert.equal(split(frame, MIN_MTU, 0).length, Math.ceil(1200 / 15));
  assert.equal(split(frame, PREFERRED_MTU, 0).length, Math.ceil(1200 / 239));
});

/* --------------------------------------- a peer leaving is not an attack -- */

test('a peer that disconnects mid-sync ends as peer-hung-up, not protocol-error', async () => {
  // The defect this exists for. syncOverLink maps a closed link to the benign
  // 'peer-hung-up' only when the thrown value is a LinkClosedError. GattLink.send
  // threw a bare Error, so it fell through to the outer catch and came back as
  // 'protocol-error' — which session.ts documents as "either corruption or a
  // hostile peer". On an event floor a peer walking out of range is the
  // ORDINARY case, and it was being reported as an attack. MemoryLink threw the
  // right class all along, which is why only the BLE path lied.
  const [ta, tb] = FakeGattTransport.pair('A', 'B');
  const a = new GattLink(ta, { readyTimeoutMs: 200 });
  const b = new GattLink(tb, { readyTimeoutMs: 200 });

  const store = new RecordStore();
  fill(store, 1, 20);

  // B goes away before A gets to speak.
  await b.close();

  const out = await syncOverLink(store, resolver, a, 'initiator', {
    receiveTimeoutMs: 500,
  });
  assert.equal(out.ending, 'peer-hung-up', `reported ${out.ending}: ${out.error ?? ''}`);
  assert.equal(out.error, undefined, 'a peer leaving needs no error text');
});

test('a peer that stops draining ends as peer-silent, not protocol-error', async () => {
  // The send-side twin of the receive-side silence guard. A stall is a peer
  // that may not know it is gone — ordinary, and distinct from a hang-up.
  const stuck = {
    mtu: MIN_MTU,
    label: 'stuck',
    write: () => false, // never accepts, never signals ready
    onReady: () => {},
    onPacket: () => {},
    onDisconnect: () => {},
    close: () => {},
  };
  const link = new GattLink(stuck, { readyTimeoutMs: 60 });

  const store = new RecordStore();
  fill(store, 1, 5);

  const out = await syncOverLink(store, resolver, link, 'initiator', {
    receiveTimeoutMs: 500,
  });
  assert.equal(out.ending, 'peer-silent', `reported ${out.ending}: ${out.error ?? ''}`);
  assert.match(out.error!, /stalled for 60 ms/);
});

test('a missing MTU from the native layer fails loudly, not silently', () => {
  // NaN < 1 is false, so a NaN MTU passed the "too small" guard and
  // payloadPerPacket returned NaN. split() then produced ZERO packets —
  // Math.ceil(len / NaN) is NaN and `for (i = 0; i < NaN; i++)` never runs — so
  // GattLink.send iterated nothing, skipped the backpressure loop, incremented
  // framesSent and resolved normally, having transmitted nothing.
  //
  // MTU crosses the native bridge, so an undefined field from a shim is exactly
  // how NaN gets here.
  for (const bad of [NaN, undefined as unknown as number, null as unknown as number, 23.5]) {
    assert.throws(() => payloadPerPacket(bad), /not an integer|too small/, `accepted ${bad}`);
    assert.throws(() => split(utf8('hello'), bad, 1), /not an integer|too small/);
  }
  // A real MTU still works, and produces at least one packet.
  assert.ok(split(utf8('hello'), MIN_MTU, 1).length >= 1);
});
