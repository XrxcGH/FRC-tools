# Native status

**The Kotlin and Swift here have never been compiled or run.** There is no device, no Xcode, and no Android SDK in the loop that produced them. They were written against [`src/definitions.ts`](src/definitions.ts) and then cross-reviewed against each other, which catches contract drift but cannot catch anything a compiler would.

Treat this as a first draft that is worth reviewing, not as code that works.

## What the cross-review confirmed is right

The thing the design cares about most is correct on both platforms:

- `write` returns `accepted: false` **without having sent the packet**, and neither side keeps a copy — so `PluginGattTransport` stays the only queue and packets cannot reorder between two of them.
- No protocol logic is duplicated in native. Neither implements framing, reassembly, ordering, or packet retry.
- Nine methods, four events, matching names and argument shapes on both sides. MTU units agree. `peerId` is a random UUID on both, never a MAC.
- No comment in either implementation claims a device test or a measurement.

## Fixed since the review

| # | Fix |
|---|---|
| 1 | `src/plugin.ts` now registers the plugin; without it nothing was reachable from JS |
| 2 | `CourierBle.podspec` and the `capacitor` block in `package.json`, so `npx cap sync` can find both halves |
| 4 | The listener race is closed in TypeScript by [`CourierBleHub`](src/hub.ts), which registers listeners once and demuxes by `peerId`. `retainUntilConsumed` should now be removed from the Swift emissions — it is no longer needed and is actively harmful, because Capacitor flushes a retained queue to the *first* listener and one peer would drain another's packets |
| 7 | `CourierGattServer.labelOf` returned the Android adapter name, which is very often a person's name. Now returns `""` |
| 15 | `definitions.ts` said "three events"; there are four |
| — | The three Kotlin files now carry the "NOT COMPILED, NOT RUN, NO DEVICE" header the Swift files had, and three over-claiming comments are qualified |

## Outstanding — must be fixed before a device test

Ordered by what will bite first on a mixed-platform test.

| # | Where | Defect |
|---|---|---|
| 3 | `CourierCentral.swift` `didDiscover` | Reads only the local name, but the Android peripheral puts the label in **Service Data** under the service UUID and sets `setIncludeDeviceName(false)`. Every Android device therefore appears on an iPad blank or labelled with its adapter name. Read `CBAdvertisementDataServiceDataKey`. Note the contract is one-directional: `CBPeripheralManager.startAdvertising` accepts only local-name and service-UUID keys, so iOS cannot reciprocate and the Android scanner's local-name fallback is already correct |
| 6 | `CourierBlePlugin.kt` | One `PeerRegistry` is shared by both roles, so a device connected in both directions gets **one** `peerId` and inbound packets from both roles interleave into a single transport — whose reassembler discards out-of-order packets. Swift keeps separate tables per role and is right. Give Kotlin one registry per role |
| 5 | `CourierGattClient.kt`, `CourierGattServer.kt` | `readyToWrite` fires after *every* completed write, not only when something was refused. Not corrupting, but it violates "exactly once per drain" and on a 40-packet frame crosses the bridge ~40 extra times. Add a per-peer `readyOwed` flag |
| 13 | `CourierGattServer.kt` | Emits `packetReceived` for a central that never subscribed, minting a `peerId` JS was never told about. Swift refuses the write instead |
| 12 | `CourierCentral.swift` | `max(minMtu, payload + 3)` can report an MTU larger than the connection carries, after which every write fails and the link dies with a misleading error |
| 10 | both | Android re-emits `peerFound` every 5 s, iOS emits once per scan |

## Honesty corrections applied

The review found three claims stated more strongly than the evidence supports. All three are now qualified: the write-without-response throughput claim is marked as a reading of the spec rather than a measurement, the status-133 retry success rate is marked unmeasured, and `capabilities` says "reports it can do, queried at runtime" instead of "verified". The three Kotlin files also carry the not-compiled header the Swift files already had.
## Before a device test

1. Fix items 3, 4b, and 6 — each produces wrong behaviour on the first mixed-platform test, and all three would be misread at an event as radio flakiness rather than plugin bugs.
2. Get it to compile. Nothing here has seen a compiler.
3. Then work the twelve-item verification list in [`android/README.md`](android/README.md) and the equivalent in [`ios/README.md`](ios/README.md), which record what could not be checked without hardware.

And when the radio numbers finally exist, revisit [`docs/MEASUREMENTS.md`](../../docs/MEASUREMENTS.md) §5 — `LEAF_THRESHOLD` in the reconciliation layer is derived from an *assumed* ~1.8 s connection setup, and that assumption becomes checkable the moment two real devices talk.
