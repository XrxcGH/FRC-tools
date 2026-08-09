# Courier BLE — Android

The Kotlin half of the plugin boundary declared in
[`src/definitions.ts`](../src/definitions.ts). Nine methods, four events, and
nothing else: advertise, scan, connect, report the negotiated MTU, move opaque
packets in both directions, report disconnects.

**There is no protocol logic in this directory.** Framing, chunking,
reassembly, ordering, retry, backpressure policy and the anti-entropy protocol
all live in `@courier/ble` and `@courier/core` as portable TypeScript with tests
that run on a laptop with no radio. Every line of Kotlin here has to be written
again in Swift and maintained in both forever, which is the cost that killed
every predecessor to this project. If a change to this directory adds behaviour
rather than exposing a platform fact, it is in the wrong repository layer.

| File | Role |
|---|---|
| `CourierBlePlugin.kt` | The `@CapacitorPlugin`: the nine methods, the four events, permissions, lifecycle, and the opaque peer registry |
| `CourierGattServer.kt` | Peripheral — `BluetoothGattServer`, the Courier service, advertising, notification backpressure |
| `CourierGattClient.kt` | Central — scanning, `connectGatt`, MTU negotiation, subscription, characteristic writes |
| `src/main/AndroidManifest.xml` | Permission declarations |
| `build.gradle` | Scaffolding so the above compiles |

Registered under the name **`CourierBle`**, so the JavaScript side is:

```ts
import { registerPlugin } from '@capacitor/core';
import { webFallbackPlugin, type CourierBlePlugin } from '@courier/capacitor';

export const CourierBle = registerPlugin<CourierBlePlugin>('CourierBle', {
  web: () => webFallbackPlugin,
});
```

## Permissions

| Permission | Where | Why Courier needs it |
|---|---|---|
| `BLUETOOTH_SCAN` | API 31+, runtime | Find other Courier devices. Declared `neverForLocation` |
| `BLUETOOTH_ADVERTISE` | API 31+, runtime | Be findable — without it this device can only join a sync, never start one |
| `BLUETOOTH_CONNECT` | API 31+, runtime | Open the GATT connection, run the GATT server, read a peer's advertised name |
| `BLUETOOTH`, `BLUETOOTH_ADMIN` | ≤ API 30, install-time | The pre-split equivalents. Never requested at runtime |
| `ACCESS_FINE_LOCATION` | ≤ API 30, runtime | Android refused to return *any* scan result without it |

Android 12 (API 31) split Bluetooth into three permissions named for what an app
does with the radio, and let an app that only wants to know *which devices are
nearby* — rather than *where it is* — say so with
`android:usesPermissionFlags="neverForLocation"`. The platform enforces that
assertion by stripping location-inferring content from scan results. Courier
tells the truth here: it looks for one service UUID and reads a device label. So
the manifest declares the flag, caps `ACCESS_FINE_LOCATION` at
`maxSdkVersion="30"`, and never asks for background location at all.

Before API 31 there was no way to say that. From Android 6 through 11, any BLE
scan required a location permission, because a list of nearby radios plus a map
of where those radios live is a position fix. That reasoning was sound and the
consequence was ugly: a scouting app had to ask a stands full of students for
*location* access to move data three metres. Two practical hangovers:

- On API ≤ 30, `ACCESS_FINE_LOCATION` being *granted* is not enough. Location
  services must also be **switched on device-wide** or the scan returns an empty
  list forever with no error. This is the single most common reason a scan finds
  nothing on an older tablet, so the plugin checks it explicitly and returns it
  as a `limitations` sentence from `capabilities()` and as the `reason` from
  `requestPermissions()`.
- `requestPermissions()` requests the API-31 trio *or* the location permission,
  chosen at runtime. Requesting `BLUETOOTH_SCAN` on Android 11 is not merely
  useless, it can never be granted, so the two are separate Capacitor permission
  aliases and only one is ever asked for.

## SDK levels

| | |
|---|---|
| `minSdk` | **23** (Android 6.0) |
| `compileSdk` / `targetSdk` | 34 |

23, not higher, because FRC teams run donated and hand-me-down hardware and the
whole point of Courier is to work on what a team already has. 23 is also where
two floors coincide: it is Capacitor's own minimum, and it is where Android's
runtime-permission model begins — below it `ACCESS_FINE_LOCATION` is granted at
install time and the permission code here would need a second path for a
platform nobody should still be putting student data on.

23, not lower, even though `BluetoothGattServer` reaches back to 18 and LE
advertising to 21, because Capacitor will not build below 23 and inventing
support for API levels the framework cannot reach would be a lie in a table.

`compileSdk 34` is required by the API-33 Bluetooth methods
(`notifyCharacteristicChanged` and `writeCharacteristic` returning a
`BluetoothStatusCodes` int rather than a boolean). Every call to one is behind a
`Build.VERSION.SDK_INT` check with the deprecated overload on the other branch.

## How the nine methods map onto Android's two roles

A Courier mesh needs both roles: someone advertises, someone scans. The contract
does not distinguish them, so the plugin routes by peer:

