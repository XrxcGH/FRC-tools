/**
 * End-to-end walkthrough of the flagship user journey.
 *
 *   Eight scouts capture a full qualification day. Their existing scouting app
 *   knows nothing about Courier — it just emits QR codes, as it always has. The
 *   Bridge ingests those scans, seals them, and the data spreads across the
 *   stands with no venue network, reaching the picklist laptop when a single
 *   phone finally walks to the pit. Seven of the eight phones never meet the
 *   laptop at all.
 *
 *   node demo/event-day.ts
 *
 * Everything here runs the real code paths: real Ed25519 signatures, real
 * canonical CBOR, real range-digest reconciliation over encoded wire messages.
 * The only thing simulated is the radio.
 */

import {
  RecordStore,
  reconcile,
  storesConverged,
  generateDeviceKey,
  generateMeshKey,
  mintScoutPseudonym,
  makeRecord,
  sealRecord,
  matchLabel,
  toHex,
  type DeviceKeyPair,
  type KeyResolver,
} from '../packages/courier-core/src/index.ts';
import { ingestBatch, ScanSuppressor } from '../packages/courier-bridge/src/index.ts';
import {
  DecoderRegistry,
  describeGaps,
  teamEstimatesFrom,
  peerResiduals,
  residualScale,
} from '../packages/courier-decode/src/index.ts';
import {
  rankPicklist,
  formatPicklist,
  contingencies,
  seededRng,
  scoutEffects,
  adjustForPeers,
  scoutReliability,
  cusumUpdate,
  describeDrift,
  type CusumState,
} from '../packages/analytics/src/index.ts';
import { loadProfileSet } from '../packages/courier-bridge/src/profiles.ts';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const EVENT = '2027mose';
const SCOUTS = 8;
const QUALS = 80;
const TEAMS = [8793, 9143, 254, 1678, 118, 2056, 3128, 5940, 27, 1323, 604, 2910];
/** One scout stops watching partway through the day. Section 5 has to find them. */
const DROWSY_SCOUT = 5;
const DROWSY_FROM = 41;

/**
 * Claims this run makes, checked before it exits.
 *
 * A demo is the only thing here that exercises every layer against every other
 * one, which is where most of this project's real bugs turned up. One that
 * silently degrades -- a picklist that stops separating teams, a drift detector
 * that starts naming the wrong person -- is worse than no demo, because the
 * output still looks like a success. So it fails loudly instead.
 */
const claims: Array<{ what: string; held: boolean }> = [];
function claim(what: string, held: boolean): boolean {
  claims.push({ what, held });
  return held;
}

const bold = (s: string): string => `[1m${s}[0m`;
const dim = (s: string): string => `[2m${s}[0m`;
const ok = (s: string): string => `[32m${s}[0m`;
const warn = (s: string): string => `[33m${s}[0m`;

function rule(title: string): void {
  console.log(`\n${bold(title)}\n${dim('─'.repeat(72))}`);
}

/* ── the team's mesh ──────────────────────────────────────────────────────── */

const meshKey = generateMeshKey();
const devices = new Map<string, DeviceKeyPair>();
const name = (i: number): string => (i < SCOUTS ? `phone-${i}` : 'picklist-laptop');
for (let i = 0; i <= SCOUTS; i++) devices.set(name(i), generateDeviceKey('software'));

const resolver: KeyResolver = (kid) => {
  for (const d of devices.values()) if (toHex(d.kid) === toHex(kid)) return d.publicKey;
  return undefined;
};

const profiles = loadProfileSet(
  JSON.parse(
    readFileSync(
      fileURLToPath(new URL('../packages/courier-bridge/profiles/bridge_profiles.json', import.meta.url)),
      'utf8',
    ),
  ),
);

/* ── a day of scans from somebody else's app ──────────────────────────────── */

function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s ^= s << 13;
    s >>>= 0;
    s ^= s >> 17;
    s ^= s << 5;
    s >>>= 0;
    return s / 0x100000000;
  };
}

/** The six robots on the field in a given qualification match. */
function robotsInMatch(m: number): number[] {
  return Array.from({ length: 6 }, (_, i) => TEAMS[(m * 6 + i) % TEAMS.length]!);
}

/**
 * How good each robot actually is, and how consistent.
 *
 * Teams at an event are not interchangeable, and a demo where they are shows a
 * picklist of twelve identical rows -- which reads as "the tool cannot separate
 * anybody" rather than "these robots were the same." Spread ranges from 1 to 5
 * so floor and ceiling carry information the mean does not: 5940 below scores
 * less on average than 1678 but is far steadier, which is exactly the second-
 * pick tradeoff a captain is trying to see.
 */
