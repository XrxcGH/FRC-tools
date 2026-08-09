# Cross-Cutting Constraints for FRC Software

*Twenty-two constraints that any FIRST Robotics Competition tool must respect. Each was corroborated against a primary source during the research pass. Naive designs violate items 1, 5, and 14 most often.*

This file is intended to be useful on its own, independent of the products designed in [DESIGN.md](../DESIGN.md). If you are about to start an FRC software project, read it first.

---

### C-1

FRC Game Manual E301 bans team-created 802.11 venue-wide, not just near the field: 'Teams may not set up their own 802.11a/b/g/n/ac/ax/be wireless communication (e.g. access points or ad-hoc networks) in the venue', with a blue box clarifying that a hotspot from a cellular device, camera or smart TV counts as an access point. This forecloses the entire class of 'just run a local WiFi and sync over it' designs, including WebRTC/LocalSend/PairDrop over a team AP, and is exactly why the only fully compliant hands-off answer (Viper) is wired ethernet on battery at a documented ~$930 BOM.

### C-2

Bluetooth is legal in FRC and this is widely misunderstood. The manual's Bluetooth prohibition is R905, which governs only the OPERATOR CONSOLE — the drive team's control station — not scouts in the stands. The real blocker is platform, not rules: Web Bluetooth has no peripheral/GATT-server role and is not implemented in iOS Safari at all, so a PWA cannot do it. A Capacitor wrapper or native build is legally viable and is the unclaimed path. USB/OTG transfer and Bluetooth tethering are also legal.

### C-3

There are almost never power outlets in the stands, so any in-venue device must run on batteries for a full competition day.

### C-4

Offline-first is mandatory, and cloud fallback is not a safety net — venue uplinks saturate during competition. Statbotics returned 'team not found' to multiple independent users during Championship week 2026, and convention-center pit WiFi coverage is a venue contract issue no software fixes. The 6 GHz field radios make the pit RF environment worse.

### C-5

FIRST Events API terms prohibit revenue outright: users shall not 'make any commercial use (i.e. use that generates revenue) of the APIs, API Documentation or Events Data.' This single clause forecloses any revenue-supported tool built on official FRC data and is the root cause of the entire ecosystem's volunteer-maintainer fragility.

### C-6

FIRST Events API attribution is mandatory when sharing data beyond your own team: display 'Event Data provided by FIRST' or 'Event Data available free from FIRST' linked to the API portal, with placement varying by medium.

### C-7

FIRST reserves an unconditional kill switch: 'FIRST may, at any time, terminate and discontinue allowing any use of the APIs, API Documentation, and/or Events Data, for any or all Users.' Violations auto-terminate access. Never make FIRST the single upstream.

### C-8

FRC Events API auth is username + token, obtained by registering with a valid email through an automated system; it is free and open to anyone. No rate limits are published anywhere, yet the Terms prohibit exceeding 'rate limits as defined in the API Documentation' — a clause referencing a number that does not exist. Design for unannounced throttling.

### C-9

TBA publishes no rate limits, no SLA, and no status page. The documented primitives are ETag/If-None-Match and Cache-Control max-age; FIRST documents Last-Modified/If-Modified-Since. Honor these aggressively — polite caching is the only contract available.

### C-10

Statbotics' upstream contract is narrowing, not widening: the maintainer has announced he will delete the TeamMatch object (over two-thirds of database rows), remove offseason events, delete the Python API, and add authentication to rate-limit misconfigured users. Its OpenAPI spec has no security block and its entire operational guidance is the string 'be nice to our servers.' Cache locally and degrade gracefully.

### C-11

The January schema reset is absolute: the game is embargoed until kickoff and FMS Score Details are finalized during Week 0/Week 1, historically with ~24 hours between knowing the breakdown shape and matches being played. No schema can be prepared in advance. Worse, Team Updates mutate scoring mid-season — TU19 in 2026 moved fuel RP thresholds and broke Statbotics' simulator into Championship — so the data model needs in-season versioning, not just an annual drop.

### C-12

Per-robot attribution does not exist in any official API. FMS publishes alliance-level scoring only ('who scored coral and algae is not in the API, just the alliance did it'), and the few per-robot fields (leave, climb, park) are keyed to driver stations and are documented as sometimes outright wrong. Any validation or rating design must treat the official record as a partial and occasionally incorrect oracle.

### C-13

Minors' data is the hardest legal constraint and it is a patchwork, not one rule: COPPA for under-13s, state student-privacy regimes (Quick Attendance barred all California teams outright because 'none of us currently have a solid understanding of California's specific regulations' such as CCPA and CPRA), FERPA exposure for school-club records, GDPR for the international teams, plus FIRST YPP screening with its own state variants (California Live Scan and Mandated Reporter training, Pennsylvania Child Protection Clearances). FIRST states that PII collected by Nexus 'is not covered by the FIRST Privacy Policy' — third parties carry their own liability. One team keeps its attendance app closed-source purely 'because of the possibility of student data being in the git history.' The safe design is to hold no minor PII at all.

### C-14

Cross-team data sharing among minors must route through YPP-compliant channels, which is why scouting alliances fall back to adult-supervised Drive folders and group DMs rather than peer-to-peer designs.

### C-15

Near-zero budget: ~3500 volunteer-run high-school teams with no software line item, spending on parts and registration. TBA runs the archive of record on roughly $5,000/year and four unpaid trustees. Per-seat pricing on a 40-60 person club is a non-starter; free tiers are the entire market.

### C-16

Annual handoff to new students is structural, not incidental. Every credential — domain registrar, cloud billing, app store account — belongs to someone who graduates within four years, and most teams are school clubs with no legal entity to hold assets. Peregrine ('The future of FRC scouting') is dead with its hosted instance failing to resolve. Design for succession explicitly: open license, no personal-account dependencies, static artifacts where possible, documented continuity.

### C-17

School and district networks actively block the distribution channel: one mentor cannot run a tunnel from the shop, another reports their school blocks GitHub, and two independent users reported school/work networks blocking a newly registered tool domain on its launch day.

### C-18

The 2027 SystemCore transition is a hard platform break — the new cross-platform Driver Station 'is not compatible with either the existing FRC or FTC control systems' and 'Only Systemcore is supported.' Anything built against roboRIO-era internals has about one season of useful life.

### C-19

Copyright limits what can be redistributed: the Game Manual is FIRST-owned and revised weekly by Team Updates, and match video is owned by FIRST and regional organizers — the community's belief is that FIRST disabled VODs over DMCA exposure. Derive semantics; do not republish manual text or mirror video.

### C-20

Colorblind accessibility is unowned and recurring — at least seven independent surfacings across 2023-2026 spanning the Driver Station, SystemCore indicator lights, the field itself, TBA's Android rewrite and inspection, never once resolved. Red-vs-blue alliance identity is baked into the manual, field hardware, bumper rules and FMS, so software cannot replace the primary encoding but must never rely on it alone. AdvantageScope's docs contain no accessibility section at all. Ship a redundant encoding (shape, pattern, label) by default.

### C-21

Data sovereignty is a real adoption blocker independent of format: teams state plainly that 'storing things like qualitative notes and picklists on another team's platform would give me a little pause', and that they would not merge foreign data even if schemas matched because they cannot assess its accuracy. Provenance and local-first storage are product requirements, not nice-to-haves.

### C-22

Teams have a positive incentive to diverge, so consolidation strategies lose. Mentors use app-building to teach software delivery, and teams treat differing data as competitive advantage. Any tool whose value proposition is 'stop building your own' is fighting the customer's actual goal — build layers that are beneath or beside the rebuild, never a replacement for it.


