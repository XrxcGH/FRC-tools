# Canonical CBOR profile, match packing, and record identity

Companion to [`courier-record.cddl`](courier-record.cddl). Together these two files are the normative wire format (DESIGN.md §0, D-1).

Two independent implementations that follow this document MUST produce byte-identical encodings for the same record, and therefore the same `record-id`. If they don't, one of them is wrong — this is the whole point of pinning it.

## 1. Deterministic encoding

RFC 8949 §4.2.1 core deterministic encoding, with no extensions:

1. **Shortest-form integers.** Argument encoded in the fewest bytes: values 0–23 in the additional-information field, then `uint8`, `uint16`, `uint32`, `uint64`. An encoder that always emits `uint64` is non-conformant.
2. **Definite lengths only.** No indefinite-length strings, arrays, or maps.
3. **Map keys sorted bytewise-lexicographically by their encoded form.** Not by numeric value, not by insertion order. For the small unsigned integer keys used here the two orderings coincide, but the rule is stated in its general form because `ProtectedHeader` mixes label `1` with label `4`, and a v2 record may introduce negative labels where they diverge.
4. **No duplicate keys.** A decoder MUST reject a map containing the same key twice rather than taking last-wins.
5. **No tags** except the COSE_Sign1 tag `#6.18` on the envelope itself.
6. **No floats, no `undefined`.** The record schema has no float-typed field, and a float would immediately raise the question of NaN canonicalisation. `null` is permitted only where the CDDL admits it (`supersedes`).
7. **Text strings are UTF-8, NFC-normalised, and MUST NOT contain unpaired surrogates.** Event keys and schema ids are ASCII in practice; the rule exists so a non-ASCII `schema-id` cannot produce two encodings of "the same" string.

### Decoder strictness

The decoder MUST reject, rather than accept-and-renormalise, any input violating 1–7. A permissive decoder paired with a canonical encoder creates a class of bug where a record verifies on one device and fails on another. Reject early, reject loudly.

## 2. Match packing

FRC match keys are TBA-style strings (`2027mose_qm42`, `2027mose_sf1m2`, `2027mose_f1m1`). Storing them as text in every record costs 12–16 bytes and invites format drift; field 3 packs them into a single unsigned integer.

```
match-packed = (level << 24) | (set << 12) | number
```

| Level | Code | Meaning |
|---:|---|---|
| 1 | `qm` | Qualification |
| 2 | `ef` | Eighth-final |
| 3 | `qf` | Quarter-final |
| 4 | `sf` | Semi-final |
| 5 | `f`  | Final |

`set` is 0 for qualification matches (which have no set) and 1-based otherwise. `number` is 1-based. Both are bounded at 4095 by the shift widths, which is far above any real event.

The packing is total and reversible for every match key FRC has ever produced. Round-tripping is a conformance test, not an implementation detail: `unpackMatch(packMatch(k)) === k` for all `k`.

## 3. Record identity

```
record-id = BLAKE3-256(canonical-cbor(CourierRecord))
```

32 bytes. This is the **only** deduplication key in the system (D-2).

### Why not the body hash

Because two scouts watching the same robot in a quiet match produce byte-identical bodies. Deduplicating on body hash drops one of them — and the deliberate 10% double-scouting those duplicates represent is the cheapest source of identifiability for scout bias and precision estimation. The system would silently destroy its own measurement signal and report success. `body-hash` (field 9) exists for integrity only: it lets a receiver detect a truncated or corrupted body without parsing it.

There is one legitimate use of `body-hash` as a *suppression* key, and it lives strictly at the Bridge's QR-ingest layer: two Bridge devices scanning the same physical QR code should not both admit it. That is duplicate-*scan* suppression against a cleartext body, at ingest, before sealing — a different layer from record-level dedup, and it must not be confused with it.

### Records are append-only

A correction does not overwrite. It is a new record with `revision` incremented and `supersedes` set to the `record-id` it replaces. Both remain in the log; the view layer resolves which is current. An implementation that does `put()` over an existing row by primary key is destroying the audit chain the design claims to keep.

## 4. Ordering

`revision` orders edits from one scout for one `(event, match, team)`. Where two records tie on `revision` — genuinely concurrent corrections from different devices — the tiebreak is bytewise-lexicographic comparison of `record-id`.

This is deterministic, requires no clock, and costs nothing: it is the reason v1 carries no hybrid logical clock (D-24). `sealed-at` is retained for human display and staleness UI, and is explicitly **not** trusted for ordering, because a device with a wrong clock is a routine field condition rather than an exceptional one.

## 5. Size

Measured, not estimated — `envelopeSize()` derives these exactly and a test asserts it matches a real sealed envelope byte for byte.

| Part | Bytes |
|---|---:|
| Record fields 1–11 (keys + values, including two 32-byte hashes) | 101 |
| Body + its CBOR head | 42–123 |
| COSE structure + protected header | 21 |
| Ed25519 signature | 64 |
| **Envelope total, 40–120 byte body** | **228–309** |

The two 32-byte hash fields (`body-hash`, and `supersedes` when set) dominate the fixed cost. Truncating `body-hash` to 16 bytes would save 16 bytes per record at the cost of halving its collision resistance; it has not been done, because at this traffic volume the saving is not worth reasoning about a weakened integrity check.

At 8 scouts × 80 qualification matches, a full event day is roughly 640 records ≈ **165 kB** of envelope traffic. That is small enough that bandwidth is not the binding constraint on any transport under consideration — which is why L2CAP was cut from v1 (D-13). The binding constraints are connection setup time and radio duty cycle, not throughput.