function skillOf(team: number): { mean: number; spread: number } {
  const i = TEAMS.indexOf(team);
  return { mean: 26 - i * 2, spread: 1 + ((i * 7) % 5) };
}

/**
 * The foreign app's QR format: tab-separated, scout / match / team, then five
 * columns of whatever that team decided to record this season. Courier reads
 * the first three and never looks at the rest.
 *
 * Eight scouts cover six robots, so scouts 6 and 7 double up on robots 0 and 1.
 * That is a 25% double-scouting rate — heavier than the ~10% the design budgets
 * for, chosen here so the effect is visible in one run rather than realistic.
 * Two scouts watching the same robot mostly agree, which is exactly the case
 * where naive deduplication destroys data.
 */
function scansFor(scout: number, rand: () => number): string[] {
  const out: string[] = [];
  for (let m = 1; m <= QUALS; m++) {
    // Slots rotate with the match so the two doubling scouts are not always
    // paired with the same person. That matters: with a fixed pairing there is
    // no third opinion to break the symmetry, and the effects fit can only
    // split a disagreement between the pair (D-26). Rotating gives it
    // something to work with — which is also the advice the tool prints.
    const team = robotsInMatch(m)[(scout + (scout >= 6 ? m : 0)) % 6]!;

    // The ground truth for this robot in this match — both scouts see the same
    // robot do the same things.
    const truth = rng(m * 7919 + team);
    const skill = skillOf(team);
    const auto = Math.floor(truth() * 5);
    // Centred on the robot's own ability, wobbling by its own consistency.
    const teleop = Math.max(0, Math.round(skill.mean + (truth() - 0.5) * 2 * skill.spread));
    const climb = ['none', 'park', 'shallow', 'deep'][Math.floor(truth() * 4)]!;
    const defense = truth() > 0.75 ? 'heavy' : 'none';

    // ...but one of them occasionally miscounts.
    const miscount = rand() < 0.15;
    // And scout 5 stops paying attention halfway through the day, which is the
    // failure the drift detector exists for. A drowsy scout does not go silent;
    // they keep submitting, and the numbers quietly run low.
    const drowsy = scout === DROWSY_SCOUT && m >= DROWSY_FROM;
    const reported = Math.max(0, (miscount ? teleop + 1 : teleop) - (drowsy ? 6 : 0));
    out.push(
      [`scout-${scout}`, m, team, auto, reported, climb, defense, `note-${m}`].join('\t'),
    );
  }
  return out;
}

rule('1 · Eight scouts capture a qualification day');

const stores = new Map<string, RecordStore>();
for (let i = 0; i <= SCOUTS; i++) stores.set(name(i), new RecordStore());

let totalSealed = 0;
let totalBytes = 0;
const unverifiedUsed = new Set<string>();

for (let s = 0; s < SCOUTS; s++) {
  const device = devices.get(name(s))!;
  const scans = scansFor(s, rng(1000 + s));

  // A realistic wrinkle: the scout re-scans a few codes by accident.
  const withDupes = [...scans, scans[3]!, scans[17]!, scans[40]!];

  const summary = ingestBatch(
    withDupes,
    { profiles, eventKey: EVENT, meshKey, device, now: () => 1_800_000_000_000 + s },
    new ScanSuppressor(),
  );

  const store = stores.get(name(s))!;
  for (const env of summary.envelopes) store.admit(env, resolver);
  for (const p of summary.unverifiedProfilesUsed) unverifiedUsed.add(p);

  totalSealed += summary.sealed;
  totalBytes += store.stats().bytes;

  console.log(
    `  ${name(s).padEnd(16)} ${String(summary.sealed).padStart(3)} sealed  ` +
      `${dim(`${summary.duplicateScan} duplicate scans suppressed`)}`,
  );
}

console.log(
  `\n  ${bold(String(totalSealed))} records sealed across ${SCOUTS} phones, ` +
    `${(totalBytes / 1024).toFixed(1)} kB total.`,
);
console.log(
  dim(
    '  Duplicate SCANS were suppressed by body hash at ingest. Note that this is a different\n' +
      '  layer from record dedup — two scouts observing the same robot still both survive.',
  ),
);
if (unverifiedUsed.size > 0) {
  console.log(warn(`  ! used unverified profiles: ${[...unverifiedUsed].join(', ')}`));
}

