/**
 * The GATT profile, and a Link built on top of it.
 *
 * The native shim below this file has four jobs and no others: advertise or
 * scan, report the negotiated MTU, hand up received packets, and take packets
 * to send. Everything else — framing, reassembly, backpressure, ordering — is
 * here, in portable code with tests, because the native surface is exactly the
 * maintenance burden that killed every predecessor to this project.
 */

import { MemoryLink, type Link } from '@courier/transport';
import {
  Reassembler,
  split,
  payloadPerPacket,
  FramingError,
  type ReassemblyStats,
} from './framing.ts';

/**
 * Service and characteristic UUIDs.
 *
 * Fixed constants rather than configuration: two Courier devices that cannot
 * agree on a UUID cannot find each other, and there is no negotiation channel
 * before the connection exists.
 */
export const COURIER_SERVICE_UUID = 'c0117e12-9a3f-4c8d-8e21-6b7a5f0d1e40';
/** Central writes here. */
export const COURIER_RX_UUID = 'c0117e12-9a3f-4c8d-8e21-6b7a5f0d1e41';
/** Peripheral notifies here. */
export const COURIER_TX_UUID = 'c0117e12-9a3f-4c8d-8e21-6b7a5f0d1e42';

/** The conservative floor: an unnegotiated BLE connection. */
export const MIN_MTU = 23;
/** What data-length extension typically gets you. */
export const PREFERRED_MTU = 247;

/**
 * What a native BLE implementation must provide.
 *
 * `write` returning `false` is not an error — it is the iOS peripheral
 * behaviour, where `updateValue` returns false once the stack's queue is full
 * and the send must be retried after `peripheralManagerIsReadyToUpdateSubscribers`
 * fires. The design review flagged that this backpressure, not frame
 * arithmetic, is what determines real iOS throughput and that nothing modelled
 * it. This interface makes it impossible not to.
 */
export interface GattTransport {
  /** Negotiated ATT MTU, including the 3-byte ATT header. */
  readonly mtu: number;
  /** Queue one packet. False means the stack is full; retry after `onReady`. */
  write(packet: Uint8Array): boolean;
  /** Register the "stack drained, you may write again" callback. */
  onReady(handler: () => void): void;
  onPacket(handler: (packet: Uint8Array) => void): void;
  /**
   * Register the disconnect callback.
   *
   * Not optional. A GATT connection can end at any moment — the peer walks out
   * of range, the OS reclaims the radio, the tablet sleeps — and without this
   * a link waiting on `receive()` waits forever. On an event floor a peer
   * leaving is the ordinary case, so the ordinary case must not deadlock.
   */
  onDisconnect(handler: () => void): void;
  close(): void;
  readonly label: string;
}

export interface GattLinkOptions {
  /** Give up on a stalled peer rather than hanging a sync forever. */
  readonly readyTimeoutMs?: number;
}

export interface GattLinkStats {
  framesSent: number;
  framesReceived: number;
  packetsSent: number;
  backpressureStalls: number;
  malformedPackets: number;
}

const DEFAULT_READY_TIMEOUT = 15_000;

/**
 * A Link over a GATT connection. Plugs straight into `syncOverLink`.
 */
export class GattLink implements Link {
  readonly label: string;
  readonly stats: GattLinkStats = {
    framesSent: 0,
    framesReceived: 0,
    packetsSent: 0,
    backpressureStalls: 0,
    malformedPackets: 0,
  };

  readonly #transport: GattTransport;
  readonly #reassembler = new Reassembler();
  readonly #inbox: Uint8Array[] = [];
  readonly #waiters: Array<(v: Uint8Array | null) => void> = [];
  readonly #readyTimeout: number;
  #readyResolvers: Array<() => void> = [];
  #frameId = 0;
  #closed = false;