- **`startAdvertising`** opens the GATT server (once), registers the service, and
  starts a legacy advertisement. **`stopAdvertising`** stops advertising only —
  the server stays up so that centrals already connected are not dropped. Both
  are torn down in `handleOnDestroy` and when Bluetooth is switched off.
- **`peerFound`** is emitted from two places. Scanning emits it on discovery
  (throttled to one report per peer per 5 s, since `SCAN_MODE_LOW_LATENCY`
  produces tens of results a second). The server emits it when a central writes
  `ENABLE_NOTIFICATION` to the TX characteristic's CCCD — *not* on connect, both
  because a peer that has not subscribed cannot be written to, and because by
  subscription time the MTU exchange has normally happened, so the MTU reported
  is the real one rather than 23.
- **`connect`** prefers an existing path over making a new one. If the peer is
  already connected to our GATT server, it resolves immediately with that
  connection's MTU. Otherwise it runs the central sequence: `connectGatt`
  (`autoConnect=false`, `TRANSPORT_LE`) → `requestMtu(247)` → `discoverServices`
  → `setCharacteristicNotification` + CCCD write → resolve.
- **`write`** routes to `notifyCharacteristicChanged` when we are the peripheral
  for that peer and to `writeCharacteristic` (write-without-response) when we are
  the central.

`peerId` is a random UUID minted on first sight and held in a table inside the
plugin, keyed by Bluetooth address. **The address never crosses the bridge and is
never logged.** Both platforms rotate BLE addresses specifically so a device
cannot be followed around a venue, and handing one to JavaScript would undo that
and leak it into stores, logs and bug reports. Two consequences: handles do not
survive an app restart, and a peer that rotates its address is seen as a new
peer. Courier's real device identity is its Ed25519 key, established by the
pairing ceremony — not anything the radio says.

## Backpressure, and why `accepted: false` is not an error

The contract requires `write` to return `accepted: false` when the stack did not
take the packet, so the TypeScript side can re-send *that same packet* after
`readyToWrite`. On Android that condition arises twice:

- **Peripheral.** The framework documents that an application must wait for
  `onNotificationSent` before sending another notification. One notification per
  peer is tracked in flight; a second `write` returns `accepted: false`, and
  `onNotificationSent` fires `readyToWrite`.
- **Central.** `BluetoothGatt` permits one outstanding operation per connection;
  a second write before `onCharacteristicWrite` is dropped by the framework, not
  queued. Same treatment, with `onCharacteristicWrite` firing `readyToWrite`.

There is a third, rarer case: the stack refuses (`ERROR_GATT_WRITE_BUSY`, or a
`false` return pre-33) when nothing of ours is outstanding, so no completion
callback is coming and nothing would ever wake the writer. The plugin reports
`accepted: false` and schedules the `readyToWrite` itself after 25 ms. Without
that, the link would sit until `GattLink`'s 15-second stall timeout and then
declare the peer gone.

A packet larger than `mtu - 3` is rejected with an error rather than sent,
because the stack would truncate it and the corruption would surface much later
as a signature failure on an unrelated record.

## The advertisement — an interop contract with the Swift half

Legacy advertising only, deliberately. Bluetooth 5 extended advertising would
carry a longer payload, but its PDUs are invisible to legacy scanners, and a
team's device fleet is whatever was donated over the last decade. Being findable
by an old tablet is worth more than a long label.

| | Contents |
|---|---|
| Advertisement (31 B) | Flags (3) + Complete List of 128-bit Service UUIDs: the Courier service (18) |
| Scan response (31 B) | Service Data — 128-bit UUID (AD type `0x21`), UUID = the Courier service, value = the UTF-8 device label |

That leaves **13 bytes for the label**, and longer labels are truncated over the
air on a UTF-8 code-point boundary. `pit-laptop` fits; `stands-tablet-3` does
not and advertises as `stands-tablet`. Operators who need to tell devices apart
at a glance should keep labels to 13 bytes.

The label is in service data rather than in the device-name AD structure because
Android's `setIncludeDeviceName(true)` advertises the *adapter* name — "Galaxy
Tab A8", or whatever the owner called their phone — and the only way to change
that is `BluetoothAdapter.setName`, which renames the device for every app and
every pairing. Not worth it.

When scanning, the label is read from service data first and from the advertised
local name second; the second path is what an iOS peripheral publishes through
`CBAdvertisementDataLocalNameKey`. **The Swift side should advertise both**: the
service UUID for the scan filter, and the label in service data under the same
UUID, so an Android scanner sees the Courier label rather than the iPhone's
name.

The label is a DEVICE name and is broadcast in the clear to everyone in the
building. There is no API in this plugin that could carry a person's name and
there must not be one.

## Deliberately not done

- **No bonding, no encrypted characteristic permissions.** Requiring encryption
  would force a BLE pairing dialog on both devices in the stands during a match.
  Courier does not need a trusted transport: every record is individually signed
  with Ed25519 and the key registry decides whose records are admitted. An
  eavesdropper sees signed scouting data; a forger is rejected on signature.