/* ── gossip in the stands ─────────────────────────────────────────────────── */

rule('2 · Gossip in the stands — no venue WiFi, no laptop in range');

console.log(
  dim(
    '  E301 forbids creating a network in the venue, so there is no LAN and no hub.\n' +
      '  Phones sync opportunistically with whoever is next to them, in a line. The\n' +
      '  picklist laptop is in the pit and pairs with nobody until the very end.',
  ),
);

let roundTrips = 0;
let wireBytes = 0;

for (let pass = 1; pass <= 3; pass++) {
  for (let i = 0; i < SCOUTS - 1; i++) {
    const res = reconcile(stores.get(name(i))!, stores.get(name(i + 1))!, resolver);
    roundTrips += Math.ceil(res.rounds / 2);
    wireBytes += res.bytes;
  }
  for (let i = SCOUTS - 2; i >= 0; i--) {
    const res = reconcile(stores.get(name(i))!, stores.get(name(i + 1))!, resolver);
    roundTrips += Math.ceil(res.rounds / 2);
    wireBytes += res.bytes;
  }
  const sizes = Array.from({ length: SCOUTS }, (_, i) => stores.get(name(i))!.size);
  // Equal sizes are not equal sets. Check the sets.
  const first = stores.get(name(0))!;
  const converged = Array.from({ length: SCOUTS }, (_, i) =>
    storesConverged(first, stores.get(name(i))!),
  ).every(Boolean);
  console.log(
    `  pass ${pass}: store sizes ${sizes.join(', ')}  ${converged ? ok('converged') : dim('spreading…')}`,
  );
  if (converged) {
    claim('every phone converges on the same set', true);
    break;
  }
  if (pass === 3) claim('every phone converges on the same set', false);
}

/* ── the pit ──────────────────────────────────────────────────────────────── */

rule('3 · One phone walks to the pit');

const laptop = stores.get('picklist-laptop')!;
const carrier = stores.get(name(0))!;
const final = reconcile(carrier, laptop, resolver);
roundTrips += Math.ceil(final.rounds / 2);
wireBytes += final.bytes;

console.log(
  `  ${final.rounds} messages, ${Math.ceil(final.rounds / 2)} round trips, ` +
    `${(final.bytes / 1024).toFixed(1)} kB transferred.`,
);
console.log(
  `  laptop now holds ${bold(String(laptop.size))} records ` +
    `${storesConverged(carrier, laptop) ? ok('✓ converged') : warn('✗ diverged')}`,
);

/* ── what the picklist actually sees ──────────────────────────────────────── */

rule('4 · What the picklist sees');

const stats = laptop.stats();
console.log(`  records        ${stats.records}`);
console.log(`  observations   ${stats.observations}`);
console.log(`  distinct scouts ${stats.scouts}`);
console.log(`  bytes          ${(stats.bytes / 1024).toFixed(1)} kB`);

// Find an observation that more than one scout covered — the double-scouting
// that record-id dedup deliberately preserves.
let doubled: { match: number; team: number; n: number } | null = null;
for (const id of laptop.sortedIds) {
  const r = laptop.get(id)!.record;
  const n = laptop.currentForObservation(r.eventKey, r.match, r.team).length;
  if (n > 1) {
    doubled = { match: r.match, team: r.team, n };
    break;
  }
}

if (doubled) {
  console.log(
    `\n  ${ok('Double-scouted:')} ${matchLabel(doubled.match)} team ${doubled.team} ` +
      `covered by ${doubled.n} scouts.`,
  );
  console.log(
    `  ${stats.records - stats.observations} of ${stats.records} records are second opinions ` +
      `on an already-covered robot.`,
  );

  // Count how many double-scouted pairs actually collide on body bytes, rather
  // than asserting that they do.
  const bodyHashes = new Map<string, number>();
  for (const id of laptop.sortedIds) {
    const h = toHex(laptop.get(id)!.record.bodyHash);
    bodyHashes.set(h, (bodyHashes.get(h) ?? 0) + 1);
  }
  const collisions = [...bodyHashes.values()].filter((n) => n > 1).length;
  console.log(
    dim(
      `\n  Identical-body collisions in this run: ${collisions}. This particular app writes the\n` +
        `  scout's name into column 0, so two scouts never produce the same bytes — but plenty of\n` +
        `  scouting apps omit it, and then two scouts who simply agree produce identical payloads.`,
    ),
  );

  // Demonstrate the guarantee directly rather than claiming it.
  const twinBody = new TextEncoder().encode('27\t5940\t0\t8\tdeep');
  const twinStore = new RecordStore();
  for (const s of [0, 1]) {
    const rec = makeRecord({
      eventKey: EVENT,
      match: doubled.match,
      team: doubled.team,
      scout: mintScoutPseudonym(`scout-${s}`, EVENT, meshKey),
      schema: 'demo.identical.v1',
      body: twinBody, // the very same bytes
      sealedAt: 1_800_000_000_000,
    });
    twinStore.admit(sealRecord(rec, devices.get(name(s))!), resolver);
  }
  console.log(
    `  ${ok('Direct check:')} two scouts, one identical body → ` +
      `${bold(String(twinStore.size))} records survive ` +
      `${twinStore.size === 2 ? ok('✓') : warn('✗ one was lost')}`,
  );
  console.log(
    dim(
      '  Body-hash dedup would have kept 1 and silently destroyed the second opinion that\n' +
        '  scout-reliability estimation needs. record-id includes the scout pseudonym.',
    ),
  );
} else {
  console.log(dim('\n  (no double-scouted observation in this run)'));
}

