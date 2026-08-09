/**
 * @courier/capacitor — the plugin boundary.
 *
 * Fixes the amount of code that must be written twice, once in Kotlin and once
 * in Swift: nine methods and four events. Everything else is portable
 * TypeScript with tests that run on a laptop with no radio.
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
  openLink,
  webFallbackPlugin,
  CapacitorTransportError,
} from './transport.ts';
