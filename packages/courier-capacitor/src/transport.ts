/**
 * Adapting the plugin to a GattTransport.
 *
 * This is the seam: above it, portable code with tests; below it, Kotlin and
 * Swift. Everything here is thin by design — if this file grows complicated,
 * the complication belongs in @courier/ble where it can be tested without a
 * radio.
 *
 * Note what this class does NOT do: it does not subscribe to plugin events.
 * `CourierBleHub` owns the four listeners and demultiplexes by peerId, which is
 * what closes the window between connecting and listening. A transport that
 * registered its own listeners would reopen it, and on iOS would also expose
 * the retained-queue hazard where one peer drains another's packets.
 */

import { type GattTransport } from '@courier/ble';
import { toBase64, type CourierBlePlugin } from './definitions.ts';

/**
 * Packets this transport will hold before telling the sender to wait.
 *
 * Deep enough to keep the bridge pipelined — each `write()` is an async round
 * trip to native, so a depth of one would serialise the whole frame on bridge
 * latency. Shallow enough that a peer which has stopped draining is noticed
 * within one bound rather than after a whole frame: at MIN_MTU a packet carries
 * 15 bytes, so 32 packets is 480 bytes in flight, and at the preferred MTU it
 * is 7.6 kB.
 *
 * CHOSEN, not measured. The right depth is one connection interval's worth of
 * packets, and that needs two real devices to know — see docs/MEASUREMENTS.md
 * §6. What matters here is that a bound exists at all; the exact value only
 * trades throughput against how fast a stall is spotted.
 */
export const MAX_PENDING_WRITES = 32;

export class CapacitorTransportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CapacitorTransportError';
  }
}

/**
 * One GATT connection, presented as the transport @courier/ble expects.
 *
 * `write` is synchronous in the GattTransport interface but asynchronous across
 * the Capacitor bridge, so this maintains a bounded outbound queue: a packet is
 * accepted optimistically and drained across the bridge, and a `false` from
 * native re-queues it at the head to wait for `readyToWrite`.
 *
 * The queue is BOUNDED, and that is load-bearing rather than tidy. `GattLink`
 * only applies backpressure when `write()` returns false; an always-true
 * transport means the link never stalls, its stall timeout can never fire, and
 * the "a stalled peer times out instead of hanging the sync forever" guarantee
 * holds only against the simulator. It also means a peer that stops draining
 * accumulates packets with nothing to stop it. Returning false at the bound is
 * what makes the tested behaviour and the shipped behaviour the same thing.
 */
export class PluginGattTransport implements GattTransport {
  readonly label: string;

  readonly #plugin: CourierBlePlugin;
  readonly #peerId: string;
  #mtu: number;
  #packetHandler: ((p: Uint8Array) => void) | null = null;
  #readyHandler: (() => void) | null = null;
  #disconnectHandler: (() => void) | null = null;
  #closedHandler: (() => void) | null = null;
  #closed = false;
  /** Packets native refused, plus anything queued behind them. */
  readonly #outbound: Uint8Array[] = [];
  /** Packets that arrived before a handler was attached. */
  readonly #inbound: Uint8Array[] = [];
  #draining = false;
  /** A drain was asked for while one was mid-flight. */
  #drainAgain = false;
  /**
   * We refused a write and owe the sender a wake-up.
   *
   * Recorded at the moment of refusal rather than sampled when a drain starts.
   * A drain that began while the queue was short would otherwise finish, see it
   * was never full at ITS entry, and skip the wake — leaving GattLink on its
   * stall timeout even though there is room now.
   */
  #owesReady = false;

  constructor(plugin: CourierBlePlugin, peerId: string, mtu: number) {
    this.#plugin = plugin;
    this.#peerId = peerId;
    this.#mtu = mtu;
    this.label = `ble:${peerId.slice(0, 8)}`;
  }

  get mtu(): number {
    return this.#mtu;
  }

  /** Called once, when connect() reports the negotiated MTU. */
  setMtu(mtu: number): void {
    this.#mtu = mtu;
  }

  /* ------------------------------------------------- driven by the hub --- */