// Show that the body came through untouched.
const sample = laptop.get(laptop.sortedIds[0]!)!;
console.log(`\n  ${bold('Sample record')} ${dim(toHex(sample.recordId).slice(0, 16) + '…')}`);
console.log(`    event   ${sample.record.eventKey}`);
console.log(`    match   ${matchLabel(sample.record.match)}`);
console.log(`    team    ${sample.record.team}`);
console.log(`    scout   ${toHex(sample.record.scout)} ${dim('(per-event pseudonym)')}`);
console.log(`    schema  ${sample.record.schema}`);
console.log(`    body    ${dim(JSON.stringify(new TextDecoder().decode(sample.record.body)))}`);
console.log(
  dim('    ↑ the original QR payload, byte for byte. Courier never parsed it.'),
);
console.log(
  warn(
    '\n  Read those two lines together. The scout FIELD is a pseudonym and is unlinkable across\n' +
      '  events — but the body is the payload verbatim, and this app writes the scout name into\n' +
      '  it, so the raw identifier ships inside every record. On the Bridge path the pseudonym is\n' +
      '  not a privacy control; the cleartext is forty bytes away in the same signed record.\n' +
      '  Every profile declares scoutIdInBody so the UI can say so instead of implying otherwise.',
  ),
);

/* -- the team reads back its own data ---------------------------------- */

rule('5 · The team reads back what it wrote');

// A decoder is the team's OWN description of their OWN body format, registered
// on their own device and applied here, at analysis time. It never travelled
// with a record, and Courier never parsed a body in transit.
const registry = DecoderRegistry.from([
  {
    schemaId: 'courier.generic.tsv.v1',
    format: 'delimited',
    delimiter: '\t',
    fields: [
      { name: 'auto', type: 'integer' as const, source: 3, min: 0, max: 200 },
      { name: 'teleop', type: 'integer' as const, source: 4, min: 0, max: 500 },
      {
        name: 'endgame',
        type: 'enum' as const,
        source: 5,
        values: ['none', 'park', 'shallow', 'deep'],
      },
      { name: 'defense', type: 'enum' as const, source: 6, values: ['none', 'heavy'] },
    ],
  },
]);

// D-25: the CURRENT view, not every record ever admitted. The log keeps
// corrections forever so peers can still reconcile against them; an average
// must not, or a slipped keystroke counts twice at two plausible values.
const current = laptop.currentRecords();
const decoded = registry.decodeAll(current);
console.log(`  current records  ${current.length} of ${laptop.size} in the log`);
console.log(`  decoded          ${decoded.records.length}`);
console.log(`  unreadable       ${decoded.unknownSchema + decoded.failed}`);
claim('every record decodes with the team\'s own schema', decoded.records.length === current.length);
const gaps = describeGaps(decoded, current.length);
if (gaps) console.log(warn('\n  ' + gaps.split('\n').join('\n  ')));

/* -- the picklist ------------------------------------------------------- */

rule('6 · A picklist, with no venue pack and no API key');

const { estimates, thin } = teamEstimatesFrom(decoded.records, 'teleop');
const ours = estimates.find((e) => e.team === 8793)!;
const board = estimates
  .filter((e) => e.team !== 8793)
  // `spread` is the robot's own match-to-match variation, carried separately
  // from `sigma`, which is only how unsure we are of its average. The floor
  // column needs the first; built from the second it claims an erratic robot
  // gets steadier the more you scout it.
  .map((e) => ({ team: e.team, mean: e.mean, sigma: e.sigma, spread: e.spread }));

