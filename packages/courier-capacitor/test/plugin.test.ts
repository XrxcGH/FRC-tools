import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  toBase64,
  fromBase64,
  meshBlockers,
  CourierBleHub,
  webFallbackPlugin,
  CapacitorTransportError,
  type CourierBlePlugin,
  type CourierBleCapabilities,
} from '../src/index.ts';
import { syncBothEnds } from '@courier/transport';
import { MIN_MTU, PREFERRED_MTU, split } from '@courier/ble';
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

/* --------------------------------------------------------------- base64 --- */

test('packets survive the JSON bridge as base64, including every byte value', () => {
  const all = new Uint8Array(256);
  for (let i = 0; i < 256; i++) all[i] = i;
  assert.equal(toHex(fromBase64(toBase64(all))), toHex(all));
  assert.equal(toBase64(new Uint8Array(0)), '');
  assert.equal(fromBase64('').length, 0);
});

/* --------------------------------------------------------- capabilities --- */

const caps = (over: Partial<CourierBleCapabilities> = {}): CourierBleCapabilities => ({
  canAdvertise: true,
  canScan: true,
  maxMtu: PREFERRED_MTU,
  keyBacking: 'software',
  limitations: [],
  ...over,
});

test('a capable device reports no blockers', () => {
  assert.deepEqual(meshBlockers(caps()), []);
});

test('a device that cannot advertise is told what it CAN still do', () => {
  // ChromeOS is the case that matters: a team whose only devices are school
  // Chromebooks needs to know to bring a USB stick, not to stare at a spinner.
  const blockers = meshBlockers(caps({ canAdvertise: false }));
  assert.equal(blockers.length, 1);
  assert.match(blockers[0]!, /cannot advertise/);
  assert.match(blockers[0]!, /can still join a sync/);
  assert.match(blockers[0]!, /USB or QR/);
});

test('platform-reported limitations are passed through verbatim', () => {
  const blockers = meshBlockers(caps({ limitations: ['Bluetooth is turned off'] }));
  assert.deepEqual(blockers, ['Bluetooth is turned off']);
});

test('an impossible MTU is caught rather than trusted', () => {
  assert.match(meshBlockers(caps({ maxMtu: 7 }))[0]!, /below the BLE minimum/);
});

/* -------------------------------------------------------- the web build --- */

test('the web build says it cannot do BLE instead of failing at the first scan', async () => {
  const c = await webFallbackPlugin.capabilities();
  assert.equal(c.canAdvertise, false);
  assert.equal(c.canScan, false);

  const blockers = meshBlockers(c);
  assert.ok(blockers.some((b) => /peripheral \(GATT server\) role/.test(b)));
  assert.ok(blockers.some((b) => /iOS Safari/.test(b)));
  assert.ok(blockers.some((b) => /USB or QR/.test(b)), 'and it names the way out');

  const perm = await webFallbackPlugin.requestPermissions();
  assert.equal(perm.granted, false);
  await assert.rejects(() => webFallbackPlugin.startScan(), CapacitorTransportError);
  await assert.rejects(() => webFallbackPlugin.connect({ peerId: 'x' }), CapacitorTransportError);
});

/* ------------------------------------------------- a fake native plugin --- */

/**
 * Two fake "devices" wired to each other, exercising the real bridge path:
 * base64 in and out, async writes, and an iOS-style `accepted: false`.
 */
function fakePluginPair(opts: { mtu?: number; queueDepth?: number } = {}) {
  const mtu = opts.mtu ?? PREFERRED_MTU;
  const depth = opts.queueDepth ?? Number.MAX_SAFE_INTEGER;

  type Handler = (e: never) => void;
  const sides: Array<{
    handlers: Map<string, Handler[]>;
    inFlight: number;
    plugin: CourierBlePlugin;
  }> = [];

  const make = (self: number): CourierBlePlugin => ({
    async capabilities() {
      return caps({ maxMtu: mtu });
    },
    async requestPermissions() {
      return { granted: true };
    },
    async startAdvertising() {},
    async stopAdvertising() {},
    async startScan() {},
    async stopScan() {},
    async connect() {
      return { peerId: 'peer', mtu };
    },
    async disconnect() {
      emit(1 - self, 'disconnected', { peerId: 'peer' });
    },
    async write({ packet }) {
      const side = sides[self]!;
      if (side.inFlight >= depth) {
        queueMicrotask(() => {
          side.inFlight = 0;
          emit(self, 'readyToWrite', { peerId: 'peer' });
        });
        return { accepted: false };
      }
      side.inFlight++;
      queueMicrotask(() => {
        side.inFlight = Math.max(0, side.inFlight - 1);
        emit(1 - self, 'packetReceived', { peerId: 'peer', packet });
      });
      return { accepted: true };
    },
    async addListener(event: string, handler: Handler) {
      const list = sides[self]!.handlers.get(event) ?? [];
      list.push(handler);
      sides[self]!.handlers.set(event, list);
      return {
        remove: async () => {
          const l = sides[self]!.handlers.get(event) ?? [];
          const i = l.indexOf(handler);
          if (i >= 0) l.splice(i, 1);
        },
      };
    },
  }) as CourierBlePlugin;

  function emit(side: number, event: string, payload: unknown): void {
    for (const h of sides[side]?.handlers.get(event) ?? []) (h as (e: unknown) => void)(payload);
  }

  for (let i = 0; i < 2; i++) sides.push({ handlers: new Map(), inFlight: 0, plugin: null! });
  sides[0]!.plugin = make(0);
  sides[1]!.plugin = make(1);
  return [sides[0]!.plugin, sides[1]!.plugin] as const;
}

