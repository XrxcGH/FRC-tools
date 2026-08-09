# Courier BLE — iOS

The Swift half of the plugin boundary in
[`src/definitions.ts`](../src/definitions.ts): nine methods, four events, and no
protocol logic. Framing, reassembly, ordering, retry and the anti-entropy
protocol are in TypeScript, tested without a radio. This directory advertises,
scans, connects, reports an MTU, moves opaque packets, and reports disconnects.

| File | What it does |
|---|---|
| `Sources/CourierBlePlugin/CourierBlePlugin.swift` | The `CAPPlugin`: the nine bridged methods, the four events, the GATT constants copied from `@courier/ble`, and the serial queue everything runs on |
| `Sources/CourierBlePlugin/CourierPeripheral.swift` | `CBPeripheralManager`: publishes the service, advertises, and handles `updateValue` backpressure via `peripheralManagerIsReadyToUpdateSubscribers` |
| `Sources/CourierBlePlugin/CourierCentral.swift` | `CBCentralManager`: scans for the service UUID, connects, discovers characteristics, derives the MTU, subscribes to notifications |

**None of it has been compiled or run.** There was no Mac, no Xcode and no iOS
device involved in writing it. Every statement about Core Bluetooth behaviour in
the code comments is from Apple's documentation and is labelled as such. The
list at the bottom of this file is the honest inventory of what that leaves
unknown.

## Registering it

The plugin declares `identifier = "CourierBlePlugin"` and `jsName = "CourierBle"`,
so the JavaScript side is:

```ts
import { registerPlugin } from '@capacitor/core';
import { webFallbackPlugin, type CourierBlePlugin } from '@courier/capacitor';

export const CourierBle = registerPlugin<CourierBlePlugin>('CourierBle', {
  web: () => webFallbackPlugin,
});
```

Three files have to be listed by whatever packaging the app uses — the SPM
`Package.swift` target (`path: "ios/Sources/CourierBlePlugin"`) or the
`source_files` glob in the podspec. There is no other build configuration.

Conformance is to `CAPBridgedPlugin`, which is Capacitor 6 and later. Under
Capacitor 5 the `pluginMethods` list and the `identifier` / `jsName` properties
are unnecessary but harmless; the `@objc(CourierBlePlugin)` annotation and the
`@objc` methods are what the older bridge uses. `os.Logger` needs iOS 14, which
Capacitor 7 requires anyway.

## Info.plist keys

Required:

- **`NSBluetoothAlwaysUsageDescription`** — iOS 13 and later. Without it the app
  is terminated the first time it constructs a `CBCentralManager` or
  `CBPeripheralManager`, which for this plugin means the first call to
  `capabilities()`. Something like:

  > Courier uses Bluetooth to pass scouting data straight between devices at an
  > event, where there is no usable network. It never sends your data anywhere
  > else.

- **`NSBluetoothPeripheralUsageDescription`** — only needed if the deployment
  target goes below iOS 13. Harmless to include either way.

Deliberately **not** required:

- No location keys. Unlike Android, iOS does not tie BLE scanning to location
  permission; scanning is filtered by service UUID and never asks for one.
- No `UIBackgroundModes`. See below.

The permission prompt appears the first time a Core Bluetooth manager is
constructed, and the plugin constructs them lazily — on the first call to
`capabilities()`, `requestPermissions()`, `startAdvertising()` or `startScan()`,
never at app launch. Call `requestPermissions()` at a point in the UI where a
Bluetooth prompt makes sense to whoever is holding the tablet.

## Background BLE, and the App Store review problem

**This plugin declares no background mode, and that is a decision, not an
oversight.**

The technical half: iOS cripples backgrounded BLE in ways that happen to hit
exactly this use case.

- A backgrounded app's advertisement **drops the local name entirely**, so the
  device label the operator typed is gone and peers see an unnamed device.
- The service UUID moves out of the normal advertising packet into a special
  "overflow" area that **only an iOS device explicitly scanning for that exact
  UUID can see**. An Android central cannot see it at all. In a mixed pit of
  iPads and Android tablets, a backgrounded iPad is invisible to half the mesh.