const ranked = rankPicklist({
  candidates: board,
  alliance: [{ team: ours.team, mean: ours.mean, sigma: ours.sigma, spread: ours.spread }],
  picksBeforeYourNext: 5,
  haveSecondPick: true,
  rng: seededRng(1),
});

console.log(
  formatPicklist(ranked, 8)
    .split('\n')
    .map((l) => '  ' + l)
    .join('\n'),
);
if (thin.length > 0) {
  console.log(
    warn(
      `\n  ${thin.length} team(s) omitted for fewer than 3 observations: ` +
        thin.map((t) => `${t.team} (${t.observations})`).join(', '),
    ),
  );
}
// A board where every row is the same number demonstrates nothing, and would
// read as "the tool cannot separate teams" rather than "these teams were equal".
claim(
  'the picklist separates the board',
  ranked.length > 1 && ranked[0]!.expectedValue - ranked.at(-1)!.expectedValue > 1,
);
claim('the strongest robot the team did not already have tops the board', ranked[0]!.team === 9143);

console.log('\n  ' + bold('If the top of the list is gone when your turn comes:'));
for (const c of contingencies(ranked, 3)) {
  console.log(`    ${c.goneTeams.join(', ')} taken  ->  take ${c.take}`);
}
console.log(
  dim(
    '\n  No least squares here, and that is the point rather than a shortcut. OPR and its\n' +
      '  relatives exist because the OFFICIAL record is alliance-level and the parts have to be\n' +
      '  solved for. Scouting data is already per-robot, so the deconvolution is unnecessary --\n' +
      '  and a mean is far easier for a student to defend in a meeting.',
  ),
);

/* -- who stopped watching ----------------------------------------------- */

rule('7 · Finding the scout who stopped watching');

const res = peerResiduals(decoded.records, 'teleop');
console.log(
  `  ${res.doubleScouted} of ${res.observations} observations had a second opinion; ` +
    `${res.unpaired} did not`,
);

// D-27: raw peer residuals are exact negatives within a pair, so one drifting
// scout produces an equal and opposite "drift" in whoever sat beside them. Fit
// an effect per scout across ALL their pairings and remove the PEERS' effects
// before anybody is judged.
const comparisons = res.residuals.map((r) => ({
  scout: r.scout,
  peers: r.peerScouts,
  residual: r.residual,
}));
const effects = scoutEffects(comparisons);
const adjusted = adjustForPeers(comparisons, effects);
const scale = residualScale(res.residuals);

const quality = scoutReliability(
  res.residuals.map((r, i) => ({ scout: r.scout, residual: adjusted[i]! })),
);
console.log('\n  scout       paired    bias   spread');
for (const q of quality) {
  const sd = Math.sqrt(1 / q.precision);
  console.log(
    `  ${q.scout.slice(0, 8)}  ${String(q.observations).padStart(8)}  ` +
      `${q.bias >= 0 ? '+' : ''}${q.bias.toFixed(1).padStart(5)}  ${sd.toFixed(1).padStart(6)}`,
  );
}

const alarms = new Map<string, { at: number; message: string }>();
const states = new Map<string, CusumState | null>();
res.residuals.forEach((r, i) => {
  const next = cusumUpdate(states.get(r.scout) ?? null, adjusted[i]! / scale);
  states.set(r.scout, next);
  if (next.alarm && !alarms.has(r.scout)) {
    alarms.set(r.scout, { at: r.match, message: describeDrift(next, adjusted[i]!) });
  }
});

