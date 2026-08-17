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
| 1 | `src/plugin.ts` registers the plugin. Without it nothing was reachable from JS at all |
| 2 | `CourierBle.podspec` and the `capacitor` block in `package.json`, so `npx cap sync` can find both halves |
| 3 | `CourierCentral.swift` reads the Courier label from **service data** before the local name, and no longer falls back to `peripheral.name` — the GAP name on a phone is frequently personal |
| 4 | The listener race is closed in TypeScript by [`CourierBleHub`](src/hub.ts), which registers listeners once and demuxes by `peerId`. `retainUntilConsumed` is removed from both Swift emissions: it was correct when written and became harmful the moment the hub closed that window, because Capacitor flushes a retained queue to the *first* listener and one peer would drain another's packets |
| 5 | Both Android roles carry a per-peer `readyOwed` flag, so `readyToWrite` fires only when a write was actually refused — matching Swift, and no longer spending the bridge once per packet |
| 6 | `CourierBlePlugin.kt` keeps **one PeerRegistry per role**. Sharing one meant a crossed connection produced a single `peerId` and interleaved two ordered streams into one reassembler, losing every interleaved frame |
| 7 | `CourierGattServer.labelOf` returned the Android adapter name, which is very often a person's name. Now `""` |
| 8 | All four `peerFound.label` paths return `""` when no Courier label exists, instead of three different sentinels |
| 9 | Android drops the RSSI `127` "unavailable" sentinel, which would otherwise render as full signal strength |
| 11 | Android rejects an empty packet, as Swift already did |
| 13 | `CourierGattServer` refuses an RX write from a central that never subscribed, instead of minting a `peerId` JS was never told about |
| 14 | Connect timeout is 15 s on both platforms |
| 15 | `definitions.ts` said "three events"; there are four |
| — | The three Kotlin files carry the "NOT COMPILED, NOT RUN, NO DEVICE" header the Swift files had |

## Outstanding

None from the cross-review. All fifteen items are addressed.

That is not the same as working. Nothing here has been compiled, and the twelve-item hardware list in [`android/README.md`](android/README.md) is untouched — it records what could not be checked without two devices, including the per-device-vs-per-server ambiguity in `onNotificationSent` and the MTU-before-discovery ordering.

Two of the fixes were judgement calls rather than obvious corrections, and are worth re-examining once someone has hardware:

- **The MTU floor (12).** `attMtu` no longer clamps up to 23. Clamping reported a capacity the connection did not have, so framing sized packets that every write then refused as `.tooLarge` — surfacing as a disconnect pointing at the wrong cause. BLE guarantees at least 23, so a smaller value is a real fault worth seeing. If some device legitimately reports a short payload, this turns a silent stall into a loud failure, which is the intended trade but is still a trade.
- **Discovery cadence (10).** Android now emits one `peerFound` per device per scan, matching iOS, instead of re-reporting every 5 s. Both behaviours were defensible; the divergence was the defect. Aligning to the cheaper one follows the design's own constraint that there are no power outlets in the stands. The cost is that a UI wanting live RSSI must restart the scan.
## Honesty corrections applied

The review found three claims stated more strongly than the evidence supports, which matters more here than usual because nobody can check them by running anything. All three are qualified: the write-without-response throughput claim is marked as a reading of the spec rather than a measurement; the status-133 retry success rate is marked unmeasured and attributed to other people's bug reports; and `capabilities` says "reports it can do, queried at runtime" rather than "verified".

## Before a device test

1. **Get it to compile.** This is the gating step and nothing here has seen a compiler. Expect the first build to find typos in delegate and callback signatures.
2. Work the twelve-item verification list in [`android/README.md`](android/README.md) and the equivalent in [`ios/README.md`](ios/README.md), which record what could not be checked without hardware — including the per-device-vs-per-server ambiguity in `onNotificationSent` and the MTU-before-discovery ordering.

And when the radio numbers finally exist, revisit [`docs/MEASUREMENTS.md`](../../docs/MEASUREMENTS.md) §5. `LEAF_THRESHOLD` in the reconciliation layer is derived from an *assumed* ~1.8 s connection setup, and that assumption becomes checkable the moment two real devices talk.