  /**
   * Hand up a received packet.
   *
   * Buffered if no handler is attached yet, because `GattLink` attaches its
   * handler in its own constructor — after this transport exists. Dropping here
   * would lose the first packet of a link that opens mid-frame.
   */
  deliver(packet: Uint8Array): void {
    if (this.#closed) return;
    if (this.#packetHandler) this.#packetHandler(packet);
    else this.#inbound.push(packet);
  }

  signalReady(): void {
    if (this.#closed) return;
    // Drain first: native has taken something, so the head of the queue may go
    // now. #drain may also fire the ready handler itself if our own bound was
    // the thing blocking — one spurious extra wake is harmless, a missing one
    // costs a full stall timeout.
    void this.#drain();
    this.#readyHandler?.();
  }

  signalDisconnect(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#disconnectHandler?.();
    this.#closedHandler?.();
  }

  /** The hub uses this to forget a transport that closed from below. */
  onClosed(handler: () => void): void {
    this.#closedHandler = handler;
  }

  /* ------------------------------------------------- the GattTransport --- */

  write(packet: Uint8Array): boolean {
    if (this.#closed) return false;
    // Refuse at the bound rather than queueing forever. GattLink reads a false
    // return as backpressure and waits on its stall timeout, which is the only
    // thing that ever notices a peer that has stopped draining.
    if (this.#outbound.length >= MAX_PENDING_WRITES) {
      this.#owesReady = true;
      void this.#drain();
      return false;
    }
    // Always append. Anything already waiting must go first, or packets
    // reorder — and the reassembler discards out-of-order packets rather than
    // splicing them into a corrupt frame.
    this.#outbound.push(packet.slice());
    void this.#drain();
    return true;
  }

  async #drain(): Promise<void> {
    if (this.#closed) return;
    if (this.#draining) {
      // A drain is mid-flight, awaiting a bridge round trip. Dropping this
      // request loses the wake-up: the in-flight pass finishes with the
      // `accepted: false` it was already holding, nothing retries, and the
      // queue sits full forever. Record it and let the running pass loop.
      this.#drainAgain = true;
      return;
    }
    this.#draining = true;
    try {
      do {
        this.#drainAgain = false;
        while (this.#outbound.length > 0 && !this.#closed) {
          const next = this.#outbound[0]!;
          const { accepted } = await this.#plugin.write({
            peerId: this.#peerId,
            packet: toBase64(next),
          });
          // `accepted: false` means native did NOT take it. The packet stays at
          // the head of the queue and waits for readyToWrite.
          if (!accepted) break;
          this.#outbound.shift();
        }
        // Anything that asked for a drain while we were awaiting gets served
        // by this loop rather than being silently dropped.
      } while (this.#drainAgain && !this.#closed);
    } catch {
      // A bridge failure is a disconnect from this layer's point of view.
      this.signalDisconnect();
    } finally {
      this.#draining = false;
      // Wake the sender ourselves when OUR bound was what pushed back. Native
      // emits readyToWrite only after IT refused something, so if the refusal
      // came from this queue no such event is coming, and the link would sit on
      // its stall timeout once per frame for no reason.
      if (this.#owesReady && !this.#closed && this.#outbound.length < MAX_PENDING_WRITES) {
        this.#owesReady = false;
        this.#readyHandler?.();
      }
    }
  }

  onReady(handler: () => void): void {
    this.#readyHandler = handler;
  }

  onPacket(handler: (p: Uint8Array) => void): void {
    this.#packetHandler = handler;
    // Flush anything that arrived before the handler existed.
    while (this.#inbound.length > 0 && this.#packetHandler) {
      this.#packetHandler(this.#inbound.shift()!);
    }
  }

  onDisconnect(handler: () => void): void {
    this.#disconnectHandler = handler;
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#outbound.length = 0;
    this.#inbound.length = 0;
    void this.#plugin.disconnect({ peerId: this.#peerId }).catch(() => {});
    this.#closedHandler?.();
  }

  /** Packets queued for send. Exposed for diagnostics. */
  get pendingWrites(): number {
    return this.#outbound.length;
  }
}

/* -------------------------------------------------------------------------- */
/* Web fallback                                                                */
/* -------------------------------------------------------------------------- */

const WEB_LIMITATION =
  'Web Bluetooth has no peripheral (GATT server) role in any browser, and iOS Safari does ' +
  'not implement it at all. Two devices syncing needs one of them to advertise, so a web ' +
  'build cannot participate in a BLE mesh on any platform. Use the installed app for radio ' +
  'sync, or move data by USB or QR — both work everywhere and neither needs permission from ' +
  'anyone.';

/**
 * The web build's plugin.
 *
 * It reports honestly that it cannot do BLE rather than failing at the first
 * scan with a permissions error. That distinction matters: a team that knows
 * their Chromebooks cannot advertise will bring a USB stick, and a team staring
 * at a spinner will not.
 */
export const webFallbackPlugin: CourierBlePlugin = {
  async capabilities() {
    return {
      canAdvertise: false,
      canScan: false,
      maxMtu: 23,
      keyBacking: 'software' as const,
      limitations: [WEB_LIMITATION],
    };
  },
  async requestPermissions() {
    return { granted: false, reason: WEB_LIMITATION };
  },
  async startAdvertising() {
    throw new CapacitorTransportError(WEB_LIMITATION);
  },
  async stopAdvertising() {},
  async startScan() {
    throw new CapacitorTransportError(WEB_LIMITATION);
  },
  async stopScan() {},
  async connect() {
    throw new CapacitorTransportError(WEB_LIMITATION);
  },
  async disconnect() {},
  async write() {
    throw new CapacitorTransportError(WEB_LIMITATION);
  },
  async addListener() {
    return { remove: async () => {} };
  },
} as CourierBlePlugin;
