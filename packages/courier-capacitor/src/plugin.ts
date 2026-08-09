/**
 * The registration that makes the native halves reachable.
 *
 * Without this the package is a contract and two implementations with nothing
 * joining them: `openLink` needs an object, and neither Kotlin nor Swift can
 * supply one on its own.
 *
 * The web fallback is wired in here rather than left to the caller, so a build
 * that runs in a browser degrades to an honest "this platform cannot do BLE"
 * instead of throwing about a missing plugin. That distinction is the whole
 * point of the fallback existing.
 */

import { registerPlugin } from '@capacitor/core';
import type { CourierBlePlugin } from './definitions.ts';
import { webFallbackPlugin } from './transport.ts';

export const CourierBle = registerPlugin<CourierBlePlugin>('CourierBle', {
  web: () => webFallbackPlugin,
});
