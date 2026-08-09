/**
 * Adapting the plugin to a GattTransport, and the web fallback.
 *
 * This is the seam: above it, portable code with tests; below it, Kotlin and
 * Swift. Everything here is thin by design — if this file grows complicated,
 * the complication belongs in @courier/ble where it can be tested without a
 * radio.
 */

import { GattLink, type GattTransport } from '@courier/ble';
import {
  fromBase64,
  toBase64,
  type CourierBleCapabilities,
  type CourierBlePlugin,
} from './definitions.ts';

export class CapacitorTransportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CapacitorTransportError';
  }
}

type Unsubscribe = { remove: () => Promise<void> };

/**
 * One GATT connection, presented as the transport @courier/ble expects.
 *
 * `write` is synchronous in the GattTransport interface but asynchronous across
 * the Capacitor bridge, so this maintains a small outbound queue: the packet is
 * accepted optimistically, and a `false` from native re-queues it and waits for
 * `readyToWrite`. That keeps the backpressure semantics identical to the
 * simulated transport, which is what makes the simulator worth anything.
 */
export class PluginGattTransport implements GattTransport {
  readonly mtu: number;
  readonly label: string;

  readonly #plugin: CourierBlePlugin;
  readonly #peerId: string;
  readonly #subscriptions: Unsubscribe[] = [];
  #packetHandler: ((p: Uint8Array) => void) | null = null;
  #readyHandler: (() => void) | null = null;
  #disconnectHandler: (() => void) | null = null;
  #closed = false;
  /** Packets native refused; drained when it says it is ready. */
  readonly #retry: Uint8Array[] = [];
  #draining = false;

  constructor(plugin: CourierBlePlugin, peerId: string, mtu: number) {
    this.#plugin = plugin;
    this.#peerId = peerId;
    this.mtu = mtu;
    this.label = `ble:${peerId.slice(0, 8)}`;
  }

  /** Wire up native events. Must be awaited before the link is used. */
  async attach(): Promise<void> {
    this.#subscriptions.push(
      await this.#plugin.addListener('packetReceived', (e) => {
        if (e.peerId !== this.#peerId || this.#closed) return;
        this.#packetHandler?.(fromBase64(e.packet));
      }),
      await this.#plugin.addListener('readyToWrite', (e) => {
        if (e.peerId !== this.#peerId || this.#closed) return;
        void this.#drain();
        this.#readyHandler?.();
      }),
      await this.#plugin.addListener('disconnected', (e) => {
        if (e.peerId !== this.#peerId) return;
        this.#closed = true;
        this.#disconnectHandler?.();
      }),
    );
  }

  write(packet: Uint8Array): boolean {
    if (this.#closed) return false;
    // Anything already waiting must go first, or packets reorder — and the
    // reassembler rejects out-of-order packets rather than splicing them.
    if (this.#retry.length > 0) {
      this.#retry.push(packet.slice());
      return true;
    }
    this.#retry.push(packet.slice());
    void this.#drain();
    return true;
  }

  async #drain(): Promise<void> {
    if (this.#draining || this.#closed) return;
    this.#draining = true;
    try {
      while (this.#retry.length > 0 && !this.#closed) {
        const next = this.#retry[0]!;
        const { accepted } = await this.#plugin.write({
          peerId: this.#peerId,
          packet: toBase64(next),
        });
        if (!accepted) return; // wait for readyToWrite; the packet stays queued
        this.#retry.shift();
      }
    } catch {
      // A bridge failure is a disconnect from this layer's point of view.
      this.#closed = true;
      this.#disconnectHandler?.();
    } finally {
      this.#draining = false;
    }
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
    for (const s of this.#subscriptions) void s.remove();
    this.#subscriptions.length = 0;
    void this.#plugin.disconnect({ peerId: this.#peerId }).catch(() => {});
  }
}

/** Connect to a peer and return a Link ready for `syncOverLink`. */
export async function openLink(
  plugin: CourierBlePlugin,
  peerId: string,
): Promise<GattLink> {
  const conn = await plugin.connect({ peerId });
  const transport = new PluginGattTransport(plugin, peerId, conn.mtu);
  await transport.attach();
  return new GattLink(transport);
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
  async capabilities(): Promise<CourierBleCapabilities> {
    return {
      canAdvertise: false,
      canScan: false,
      maxMtu: 23,
      keyBacking: 'software',
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
