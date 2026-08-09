# FRC Tools — design research

Three pieces of FIRST Robotics Competition software that should exist and don't, derived from a research pass over what the community actually says is missing, then put through an adversarial review that cut the scope in half.

**Start here:** [DESIGN.md](DESIGN.md) — and read §0 first. It is the single source of truth where the five drafted sections disagree with each other.

## The short version

The FRC community does not have a scouting problem. It has a **transport, schema, and archive** problem wrapped inside a scouting problem it is deliberately choosing not to solve.

`maneuver-core` — a year-agnostic scouting framework that is free, open source, actively maintained, and solves the exact problem a dozen teams re-solved in 2026 — has 2 stars, 4 forks, and 1 watcher. That is not a distribution failure. Mentors use app-building as curriculum; teams treat divergent data as competitive advantage. Any product pitched as *stop building your own* is asking customers to give up the thing they were buying.

So these three build the layers *beneath* the rebuild:

| | What | Why nobody has |
|---|---|---|
| **Courier** | App-agnostic offline transport (BLE + USB) for event day | Game Manual **E301** bans team-created 802.11 venue-wide. Bluetooth *is* legal — **R905** scopes only to the operator console — but Web Bluetooth has no peripheral role and no iOS Safari support, so every PWA hit a wall |
| **Season Pack** | Versioned machine-readable game/scoring schema, published at kickoff | A GitHub search returns `total_count: 0`. TBA hand-maintains 21 per-season files; Cheesy Arena ships current-game scoring 4–5 months late every year |
| **Ledger** | Free, current, account-free bulk data + offline venue packs + a picklist-ranking benchmark | TBA's bulk CSVs stop at 2019; the only current path needs a Google Cloud billing account |

Underneath all three: FIRST's API terms prohibit **"any commercial use (i.e. use that generates revenue)."** There is no business model, ever. Every design must degrade to *a file on disk*, not *a service that is up*.

## Code

A working prototype of the Courier layer. Zero build step — Node runs the TypeScript directly via type stripping. The scripts pass `--experimental-strip-types`, which Node 22.6+ needs and 23.6+ ignores; CI runs the suite on 22.x, 24.x and current LTS, so the supported range is verified rather than claimed.

```bash
npm install && npm test
```

```bash
node demo/event-day.ts
```

There's also a working CLI. Everything moves by file — no daemon, no port, no radio — because sneakernet is what teams actually fall back to:

```bash
node packages/courier-cli/src/main.ts init 2027mose pit-laptop
```

Pairing is two devices, three files, and one spoken six-digit code: `join-request` on the joining device, `grant` on a device already in the mesh, `accept` back on the joiner. If the two codes differ, someone substituted a QR and the ceremony stops. Then `ingest` seals QR payloads, `export` / `import` move a bundle on a flash drive, and `report` shows coverage with `●●` marking observations that got a second opinion.

The demo walks the flagship journey end to end: eight scouts capture 80 qualification matches through a scouting app that knows nothing about Courier, the Bridge ingests its QR output, the records gossip across the stands with no venue network until a single phone finally walks to the pit — seven of the eight never meet the laptop at all — and a rival's forged records bounce off. Everything but the radio is the real code path: real Ed25519 signatures, real canonical CBOR, real range-digest reconciliation over encoded wire messages.

| Package | What it is |
|---|---|
| `packages/courier-core` | The wire format and anti-entropy protocol: deterministic CBOR, COSE_Sign1 envelopes, the record store, range digests, reconciliation |
| `packages/courier-bridge` | QR ingest for scouting apps that adopt nothing — profile-driven field extraction that reads four routing fields and carries the rest through untouched |
| `packages/courier-transport` | The platform seam: links, an async session driver, and sneakernet bundles for the USB path |
| `packages/courier-ble` | Everything above the radio: GATT framing, reassembly, and iOS-style backpressure |
| `packages/courier-capacitor` | The plugin boundary — the exact nine methods native BLE code must implement |
| `packages/courier-pairing` | The two-QR pairing ceremony and the device key registry — who a store accepts records from |
| `packages/courier-cli` | `courier` — pair devices, ingest scans, move data by file |
| `packages/season-pack` | The season's official scoring model as versioned data, plus a generic scoring engine and reconciliation validator |
| `packages/ledger` | `ledger` — pull an event from both official sources, reconcile them, and write bulk exports and signed venue packs |
| `spec/` | The normative wire format: [`courier-record.cddl`](spec/courier-record.cddl) and [`canonical-cbor.md`](spec/canonical-cbor.md). Where prose in DESIGN.md disagrees with these, these win |
| `docs/MEASUREMENTS.md` | Generated by `npm run measure`. Real numbers, plus an explicit list of what could not be measured without radio hardware |

