/**
 * The plugin boundary.
 *
 * This file exists so that the amount of code which must be written twice — once
 * in Kotlin, once in Swift — is fixed, small, and reviewable. The design
 * identifies cross-platform native maintenance as the thing that killed every
 * predecessor to this project, and the mitigation is not discipline; it is
 * making the native surface too small to rot.
 *
 * Everything below is what native must provide. Everything else — framing,
 * reassembly, ordering, backpressure handling, the anti-entropy protocol, the
 * record format, the store — is portable TypeScript with tests that run on a
 * laptop with no radio.
 *
 * ── Why this cannot be a web API ────────────────────────────────────────────
 * Web Bluetooth has no peripheral (GATT server) role in any browser, and is not
 * implemented in iOS Safari at all. Two phones in the stands need one of them
 * to advertise, so at least one side must be a peripheral, so a PWA cannot do
 * this on any platform. Every solo developer who reached this point chose a PWA
 * and deferred the transport indefinitely; that unclaimed native work is
 * precisely the moat.
 */

import type { KeyBacking } from '@courier/core';

/** What a platform can actually do. Reported, never assumed. */
export interface CourierBleCapabilities {
  /** Can this device advertise as a peripheral? Required to be discovered. */
  readonly canAdvertise: boolean;
  /** Can this device scan and connect as a central? */
  readonly canScan: boolean;
  /** Largest ATT MTU the platform will negotiate. 23 if it will not. */
  readonly maxMtu: number;
  /** Whether a non-exportable keystore is available (D-10). */
  readonly keyBacking: KeyBacking;
  /**
   * Populated when a capability is missing, in words an operator can act on.
   *
   * ChromeOS is the case that matters: it can scan but generally cannot
   * advertise, so a team whose only devices are school Chromebooks cannot form
   * a mesh at all and must use USB or QR. Saying so out loud beats a mesh that
   * silently never discovers anyone.
   */
  readonly limitations: readonly string[];
}

export interface CourierPeer {
  /** Opaque, platform-assigned. NOT a MAC address — those are rotated and private. */
  readonly peerId: string;
  /** Advertised short name. Never a person's name; the device label (D-20). */
  readonly label: string;
  readonly rssi?: number;
}

export interface CourierConnection {
  readonly peerId: string;
  readonly mtu: number;
}

/**
 * The native plugin.
 *
 * Nine methods and four events. If this file grows, the argument for the whole
 * architecture weakens, so additions should be resisted rather than accepted.
 */
export interface CourierBlePlugin {
  capabilities(): Promise<CourierBleCapabilities>;

  /** Request whatever runtime permissions the platform demands. */
  requestPermissions(): Promise<{ granted: boolean; reason?: string }>;

  /** Begin advertising the Courier service so peers can find this device. */
  startAdvertising(options: { label: string }): Promise<void>;
  stopAdvertising(): Promise<void>;

  startScan(): Promise<void>;
  stopScan(): Promise<void>;

  connect(options: { peerId: string }): Promise<CourierConnection>;
  disconnect(options: { peerId: string }): Promise<void>;

  /**
   * Queue one packet.
   *
   * `accepted: false` means the stack did NOT take it and it must be retried
   * after `readyToWrite` fires. This mirrors iOS `updateValue`, and it is not
   * an error path — under load it is the common path. A native implementation
   * that returns true unconditionally will lose data silently.
   */
  write(options: { peerId: string; packet: string }): Promise<{ accepted: boolean }>;

  addListener(
    event: 'packetReceived',
    handler: (e: { peerId: string; packet: string }) => void,
  ): Promise<{ remove: () => Promise<void> }>;
  addListener(
    event: 'readyToWrite',
    handler: (e: { peerId: string }) => void,
  ): Promise<{ remove: () => Promise<void> }>;
  addListener(
    event: 'peerFound',
    handler: (e: CourierPeer) => void,
  ): Promise<{ remove: () => Promise<void> }>;
  addListener(
    event: 'disconnected',
    handler: (e: { peerId: string; reason?: string }) => void,
  ): Promise<{ remove: () => Promise<void> }>;
}

/**
 * Packets cross the bridge as base64.
 *
 * Capacitor serialises plugin arguments as JSON, so raw bytes have to be
 * encoded somehow. Base64 costs 33% over the wire between JS and native —
 * irrelevant, since that hop is in-process — and it is the one encoding both
 * platforms already have in their standard libraries.
 */
export function toBase64(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

export function fromBase64(text: string): Uint8Array {
  const s = atob(text);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

/**
 * What a platform must satisfy before it can host a mesh.
 *
 * Returns the reasons it cannot, empty when it can. Callers should show these
 * verbatim: "your Chromebooks can join a sync but cannot start one" is
 * actionable, and a spinner that never finds anyone is not.
 */
export function meshBlockers(caps: CourierBleCapabilities): string[] {
  const blockers: string[] = [];
  if (!caps.canAdvertise) {
    blockers.push(
      'This device cannot advertise, so other devices cannot find it. It can still join a ' +
        'sync that another device starts, and it can always exchange data over USB or QR.',
    );
  }
  if (!caps.canScan) {
    blockers.push('This device cannot scan, so it cannot start a sync with anyone.');
  }
  if (caps.maxMtu < 23) {
    blockers.push(`Reported MTU of ${caps.maxMtu} is below the BLE minimum of 23.`);
  }
  return [...blockers, ...caps.limitations];
}
