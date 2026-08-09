# Conformance vectors

[`canonical-cbor.md`](../canonical-cbor.md) says that two independent implementations following the spec **must produce byte-identical encodings**, and that if they don't, one of them is wrong. These files are how you find out which.

They are **committed, not generated at test time.** `npm test` compares the implementation against what is checked in here. A change that alters the wire format fails loudly instead of quietly moving the vectors along with it.

Regenerating is therefore a deliberate act:

```bash
node spec/generate-vectors.ts
```

If that produces a diff, exactly one of two things is true. Either the change was unintended and you have just broken compatibility with every other implementation, or it was intended — in which case the format version has to move and the other implementations need telling. There is no third case where you re-run the generator to make the test green.

## What each file pins

| File | Pins |
|---|---|
| `cbor.json` | Deterministic CBOR: shortest-form integers, map keys sorted by *encoded* bytes, NFC text. Map cases are given deliberately out of order, because input order must not matter. |
| `match-packing.json` | `(level << 24) \| (set << 12) \| number`, and that every FRC match key round-trips back to its original string. |
| `scout-pseudonym.json` | `BLAKE3(len‖scoutId ‖ len‖eventKey ‖ len‖meshKey)[0..8]`, including the length-prefixing that stops `("ab","c")` colliding with `("a","bc")`. |
| `record.json` | Canonical record encoding and `record-id`. Includes a **twin**: a different scout with a byte-identical body, whose `bodyHash` matches and whose `recordId` does not. |
| `envelope.json` | COSE_Sign1 over the whole record. Ed25519 is deterministic, so the signature itself is pinned. |
| `sync-message.json` | Anti-entropy message encoding, including that a bare `{more: false}` is distinguishable from an empty message. |
| `ble-framing.json` | Packet header layout and chunking at three MTUs, including the unnegotiated 23-byte floor. |

## The two that will catch you out

**The twin record.** `record.json` contains two records with byte-identical bodies from different scouts. If your implementation deduplicates on body hash, one of them disappears — and with it the deliberate double-scouting that scout-reliability estimation depends on. The system would destroy its own measurement signal and report success. Deduplicate on `record-id`, which includes the scout pseudonym.

**The envelope signature.** It covers the *whole canonical record* via the RFC 9052 `Sig_structure`, not just the body bytes. An implementation that signs only the body will produce a different value here — and will leave event key, match, team, scout and schema forgeable while still verifying.

## Writing a new implementation

Work in this order. Each stage depends only on the ones before it:

1. **`cbor.json`** — until this passes nothing else can, because every identifier in the system is a hash of canonical CBOR.
2. **`match-packing.json`** — pure arithmetic, no crypto.
3. **`scout-pseudonym.json`** — confirms your BLAKE3 and your length-prefixing.
4. **`record.json`** — confirms field numbering and canonical ordering.
5. **`envelope.json`** — confirms COSE structure and Ed25519. If the record vectors pass and this doesn't, the problem is in your `Sig_structure`.
6. **`sync-message.json`** and **`ble-framing.json`** — only needed if you implement sync or the radio.

## The key material is fake

The secret key in `envelope.json` is `000102…1f` — the bytes 0 through 31 in order. It exists so signatures are reproducible. It is not a secret, it protects nothing, and a test asserts it stays obviously fake so nobody can mistake it for a real one.