- `CBCentralManagerScanOptionAllowDuplicatesKey` is ignored in the background,
  and scans are throttled.

The review half: `bluetooth-central` and `bluetooth-peripheral` in
`UIBackgroundModes` are assessed against App Store Review Guideline 2.5.4, which
requires the background use to be one the app genuinely needs and the user can
see. "Sync scouting data while the app is in someone's pocket" is a plausible
argument, but it is the kind that gets a review question, and a review question
costs a volunteer team a week it does not have during build season.

Courier's sync is an explicit operator action — someone taps "sync" and watches
it happen — so the foreground-only path loses very little. If background sync
ever becomes worth the fight, it needs the background modes, state restoration
(below), and a plan for the overflow-area problem, and it should be a considered
change rather than a flag someone flips.

## What state restoration would need

`CBCentralManagerOptionRestoreIdentifierKey` and
`CBPeripheralManagerOptionRestoreIdentifierKey` are deliberately absent from both
manager constructors. Adopting restoration means all of:

1. **The background modes above.** Restoration only ever relaunches an app that
   declared them; without them the option does nothing.
2. **`centralManager(_:willRestoreState:)` and
   `peripheralManager(_:willRestoreState:)`**, handling restored peripherals,
   restored subscribed centrals, restored published services, and a scan that was
   running before the relaunch.
3. **A story for `peerId`.** Handles are random tokens minted at discovery and
   held only in memory, on purpose — persisting them would create a durable
   correlator for devices belonging to minors' teams. So a restored connection
   arrives with no handle at all. The workable answer is to mint a fresh handle
   and emit `peerFound` for each restored peer, letting the TypeScript side open
   a new link over the existing connection. Persisting the handle table instead
   would be simpler and worse.
4. **Accepting that a frame in flight is lost.** The reassembler's partial state
   lives in the WebView and does not survive relaunch. This costs nothing
   permanent: the store is grow-only, so the peer re-offers the same records on
   the next round.
5. **Ordering against Capacitor's own startup.** `willRestoreState` fires very
   early, plausibly before the WebView has evaluated any JavaScript, so events
   emitted during restoration may arrive with nothing listening. `packetReceived`
   and `disconnected` are already emitted with `retainUntilConsumed: true` for a
   milder version of this race, but restoration would need that checked rather
   than assumed.

The honest summary: restoration mostly buys the ability to finish a sync the
operator walked away from, and it costs a background mode, a review argument, and
a fifth of a file of new lifecycle code. That trade should be made deliberately.

## Notes a reviewer will want

**Threading.** One serial `DispatchQueue` owns both managers and every piece of
mutable state. Both managers are constructed with it, so all delegate callbacks
land on it, and every bridge method hops onto it first. There are no locks. Event
emission hops once more to the main queue; since both queues are FIFO and the
emissions all originate from the one serial queue, packet order is preserved,
which matters because `Reassembler` discards an out-of-order packet rather than
splicing it.

Swift 6 strict concurrency is not adopted here — the code assumes Swift 5
language mode, as the Capacitor plugin template does. Under Swift 6 the
`queue.async` captures of `CBPeripheral` and friends would need explicit
isolation.

**MTU.** iOS never exposes the negotiated ATT MTU. It exposes payload lengths:
`peripheral.maximumWriteValueLength(for: .withoutResponse)` as a central and
`central.maximumUpdateValueLength` as a peripheral, both of which are
`ATT_MTU - 3`. The plugin adds those 3 bytes back before reporting, so that one
definition of "MTU" crosses the bridge and `payloadPerPacket()` in
`framing.ts` can subtract the same overhead it always does. The `.withResponse`
length is deliberately *not* used: iOS reports 512 there, which is the long-write
ceiling reached by splitting a value across several ATT PDUs at increasing
offsets — not an MTU, and a peer receiving those fragments would see corrupt
packets. The peripheral role refuses any write at a non-zero offset for the same
reason.