const drowsyId = toHex(mintScoutPseudonym(`scout-${DROWSY_SCOUT}`, EVENT, meshKey));
claim('the drowsy scout is flagged', alarms.has(drowsyId));
// Identity, not cardinality. `alarms.size <= 1` passes when the ONE person
// flagged is an innocent scout — the ledger line would print OK while
// reporting the opposite of the truth. The adjacent claim catches that case
// too, so the run still exits non-zero, but a claim that lies in the affirmative
// is exactly the kind of reassurance this ledger exists to not give.
claim('nobody else is flagged', [...alarms.keys()].every((s) => s === drowsyId));
console.log();
if (alarms.size === 0) {
  console.log(warn('  Nobody flagged -- the injected drift was too mild for these constants.'));
} else {
  for (const [scout, a] of alarms) {
    const right = scout === drowsyId;
    console.log(
      `  ${right ? ok('OK ') : warn('?? ')}${scout.slice(0, 8)} from ${matchLabel(a.at)} -- ${a.message}`,
    );
  }
  console.log(
    dim(
      `\n  scout-${DROWSY_SCOUT} is the one this run made drowsy, from Q${DROWSY_FROM}. ` +
        `Their pseudonym is ${drowsyId.slice(0, 8)}.`,
    ),
  );
}
console.log(
  warn(
    '\n  This measures DISAGREEMENT WITH OTHER SCOUTS, not accuracy. Two people watching the same\n' +
      '  wrong robot agree perfectly and both look reliable. A pair who ONLY ever watch together\n' +
      '  cannot be separated at all -- nothing breaks the symmetry, and the fit splits the\n' +
      '  disagreement between them. This run rotates the pairings for exactly that reason.',
  ),
);
console.log(
  dim(
    '  The CUSUM constants are k=0.75 / h=5, measured rather than quoted: the textbook 0.5 / 4\n' +
      '  falsely accuses a clean scout 23% of the time over one event. npm run measure:cusum.',
  ),
);

/* ── an outsider tries to inject ──────────────────────────────────────────── */

rule('8 · A rival team injects forged records');

const rival = generateDeviceKey('software');
const rivalStore = new RecordStore();
const rivalScans = ingestBatch(
  scansFor(0, rng(999)).slice(0, 20),
  { profiles, eventKey: EVENT, meshKey: generateMeshKey(), device: rival, now: () => 1_800_000_000_000 },
  new ScanSuppressor(),
);
for (const e of rivalScans.envelopes) rivalStore.admit(e, () => rival.publicKey);

const before = laptop.size;
const attack = reconcile(laptop, rivalStore, resolver);
console.log(`  rival offered ${rivalScans.sealed} records signed by a key outside the mesh`);
// `attack.rejected` sums both sessions. It equals the laptop's rejections only
// because the rival side happens to resolve every mesh key here, so the real
// evidence is the size check below, not this counter.
console.log(`  ${bold(String(attack.rejected))} records rejected across the exchange`);
console.log(
  `  laptop size ${before} → ${laptop.size} ${laptop.size === before ? ok('✓ unchanged') : warn('✗ poisoned')}`,
);
claim('forged records do not reach the laptop', laptop.size === before);
console.log(
  dim(
    '  Every record is independently signed, so a peer you do not trust cannot inject.\n' +
      '  That is what makes opportunistic gossip safe.',
  ),
);
console.log(
  warn(
    `\n  Worth stating plainly: anti-entropy is SYMMETRIC. In reaching that verdict the laptop\n` +
      `  also handed the rival ${attack.admitted} of its own records. Signing stops injection; it does\n` +
      `  not stop disclosure. The defence against disclosure is the pairing ceremony — you only\n` +
      `  ever open a session with a device already in your mesh — and this demo skipped pairing\n` +
      `  entirely by calling reconcile() directly. Do not read this section as proof of\n` +
      `  confidentiality; v1 has none on the wire (D-24).`,
  ),
);

/* ── totals ───────────────────────────────────────────────────────────────── */

rule('Summary');
console.log(`  ${totalSealed} records · ${SCOUTS} phones · ${QUALS} quals · zero venue network`);
console.log(`  ${roundTrips} sync round trips, ${(wireBytes / 1024).toFixed(0)} kB over the wire`);
console.log(
  dim(
    `\n  At the design's assumed 12 kB/s for the slowest BLE path, ${(wireBytes / 1024 / 12).toFixed(0)} s of radio time.\n` +
      '  That figure is an assumption carried through, not a measurement — see docs/MEASUREMENTS.md §6.',
  ),
);
console.log();

/* -- the claims, checked ------------------------------------------------ */

rule('Claims checked');
for (const c of claims) {
  console.log(`  ${c.held ? ok('OK  ') : warn('FAIL')} ${c.what}`);
}
const broken = claims.filter((c) => !c.held);
if (broken.length > 0) {
  console.log(
    warn(
      `\n  ${broken.length} of ${claims.length} claims did not hold. This demo runs the real code\n` +
        '  paths across every layer, so a failure here is a defect somewhere, not a flaky run —\n' +
        '  nothing in it depends on timing, the network, or an unseeded random source.',
    ),
  );
  process.exitCode = 1;
} else {
  console.log(dim(`\n  All ${claims.length} claims held.`));
}
console.log();