**Status: 250 tests passing, ~7,700 lines of source (plus 4,200 lines of tests).**

*Implemented* — the record format and canonical codec; envelope sealing and verification; the record store; range-digest set reconciliation with chunked transfer; QR ingest with profile detection; the pairing ceremony and key registry; the Season Pack format, versioning rules, scoring engine and validator; sneakernet bundles; a rate-limited, conditional-request HTTP client for the three upstream data sources; and signed venue packs with explicit staleness.

*Not implemented* — the native BLE shim (advertise/scan, MTU report, packet in/out — everything above it is built and tested against a simulated radio),.

### Language subset

There is no build step: Node runs the TypeScript directly via type stripping. That forbids any syntax that would emit code — **no parameter properties, no `enum`, no `namespace`, no decorators**. It is a real constraint and worth the trade, because a student can clone this and run the tests without a toolchain.

Three properties worth knowing, because they are the ones easiest to get wrong:

- **Deduplication is by `record-id`, never body hash.** Two scouts watching the same robot in a quiet match produce byte-identical bodies; body-hash dedup drops one and silently destroys the double-scouting that scout-reliability estimation needs. `record-id` includes the scout pseudonym, so both survive. A test constructs exactly this case.
- **The signature covers the whole record, not the body.** Signing only body bytes would leave event key, match, team, scout and schema forgeable. A test flips every single byte of a sealed envelope and asserts all 225 mutations are rejected.
- **Scout pseudonyms are minted at seal time**, `BLAKE3(scoutId ‖ eventKey ‖ meshKey)`, so the `scout` *field* is unlinkable across events. Rewriting identifiers at egress — as the draft proposed — is impossible, since the field sits inside the signature.

  **But on the Bridge path the raw identifier is still in the body.** A profile has to read the scout id to mint the pseudonym, and the body is the payload verbatim, so a name written by the source app ships inside every sealed record. The pseudonym is not a privacy control there — the cleartext is forty bytes away in the same record. Every profile declares `scoutIdInBody`, a test asserts the true state of affairs, and the demo prints the warning rather than the reassurance. Use a handle, or use the plugin path where the app chooses the body.

Two things the code deliberately refuses to do. Courier **never parses a body** — a test asserts the sealed body is the original QR payload byte for byte, because the moment the transport understands the payload it is asking teams to agree on a schema, which is the fight every previous attempt lost. And Season Pack **describes official scoring only** — it never decodes a scouting body. Those are the same boundary from two sides.

## Files

| File | Contents |
|---|---|
| [DESIGN.md](DESIGN.md) | The full design document — normative decisions §0, then product, data, backend, frontend, security/ops/governance |
| [docs/RESEARCH-FINDINGS.md](docs/RESEARCH-FINDINGS.md) | All 73 corroborated gaps, with citations and a "why nobody built it" for each |
| [docs/CRITIQUE.md](docs/CRITIQUE.md) | The adversarial review: 39 defects, 5 required additions, the verdict |
| [docs/STRATEGY.md](docs/STRATEGY.md) | Product selection: impact/feasibility scoring, the rejected set, the constraints in raw form |
| [docs/CONSTRAINTS.md](docs/CONSTRAINTS.md) | The 22 constraints any FRC tool must respect — **useful on its own** |
| [docs/NOT-BUILDING.md](docs/NOT-BUILDING.md) | 21 deliberately rejected ideas and the evidence |
| [docs/MEASUREMENTS.md](docs/MEASUREMENTS.md) | Measured wire sizes, reconciliation cost, and crypto throughput — plus what is still unmeasured |

## Status

**Draft for review. Not an approved plan, and not implementable as written.** The review's verdict — adopted in §0 — is that the thesis is right and the build plan is roughly 4× what a volunteer team can carry. §0 applies the recommended cut, but the phase tables and success metrics in §1.7, §1.8 and §5.11 predate that verdict and have not been rebuilt. Don't read them as commitments.

Rule citations are to the 2026 FRC Game Manual and were verified against the published text. Event Data referenced from The Blue Alliance and the FIRST FRC Events API — Event Data provided by FIRST.
