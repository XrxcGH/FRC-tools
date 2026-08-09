# Succession

*The graduation cliff is the single biggest killer of FRC software. This file is the plan for surviving it. If it is out of date, that is itself the warning sign.*

The research is full of corpses: Peregrine, "the future of FRC scouting", whose hosted instance no longer resolves. A scouting stack maintained by one person that stopped in 2022. Team tools running on a student's home PC behind a tunnel their school blocks. None of them died of a bad idea. They died because the person holding the credentials graduated.

So this project is built to be *inherited*, and inheritance has to be practised rather than intended.

---

## 1. What must be true at all times

These are not aspirations. If any is false, fix it before writing more code.

| Invariant | Why | How to check |
|---|---|---|
| No credential lives only in one person's personal account | The account leaves with the person | §2 inventory, reviewed each June |
| The repo builds and tests with `npm ci && npm test` and nothing else | A toolchain a newcomer cannot install is a dead project | CI runs exactly this |
| Every artifact anyone depends on is a static file | A running service needs an owner and a card on file; a file needs neither | `ledger` writes files; venue packs and bundles are files |
| The wire format is pinned by committed vectors | A second implementation is how a project outlives its first | [`spec/vectors/`](../spec/vectors/README.md) |
| No personal data is held anywhere | Minors' data creates obligations an unpaid volunteer cannot discharge | The store holds pseudonyms; labels name devices |

The last one is also a succession property, not only a privacy one: a project holding student data cannot simply be handed to a stranger, and "cannot be handed on" is how software dies.

---

## 2. Credential inventory

Every credential class, and the specific mechanism that survives a handover. The point of the table is that there is no row whose answer is "ask Eric".

| Credential | Risk if lost | Succession mechanism |
|---|---|---|
| GitHub repository | Total | Owned by an **organisation**, not a user. At least three owners, at least one an adult mentor who is not graduating. |
| Release signing keys (Season Pack) | Cannot ship a pack; consumers reject releases | **1-of-2 for MINOR/PATCH, 2-of-2 for MAJOR** (D-18). Two stewards means one can be unavailable. Both keys are re-issued each June, and the old ones are revoked *after* the new ones have signed something. |
| Venue-pack signing key | Packs stop verifying | Per-team and disposable. A team regenerates it and re-pairs; nothing upstream depends on it. |
| CDN / object storage | Bulk data goes offline | A static bucket paid by an entity, never a person. If nobody can pay, the artifacts still work from a GitHub release — that is the reason the format is plain files. |
| TBA API key | Ingestion stops | Free and self-serve. Any maintainer can mint a new one in a minute; nothing is bound to a specific key. |
| FIRST Events API credentials | Ingestion stops | Free and self-serve, same as above. |
| Apple Developer account | Cannot ship or update iOS | Held by an **eligible legal entity** — a school district or nonprofit — under Apple's fee waiver for accredited educational institutions distributing free apps. Never a student's personal Apple ID. |
| Google Play account | Cannot ship or update Android | Same: an organisation account. |
| Domain name | Links rot | Registered to the entity, auto-renew on, with a second contact who is a mentor. |

**Nothing in this system requires a credential to keep working.** A team that already has a bundle, a venue pack, or a Season Pack keeps using it forever if every account above vanishes tomorrow. That is deliberate, and it is the actual insurance policy — the table above only governs whether *new* things can be published.

---

## 3. The June handover

Do this in June, when nothing is on fire. Not in January.

1. **Inventory review.** Walk §2. For every row, name the humans who hold it today. Any row with one name is a finding.
2. **Rotate signing keys.** New stewards generate keys, sign a no-op PATCH release, and only then are the old keys revoked. Rotating *before* verifying the new keys work is how a team discovers in January that nobody can sign.
3. **Practise a rebuild from zero.** A person who has never done it clones the repo on a fresh machine and runs `npm ci && npm test`, then `npm run demo`. If they need help, the gap is a documentation bug and gets filed.
4. **Practise a restore.** Take a bundle and a venue pack from last season and open them with current code. If they no longer verify, a format change slipped in without a version bump.
5. **Write down who is leaving.** Not to be sentimental — to make the bus factor visible before it is tested.