**Refused writes.** Both roles refuse rather than buffer. `write` resolves with
`accepted: false` and keeps no copy of the packet, so the TypeScript queue in
`PluginGattTransport` stays the only queue and packets cannot reorder between two
of them. Peripheral role: `updateValue` returned false, and `readyToWrite` is
fired from `peripheralManagerIsReadyToUpdateSubscribers` to exactly the peers
whose last write was refused (Apple does not say which central drained). Central
role: `canSendWriteWithoutResponse` was false, and `readyToWrite` is fired from
`peripheralIsReady(toSend:)`.

**Logging.** Packet contents are never logged, and neither are packet lengths or
the advertised device label. Connection lifecycle only. These are scouting
records belonging to minors' teams, and `os.Logger` output is readable by anyone
with the device on a cable.

**`peerId`.** A random UUID minted per peer per app session. Never a MAC address
(iOS does not expose one) and never `CBPeer.identifier`, which is a stable
per-host pseudonym for a specific remote device and stays inside the process.
The central and peripheral roles keep separate handle tables, because one
physical device can be simultaneously a peripheral this device connected to and a
central that connected to this device, and those are two different links.

**Link security.** The characteristics do not require encryption, so the GATT
link is not confidential unless the two devices happen to be bonded. That is a
deliberate trade — requiring encryption forces a pairing dance between two
tablets in the stands mid-match — and it is survivable because Courier's trust
model is per-record: every record is individually signed and a forged one is
rejected by the store. What it does *not* provide is secrecy of records in
flight against someone sniffing the air at the venue. If that ever matters, it is
a design decision above this layer, not a characteristic permission flag.

**Disconnecting an inbound peer.** Core Bluetooth gives a peripheral no way to
drop a connected central. `disconnect()` for a peer that connected *to* this
device forgets it and emits `disconnected` so the link settles; the radio
connection persists until the far side closes it or walks out of range.

## What could not be verified without a device

Everything in this list is a claim taken from documentation or from common
report, used because something had to be assumed, and never observed here.

1. **That any of it compiles.** No Xcode was run. Expect the first build to find
   typos in delegate signatures.
2. **The Capacitor API surface.** `CAPBridgedPlugin`, `CAPPluginMethod`, and
   `notifyListeners(_:data:retainUntilConsumed:)` are written against Capacitor 6/7
   as documented; the exact version in the app was not checked.
3. **`CourierGatt.maxAttMtu = 185`** — the ATT MTU iOS is documented to
   negotiate. Only the capability report depends on it; every MTU that affects
   framing is read from the live connection.
4. **Whether `respond(to:withResult:)` is correct for a write-*without*-response
   request.** Apple's wording requires exactly one response per `didReceiveWrite`
   and does not distinguish the two write types, so the code responds
   unconditionally.
5. **Whether `peripheralIsReady(toSend:)` fires when no write was ever
   attempted.** `canSendWriteWithoutResponse` has been reported false immediately
   after connection. The 100 ms readiness poll in `CourierCentral` exists solely
   because that ambiguity could otherwise stall a link for 15 seconds, and it
   should be deleted the moment someone with a device confirms the callback is
   reliable.
6. **That published services are dropped when the radio powers off** — the code
   republishes defensively on return to `.poweredOn`, and calls
   `removeAllServices()` first so a redundant republish cannot double-add.
7. **That a subscribed `CBCentral` cannot be correlated with a scanned
   `CBPeripheral`.** The two roles assume not, and assign independent handles.
8. **Advertisement packing.** Whether a given device label survives alongside a
   128-bit service UUID, or is truncated into the scan response.
9. **Background advertising and the overflow area.** Documented, not observed —
   including the claim that a non-Apple central cannot see it.
10. **Real throughput, and how often `updateValue` actually refuses under load.**
    The whole backpressure path is exercised only against the simulated transport
    in `@courier/ble`.
11. **Both roles running at once on one device**, which is the normal state for a
    mesh node: how iOS time-slices the radio between advertising, scanning and an
    active connection, and what that does to sync duration.
12. **Behaviour with several peers at once.** Nothing here assumes one, but
    nothing here has seen more than zero.
