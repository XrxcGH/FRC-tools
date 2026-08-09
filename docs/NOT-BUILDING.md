# What We Are Deliberately Not Building

*The research surfaced far more gaps than are worth building. This file records the ones deliberately rejected, with the evidence for each rejection. A design document that only lists what it builds is hiding half its reasoning.*

Rejections fall into recurring classes: **healthy incumbent** (do not rebuild a maintained tool), **misdiagnosed** (a physical or policy problem dressed as a software problem), **legally foreclosed** (minors' PII with no revenue and no counsel), **platform-doomed** (roboRIO-era work with one season of life before SystemCore), and **attempt-and-stall** (many prior builds, zero adoption between them).

---

- AdvantageScope — explicitly out of scope. ~13,000 users, bundled with WPILib since 2024, maintainers push near-daily and reply in-thread within a day; the 2026 release rewrote log download onto FTP for a measured 2-4x speedup. Healthy tool, do not rebuild.

- PathPlanner / Choreo — healthy and consolidated; named by the community as the example of a layer that successfully converged. Do not rebuild.

- The Blue Alliance — genuinely healthy: 449 stars, multi-maintainer, commits through 2026-08-05, apidocs responding in 0.12s. The right contribution is upstream PRs (delete three stale sentences pointing at the dead 2019 archive), not a competitor.

- A new scouting app — the rebuild is a deliberately-purchased pedagogical good, not a market failure. @Mike_FRC_56: a scouting app is 'a pretty decent fit' for teaching students software delivery. maneuver-core is the proof: well-designed, free, actively maintained (pushed 2026-07-12), and verified today at 2 stars, 4 forks, 1 watcher. The better product loses on purpose. Build the layers beneath instead.

- Attendance / build-hours tracking — Quick Attendance EOL'd its public platform after 31 days citing 'Zero active external users'; AdvantageTrack is free, open-source, maintained, and sits at 13 stars; 15+ one-team repos all at 0-2 stars. Minors' PII with no revenue and no counsel. Hard pass.

- Physical inventory management — the community's own accepted thread solution was a Dymo labelmaker and Harbor Freight organizers; @Patrick3357 calls exact stock tracking 'almost certainly a losing battle'. Nine builds, zero adoption between them. A physical-organization problem misdiagnosed as a database problem.

- All-in-one team management platform — Lookout has been waitlist-gated for 31 months with none of its five day-one 'coming soon' modules shipped, and at least five parallel GitHub attempts sit at 0-1 stars, three pushed in the last ten weeks. The attempt-and-stall cycle is running right now, four times over.

- Sponsor/donor CRM — the canonical thread was locked in 2019; free generic tiers (Zoho, Trello, Sheets) sit under the bar; a 10-40 sponsor pipeline is squarely what a spreadsheet handles well; and mentors will not hand corporate contacts to a student-built SaaS.

- Youth-protection-compliant team chat — already killed with evidence. TeamSnap ships structurally two-adult DMs, Basecamp ships admin-reviewable DMs, Mattermost can disable DMs outright and 271 runs it in production. Students reject all of them on UX and route to Discord. Out-competing Discord on UX with no budget, then clearing thousands of district IT approvals, is not a software gap.

- CSA dispatch / request-help system — Nexus already documents team-facing technical support requests via QR scan into a configured Slack channel. A thin system exists and is under-adopted; that is a distribution problem, not a missing product.

- Pit map editor or scraper — dead on arrival. The Nexus API documents GET /event/{eventKey}/map returning full machine-readable geometry (size, pits, areas, labels, arrows, walls) behind only a standard API key.

- Robot-code profiler, SysId replacement, beginner tuning dashboard, CAN frame analyzer, C++ log replay — all roboRIO-era. Verified today: the 2027 Driver Station 'is not compatible with either the existing FRC or FTC control systems' and 'Only Systemcore is supported.' Anything built now gets roughly one season of life. Most are also WPILib merge-throughput problems (PR #7099 has implemented hierarchical timing since Sept 2024, unmerged), which an outsider cannot fix by writing more code.

- Zebra MotionWorks replacement — a corporate sponsor withdrawing donated UWB hardware and staff time, with RF interference against the new radios as a stated blocker. No software can replicate UWB ground truth. Treat as closed.

- AI / computer-vision video scouting — six independent 2026 attempts all failed at robot re-identification, and the binding constraint is that FIRST's broadcast is produced for spectators with per-venue camera, zoom, lighting and overlay variation. The remedy is a policy ask to FIRST, not code. 1678's objection is decisive: if a human marks which robot is shooting, the system saves none of the labor it exists to save.

- TBA client library rewrites — tbapy is healthy at 52 stars and Python users are fine; every other language sits at 0-3 stars, meaning a handful of students each. The correct fix is archiving the dead generated repos with a pointer, which is an afternoon of housekeeping, not a product.

- A rival event queuing / pit platform competing with Nexus — building a second closed platform handling minors' PII at 200+ events would strictly worsen the ecosystem's concentration problem. The right intervention is governance (escrow, documented continuity, an open interchange format), not competition.

- Impact / Engineering Inspiration award documentation generator — opened in January and abandoned in March, chasing an annually revised FIRST-owned template with no API, producing a persuasion artifact that teams who care will hand-build anyway. Worst possible retention profile.

- Roster / FIRST compliance status tracker — legally impossible by construction. The data is background-check and training status attached to named minors; FIRST exposes only match, team, award and district-ranking data. The realistic fixes are all FIRST-side UI changes.

- Awards submission receipt/verification layer — a single documented incident with zero corroborating replies, and unbuildable since no API exposes submission state. The fix is a confirmation email only FIRST can send.

- Build-season project management and shop-skills certification tracking — both inferred from thin threads (6 and 7 posts) where nobody asked for software, and both bottlenecked on mentor supervision hours rather than record-keeping. Notion and Google Classroom already sit under the bar.

- Scouting-data interchange as a semantic standard — deliberately not building The Purple Standard again. Its API base 404s, its own originator's homepage doesn't mention it, and no third-party implementer is named anywhere. Courier moves opaque blobs precisely so no semantic agreement is ever required.