---

## 4. January

This is where the project dies if it dies. The design is explicit that the Season Pack sprint is *terminal on one miss*, and January is precisely when the people who could prevent that are least available: they are building a robot.

So the capacity is written down here, honestly, rather than discovered under load.

### What January actually owes

| Work | When | Realistic hours |
|---|---|---|
| Season Pack `1.0.0`, manual-derived | Kickoff + 72h | 10–16 |
| Season Pack `1.1.0`, bound to real FMS breakdowns | First breakdown + 48h | 6–10 |
| Team Update watcher, running all season | Continuous, 24h SLA per update | 1–2 per update, ~8 updates |
| `bridge_profiles.json` for apps whose columns changed | Weeks 1–2 | 2–4 per app |
| Reconciliation validator fixes as real data arrives | Weeks 1–3 | 4–8 |

**Roughly 45–70 hours, concentrated into three weeks, for people who are also building a robot.** That is one person working most evenings, or three people working some.

### If the hours are not there

Drop work in this order. The order is chosen so that each thing dropped costs the least and is the easiest to add back late:

1. **Reconciliation validator updates.** Consumers get less checking, not wrong data.
2. **Bridge profiles for third-party apps.** Those teams keep using QR as they did before; nothing regresses.
3. **`1.1.0` FMS binding.** `1.0.0` still describes the scoring model; only the automated cross-check waits.
4. **Never drop `1.0.0`.** Every downstream consumer falls back to hand-rolling if it misses, and the research is unambiguous that they do not come back.

If even `1.0.0` cannot be staffed, say so publicly at kickoff rather than in week 3. A tool that announces it is skipping a season is recoverable. One that goes quiet is not.

---

## 5. Kill criteria

Stated in advance, because deciding to stop is much harder in the moment and a zombie project consumes trust that the next attempt will need.

Stop, and say so publicly, if:

- **Season Pack `1.0.0` misses its window two years running.** Once is a bad January. Twice is a staffing answer.
- **Fewer than two people can sign a release** for a full season.
- **The June handover is skipped two years running.** The invariants in §1 will already be false; nobody will have noticed.
- **No team outside the founding one has used it for a full season** by the end of year two. The adopt-nothing Bridge exists precisely so adoption costs nothing; if it is still zero, the thesis was wrong and that is worth knowing.

"Stop" means: archive the repository with a README explaining what worked and what did not, publish the last artifacts, and leave the conformance vectors up. The vectors are the part most worth inheriting — they let someone else's implementation be *right* rather than merely new.

---

## 6. If you have just inherited this

Read, in order: [`README.md`](../README.md), then [`DESIGN.md`](../DESIGN.md) §0 — which is normative and overrides the prose sections where they disagree — then [`docs/CONSTRAINTS.md`](CONSTRAINTS.md).

Then run `npm ci && npm test && npm run demo`. If all three work, you have everything. If they do not, that is the highest-priority bug in the project, ahead of any feature.

Two things worth knowing before you change anything:

- **The wire format is pinned.** [`spec/vectors/`](../spec/vectors/README.md) holds committed byte-level vectors. If a change makes those tests fail, it is a compatibility break, and there is no version of "just regenerate them" that is not also a decision to break every other implementation.
- **Deduplication is by `record-id`, never body hash.** Two scouts watching the same robot produce byte-identical bodies. This looks like an obvious optimisation and it silently destroys the double-scouting the analytics depend on. There is a vector specifically to catch you.

You are allowed to delete things. Scope was cut once already, by an adversarial review, and the result was better. The failure mode of this project is not too little ambition.