/* ----------------------------------------------------------- end to end --- */

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
      match: parseMatchKey(`2027mose_qm${(i % 40) + 1}`).packed,
      team: 8000 + (i % 12),
      scout: mintScoutPseudonym(`scout-${i % 4}`, '2027mose', meshKey),
      schema: 'demo.scout.v1',
      body: utf8(`obs-${i}`),
      sealedAt: 1_800_000_000_000 + i,
    });
    store.admit(sealRecord(rec, device(`tablet-${i % 4}`)), resolver);
  }
}

test('two stores converge across the plugin bridge', async () => {
  const [pa, pb] = fakePluginPair();
  const a = new RecordStore();
  const b = new RecordStore();
  fill(a, 1, 40);
  fill(b, 30, 70);

  const [la, lb] = await Promise.all([
    new CourierBleHub(pa).open('peer'),
    new CourierBleHub(pb).open('peer'),
  ]);
  await syncBothEnds({ store: a, link: la }, { store: b, link: lb }, resolver);

  assert.ok(storesConverged(a, b), `expected convergence, got ${a.size} vs ${b.size}`);
  assert.equal(a.size, 70);
});

test('an iOS-style refusal re-queues the packet instead of dropping it', async () => {
  // `accepted: false` means native did NOT take the packet. A plugin that
  // treated it as sent would lose data silently, and the loss would surface as
  // a signature failure somewhere unrelated.
  const [pa, pb] = fakePluginPair({ queueDepth: 2, mtu: MIN_MTU });
  const a = new RecordStore();
  const b = new RecordStore();
  fill(a, 1, 12);

  const [la, lb] = await Promise.all([
    new CourierBleHub(pa).open('peer'),
    new CourierBleHub(pb).open('peer'),
  ]);
  await syncBothEnds({ store: a, link: la }, { store: b, link: lb }, resolver);

  assert.ok(storesConverged(a, b), `expected convergence, got ${a.size} vs ${b.size}`);
  assert.equal(b.size, 12);
});

test('a packet arriving before the link is open is delivered, not lost', async () => {
  // The window the hub closes: listeners are registered when the hub first does
  // anything, and demux by peerId from then on — so a packet landing between
  // `connect()` being issued and the link existing is buffered rather than
  // dropped into a gap where nothing was listening.
  //
  // Note what this does NOT claim: nothing can catch a packet that arrives
  // before the hub has registered listeners at all. A real device is scanning
  // or advertising first, which is what `startScan()` models here.
  const [pa, pb] = fakePluginPair();
  const hubA = new CourierBleHub(pa);
  const hubB = new CourierBleHub(pb);

  await hubB.startScan(); // listeners up, no link yet

  const la = await hubA.open('peer');
  await la.send(utf8('early bird'));
  await new Promise((r) => setTimeout(r, 20)); // it lands while B has no transport

  const lb = await hubB.open('peer');
  const got = await lb.receive();
  assert.equal(new TextDecoder().decode(got!), 'early bird');
});

test('buffered packets go to the right peer, never to whoever opens first', async () => {
  // Capacitor's retainUntilConsumed flushes to the FIRST listener, which on a
  // device holding two inbound links hands peer A the packets meant for peer B.
  // Demultiplexing by peerId in the hub is what makes that impossible.
  const events = new Map<string, Array<(e: never) => void>>();
  const plugin = {
    async capabilities() {
      return caps();
    },
    async requestPermissions() {
      return { granted: true };
    },
    async startAdvertising() {},
    async stopAdvertising() {},
    async startScan() {},
    async stopScan() {},
    async connect() {
      return { peerId: 'x', mtu: PREFERRED_MTU };
    },
    async disconnect() {},
    async write() {
      return { accepted: true };
    },
    async addListener(event: string, handler: (e: never) => void) {
      const l = events.get(event) ?? [];
      l.push(handler);
      events.set(event, l);
      return { remove: async () => {} };
    },
  } as unknown as CourierBlePlugin;

  const hub = new CourierBleHub(plugin);
  // Force listener registration, then deliver for a peer nobody has opened.
  await hub.startScan();

  // Emit a properly FRAMED packet: GattLink hands bytes to the reassembler, so
  // raw payload bytes would never complete a frame and the test would hang
  // rather than fail.
  const emit = (peerId: string, text: string): void => {
    for (const packet of split(utf8(text), PREFERRED_MTU, 1)) {
      for (const h of events.get('packetReceived') ?? []) {
        (h as unknown as (e: { peerId: string; packet: string }) => void)({
          peerId,
          packet: toBase64(packet),
        });
      }
    }
  };
  emit('peer-B', 'for B');

  // Peer A opens FIRST. It must not receive B's packet.
  const linkA = await hub.open('peer-A');
  let aGotSomething = false;
  void linkA.receive().then(() => {
    aGotSomething = true;
  });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(aGotSomething, false, "A must not drain B's buffered packet");

  // Then B opens and gets exactly its own.
  const linkB = await hub.open('peer-B');
  const got = await linkB.receive();
  assert.equal(new TextDecoder().decode(got!), 'for B');
});

test('packets keep their order even when native pushes back', async () => {
  // Reassembly rejects out-of-order packets rather than splicing them, so a
  // queued retry must go before anything written after it.
  const [pa, pb] = fakePluginPair({ queueDepth: 1, mtu: MIN_MTU });
  const [la, lb] = await Promise.all([
    new CourierBleHub(pa).open('peer'),
    new CourierBleHub(pb).open('peer'),
  ]);

  const payload = new Uint8Array(600);
  for (let i = 0; i < payload.length; i++) payload[i] = (i * 31) & 0xff;

  await la.send(payload);
  const received = await lb.receive();

  assert.equal(toHex(received!), toHex(payload));
  assert.equal(lb.reassemblyStats.framesAbandoned, 0, 'no frame was torn by reordering');
});
