/**
 * @courier/capacitor — the plugin boundary.
 *
 * Fixes the amount of code that must be written twice, once in Kotlin and once
 * in Swift: nine methods and four events. Everything else is portable
 * TypeScript with tests that run on a laptop with no radio.
 *
 * The registered plugin object lives at `@courier/capacitor/plugin`, imported
 * separately because it pulls in `@capacitor/core` — which a test, a CLI, or a
 * server-side consumer has no reason to load.
 */

export {
  toBase64,
  fromBase64,
  meshBlockers,
  type CourierBlePlugin,
  type CourierBleCapabilities,
  type CourierPeer,
  type CourierConnection,
} from './definitions.ts';

export {
  PluginGattTransport,
  webFallbackPlugin,
  CapacitorTransportError,
} from './transport.ts';

export { CourierBleHub, type HubStats } from './hub.ts';
