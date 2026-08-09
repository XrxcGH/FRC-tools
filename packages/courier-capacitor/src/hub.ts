/**
 * The event hub.
 *
 * ── The race this exists to close ───────────────────────────────────────────
 * The obvious shape — connect to a peer, then attach listeners to the plugin —
 * has a window between the two where a packet can arrive with nobody listening.
 * On a link that opens with the peer already mid-frame, that is the *first*
 * packet, and losing it costs the whole frame.
 *
 * The tempting patch is Capacitor's `retainUntilConsumed`, and it is worse than
 * the bug. Capacitor flushes a retained queue when the FIRST listener for an
 * event attaches — so on a device holding two inbound links, peer A's transport
 * receives peer B's retained packets, filters them out by peerId, and drops
 * them. B never sees them and has no way to know. A dropped packet is a lost
 * frame; a *stolen* packet is a lost frame that also looks like radio flakiness
 * at an event, which is the worst kind of defect to debug in a pit.
 *
 * So: listeners are registered exactly once, at the hub, before any connection
 * exists. Packets are demultiplexed by peerId, and anything arriving for a peer
 * whose transport has not been created yet is buffered here until it is. No
 * retention, no ordering hazard, and both platforms behave identically.
 */

import { GattLink } from '@courier/ble';
import { fromBase64, type CourierBlePlugin, type CourierPeer } from './definitions.ts';
import { PluginGattTransport } from './transport.ts';

/** Discard buffered packets for a peer that never opens a link. */
const BUFFER_TTL_MS = 30_000;
/** Refuse to buffer unboundedly for a peer that is talking to nobody. */
const MAX_BUFFERED_PACKETS = 512;

interface Buffered {
  packets: Uint8Array[];
  firstAt: number;
}

export interface HubStats {
  bufferedPeers: number;
  bufferedPackets: number;
  droppedForOverflow: number;
  droppedForAge: number;
}

export class CourierBleHub {
  readonly #plugin: CourierBlePlugin;
  readonly #transports = new Map<string, PluginGattTransport>();
  readonly #buffers = new Map<string, Buffered>();
  readonly #peerHandlers = new Set<(peer: CourierPeer) => void>();
  readonly #now: () => number;
  #listening: Promise<void> | null = null;

  readonly stats: HubStats = {
    bufferedPeers: 0,
    bufferedPackets: 0,
    droppedForOverflow: 0,
    droppedForAge: 0,
  };

  constructor(plugin: CourierBlePlugin, now: () => number = Date.now) {
    this.#plugin = plugin;
    this.#now = now;
  }

  /** Register the four listeners exactly once, whatever calls in. */
  #listen(): Promise<void> {
    if (this.#listening) return this.#listening;
    this.#listening = (async () => {
      await this.#plugin.addListener('packetReceived', (e) => {
        const t = this.#transports.get(e.peerId);
        const bytes = fromBase64(e.packet);
        if (t) t.deliver(bytes);
        else this.#buffer(e.peerId, bytes);
      });
      await this.#plugin.addListener('readyToWrite', (e) => {
        this.#transports.get(e.peerId)?.signalReady();
      });
      await this.#plugin.addListener('disconnected', (e) => {
        this.#transports.get(e.peerId)?.signalDisconnect();
        this.#transports.delete(e.peerId);
        this.#buffers.delete(e.peerId);
      });
      await this.#plugin.addListener('peerFound', (peer) => {
        for (const h of this.#peerHandlers) h(peer);
      });
    })();
    return this.#listening;
  }

  #buffer(peerId: string, packet: Uint8Array): void {
    this.#expire();
    let b = this.#buffers.get(peerId);
    if (!b) {
      b = { packets: [], firstAt: this.#now() };
      this.#buffers.set(peerId, b);
    }
    if (b.packets.length >= MAX_BUFFERED_PACKETS) {
      // Dropping the oldest keeps the newest frame intact; dropping the newest
      // would guarantee every frame is torn.
      b.packets.shift();
      this.stats.droppedForOverflow++;
    }
    b.packets.push(packet);
    this.#recount();
  }

  #expire(): void {
    const cutoff = this.#now() - BUFFER_TTL_MS;
    for (const [peerId, b] of this.#buffers) {
      if (b.firstAt < cutoff) {
        this.stats.droppedForAge += b.packets.length;
        this.#buffers.delete(peerId);
      }
    }
    this.#recount();
  }

  #recount(): void {
    this.stats.bufferedPeers = this.#buffers.size;
    let n = 0;
    for (const b of this.#buffers.values()) n += b.packets.length;
    this.stats.bufferedPackets = n;
  }

  /** Subscribe to discovery. Returns an unsubscribe function. */
  onPeerFound(handler: (peer: CourierPeer) => void): () => void {
    void this.#listen();
    this.#peerHandlers.add(handler);
    return () => this.#peerHandlers.delete(handler);
  }

  async startScan(): Promise<void> {
    await this.#listen();
    await this.#plugin.startScan();
  }

  async stopScan(): Promise<void> {
    await this.#plugin.stopScan();
  }

  async startAdvertising(label: string): Promise<void> {
    await this.#listen();
    await this.#plugin.startAdvertising({ label });
  }

  async stopAdvertising(): Promise<void> {
    await this.#plugin.stopAdvertising();
  }

  /**
   * Open a link to a peer.
   *
   * The transport is registered BEFORE `connect()` is awaited, so a packet
   * arriving during the connect round-trip lands in the right place rather than
   * in a window where nothing is listening.
   */
  async open(peerId: string): Promise<GattLink> {
    await this.#listen();

    const existing = this.#transports.get(peerId);
    if (existing) {
      throw new Error(`already connected to ${peerId}; close the existing link first`);
    }

    // Provisional MTU: the conservative floor, replaced the moment connect()
    // reports the negotiated value. Nothing is sent before that happens.
    const transport = new PluginGattTransport(this.#plugin, peerId, 23);
    this.#transports.set(peerId, transport);
    transport.onClosed(() => this.#transports.delete(peerId));

    // Anything that arrived while we were setting up.
    const buffered = this.#buffers.get(peerId);
    if (buffered) {
      this.#buffers.delete(peerId);
      this.#recount();
      for (const p of buffered.packets) transport.deliver(p);
    }

    try {
      const conn = await this.#plugin.connect({ peerId });
      transport.setMtu(conn.mtu);
    } catch (err) {
      this.#transports.delete(peerId);
      throw err;
    }

    return new GattLink(transport);
  }

  /** Peers with a live transport. */
  get openPeers(): string[] {
    return [...this.#transports.keys()];
  }
}