- **No reconnect policy.** One retry on GATT status 133 during the initial
  connect, because 133 is Android's transient catch-all and a single clean retry
  is nearly free. Anything beyond that is a decision for whoever is driving the
  sync.
- **No foreground service.** Whether a sync survives the screen locking is an
  app-level choice with a notification attached to it; a plugin should not
  decide it.
- **`capabilities().keyBacking` is always `"software"`.** There is no signing
  method among the nine, so Courier's Ed25519 key is generated and used in the
  JavaScript heap by `@noble/curves` and is exportable by construction.
  Reporting `"hardware"` because the handset ships StrongBox would claim a
  guarantee over a key the keystore never touches.
- **`capabilities().maxMtu` reports 247, not 517.** 517 is what Android's
  framework will *carry*; 247 is what this plugin *asks for*, matching
  `PREFERRED_MTU`, because that is what data-length extension delivers in one
  link-layer packet. The field is documented as the largest MTU the platform
  will negotiate, and negotiating something never attempted is not a capability.

## What could not be verified without a device

None of this has been run. There is no hardware in this loop — no phone, no
tablet, no sniffer — and everything below rests on published platform behaviour
rather than observation. Each is a specific thing to check first with two real
devices.

1. **That any of it works end to end.** It has never been compiled against a real
   Android SDK, let alone run. Treat first-run compile errors as expected.
2. **Whether `onNotificationSent` gates notifications per device or per server.**
   The documentation says an application must wait for it before sending another
   notification, without saying whether "another" means to the same central. The
   in-flight flag is per device, which is what every implementation I have read
   does. If it is actually per server, a pit laptop serving two tablets at once
   will drop notifications, and the fix is to move that flag up to the enclosing
   class.
3. **Whether `requestMtu` before `discoverServices` is the more reliable order.**
   It is done that way here because the MTU has to be settled before the peer is
   reported connected — the TypeScript side is told the MTU once and sizes every
   packet from it. Some OEM stacks are reported to prefer discovery first. If
   that matters, the two calls swap and `onServicesDiscovered` chains into
   `requestMtu`.
4. **Whether write-without-response is the right write type.** Chosen for
   symmetry with the notify direction, which is also unacknowledged, and for
   roughly double the throughput. It should not be lossy — the link layer
   retransmits, and a full local buffer refuses the write rather than dropping
   it — but that is a claim about documented behaviour, not a measurement.
   Switching to `WRITE_TYPE_DEFAULT` is a one-line change nothing above depends
   on.
5. **The negotiated MTU on real hardware.** 247 is requested; what is granted
   varies by chipset and by peer, and the plugin uses whatever it gets. No
   throughput figure anywhere in this repository comes from a radio.
6. **Timing constants.** The 20 s connect timeout, the 5 s GATT service
   registration timeout, the 500 ms window used to decide a scan started
   successfully, the 600 ms pause before the status-133 retry, the 25 ms
   ready-to-write hint, and the 5 s per-peer discovery throttle are all judgement
   calls. None is measured.
7. **That an inbound central's MTU is known by the time it subscribes.** The
   argument is that the Courier central negotiates the MTU before writing the
   CCCD, so the ordering holds between two Courier devices. It has not been
   watched on a sniffer. If an MTU exchange ever lands after the CCCD write, that
   peer runs the whole session at MTU 23 — correct, just slow.
8. **Behaviour when both devices connect to each other simultaneously.** The
   plugin prefers the peripheral path for writes, which keeps each direction on
   exactly one path and therefore keeps packet order, but the crossed case has
   not been exercised.
9. **`cancelConnection` and app-initiated `disconnect` callbacks.** Neither is
   documented to reliably produce `onConnectionStateChange`, so the plugin emits
   `disconnected` itself and de-duplicates by having already dropped the peer
   from its table. Whether a duplicate ever arrives on real hardware is unknown.
10. **Advertising payload sizes.** The 13-byte label budget is arithmetic on the
    legacy 31-byte scan response, not something observed; if a particular stack
    reserves bytes we have not accounted for, `startAdvertising` will reject with
    `ADVERTISE_FAILED_DATA_TOO_LARGE` and the budget needs lowering.
11. **Which Android versions actually support Ed25519 in Keystore.** Irrelevant
    today because `keyBacking` is `"software"` for a structural reason, but it is
    the fact that would have to be established before that could ever change.
12. **The window between `connect()` resolving and `attach()` finishing.**
    `PluginGattTransport.attach()` registers its listeners *after* `connect()`
    resolves, so a `packetReceived` emitted in between has no listener and
    Capacitor drops it. The peripheral side should win this race — its
    `onDescriptorWriteRequest` fires before the central's `onDescriptorWrite`,
    giving it a head start of one ATT round trip — but that is an argument, not
    an observation, and losing the first packet of a frame costs the whole frame.
    The obvious fix, `notifyListeners(..., retainUntilConsumed = true)`, is
    **not** used here on purpose: Capacitor flushes the retained queue to
    whichever listener attaches first, so on a device holding two inbound links
    at once, peer A's transport would receive and discard peer B's packets. If
    this window turns out to bite, the fix belongs in `transport.ts` — attach
    before connect — not in Kotlin.