  constructor(transport: GattTransport, opts: GattLinkOptions = {}) {
    this.#transport = transport;
    this.label = transport.label;
    this.#readyTimeout = opts.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT;

    transport.onReady(() => {
      const waiting = this.#readyResolvers;
      this.#readyResolvers = [];
      for (const r of waiting) r();
    });

    transport.onDisconnect(() => {
      // Resolve every waiter with null so the session ends as "peer hung up"
      // rather than blocking. Nothing is corrupted: the store is grow-only, so
      // a half-finished sync is simply a smaller one.
      void this.close();
    });

    transport.onPacket((packet) => {
      if (this.#closed) return;
      let frame: Uint8Array | null = null;
      try {
        frame = this.#reassembler.push(packet);
      } catch (err) {
        // A malformed or out-of-order packet costs one frame, not the session:
        // the store is grow-only, so the peer simply re-offers next round.
        this.stats.malformedPackets++;
        if (!(err instanceof FramingError)) throw err;
        return;
      }
      if (!frame) return;
      this.stats.framesReceived++;
      const waiter = this.#waiters.shift();
      if (waiter) waiter(frame);
      else this.#inbox.push(frame);
    });
  }

  get mtu(): number {
    return this.#transport.mtu;
  }

  /** Payload bytes per packet at the negotiated MTU. For budgeting. */
  get payloadPerPacket(): number {
    return payloadPerPacket(this.#transport.mtu);
  }

  async send(bytes: Uint8Array): Promise<void> {
    if (this.#closed) throw new Error(`link ${this.label} is closed`);

    const frameId = this.#frameId;
    this.#frameId = (this.#frameId + 1) & 0xffff;

    for (const packet of split(bytes, this.#transport.mtu, frameId)) {
      // Retry the SAME packet after backpressure: a false return means the
      // stack did not take it, not that it took it and failed.
      while (!this.#transport.write(packet)) {
        this.stats.backpressureStalls++;
        const drained = await this.#awaitReady();
        if (!drained) {
          throw new Error(
            `link ${this.label} stalled for ${this.#readyTimeout} ms waiting for the BLE ` +
              `stack to drain. The peer is probably gone.`,
          );
        }
        if (this.#closed) throw new Error(`link ${this.label} closed mid-frame`);
      }
      this.stats.packetsSent++;
    }
    this.stats.framesSent++;
  }

  #awaitReady(): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        resolve(false);
      }, this.#readyTimeout);
      // Deliberately NOT unref'd, and this is load-bearing.
      //
      // The timer's whole job is to fire and hand back `false` so a caller
      // never hangs on a peer that has gone away. Unref'ing it means that when
      // it is the only thing left in the event loop — which is exactly the
      // stalled-peer case it exists for — the loop drains, the timer never
      // fires, and the await hangs forever. The guard turns itself off precisely
      // when it is needed.
      //
      // It cost twelve red CI runs on Node 22 to notice: on Node 22 the test
      // runner reports "Promise resolution is still pending but the event loop
      // has already resolved" and cancels the rest of the file. Node 24 happened
      // to keep a handle alive and hid it.
      //
      // It cannot hold the process open for longer than `readyTimeout`, because
      // the success path clears it.

      this.#readyResolvers.push(() => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(true);
      });
    });
  }

  async receive(): Promise<Uint8Array | null> {
    const queued = this.#inbox.shift();
    if (queued) return queued;
    if (this.#closed) return null;
    return new Promise<Uint8Array | null>((resolve) => {
      this.#waiters.push(resolve);
    });
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    for (const w of this.#waiters.splice(0)) w(null);
    for (const r of this.#readyResolvers.splice(0)) r();
    this.#transport.close();
  }

  get reassemblyStats(): Readonly<ReassemblyStats> {
    return this.#reassembler.stats;
  }
}

/* -------------------------------------------------------------------------- */
/* A simulated transport, for tests and the desk-bound developer               */
/* -------------------------------------------------------------------------- */

export interface FakeGattOptions {
  readonly mtu?: number;
  /** Accept this many writes, then apply backpressure until drained. */
  readonly queueDepth?: number;
  /** Drop every Nth packet in flight. 0 disables. */
  readonly dropEvery?: number;
}

/**
 * A paired in-memory GATT transport that reproduces the behaviours that
 * actually bite: a bounded send queue with an iOS-style false return, and
 * packet loss.
 */
export class FakeGattTransport implements GattTransport {
  readonly mtu: number;
  readonly label: string;

  #peer: FakeGattTransport | null = null;
  #packetHandler: ((p: Uint8Array) => void) | null = null;
  #readyHandler: (() => void) | null = null;
  #disconnectHandler: (() => void) | null = null;
  #queued = 0;
  #sent = 0;
  #closed = false;
  readonly #queueDepth: number;
  readonly #dropEvery: number;

  constructor(label: string, opts: FakeGattOptions = {}) {
    this.label = label;
    this.mtu = opts.mtu ?? PREFERRED_MTU;
    this.#queueDepth = opts.queueDepth ?? Number.MAX_SAFE_INTEGER;
    this.#dropEvery = opts.dropEvery ?? 0;
  }

  static pair(a: string, b: string, opts: FakeGattOptions = {}): [FakeGattTransport, FakeGattTransport] {
    const x = new FakeGattTransport(a, opts);
    const y = new FakeGattTransport(b, opts);
    x.#peer = y;
    y.#peer = x;
    return [x, y];
  }

  write(packet: Uint8Array): boolean {
    if (this.#closed) return false;
    if (this.#queued >= this.#queueDepth) {
      // The stack is full. Drain asynchronously and signal readiness, exactly
      // as a real peripheral does.
      queueMicrotask(() => {
        this.#queued = 0;
        this.#readyHandler?.();
      });
      return false;
    }
    this.#queued++;
    this.#sent++;

    const drop = this.#dropEvery > 0 && this.#sent % this.#dropEvery === 0;
    const copy = packet.slice();
    queueMicrotask(() => {
      this.#queued = Math.max(0, this.#queued - 1);
      if (!drop) this.#peer?.#deliver(copy);
    });
    return true;
  }

  #deliver(packet: Uint8Array): void {
    if (this.#closed) return;
    this.#packetHandler?.(packet);
  }

  onReady(handler: () => void): void {
    this.#readyHandler = handler;
  }

  onPacket(handler: (p: Uint8Array) => void): void {
    this.#packetHandler = handler;
  }

  onDisconnect(handler: () => void): void {
    this.#disconnectHandler = handler;
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    // Tell the far side, as a real stack does. Without this the peer's
    // `receive()` never resolves and the sync deadlocks.
    const peer = this.#peer;
    if (peer && !peer.#closed) {
      peer.#closed = true;
      queueMicrotask(() => peer.#disconnectHandler?.());
    }
  }
}

/** Two GattLinks over a simulated connection. */
export function fakeGattPair(opts: FakeGattOptions = {}): [GattLink, GattLink] {
  const [a, b] = FakeGattTransport.pair('ble:A', 'ble:B', opts);
  return [new GattLink(a, { readyTimeoutMs: 2000 }), new GattLink(b, { readyTimeoutMs: 2000 })];
}

/** Re-exported so a caller can compare against the non-radio path. */
export { MemoryLink };
