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
import { loadProfileSet } from '../packages/courier-bridge/src/profiles.ts';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const EVENT = '2027mose';
const SCOUTS = 8;
const QUALS = 80;
const TEAMS = [8793, 9143, 254, 1678, 118, 2056, 3128, 5940, 27, 1323, 604, 2910];

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
    const team = robotsInMatch(m)[scout % 6]!;

    // The ground truth for this robot in this match — both scouts see the same
    // robot do the same things.
    const truth = rng(m * 7919 + team);
    const auto = Math.floor(truth() * 5);
    const teleop = Math.floor(truth() * 18);
    const climb = ['none', 'park', 'shallow', 'deep'][Math.floor(truth() * 4)]!;
    const defense = truth() > 0.75 ? 'heavy' : 'none';

    // ...but one of them occasionally miscounts.
    const miscount = rand() < 0.15;
    out.push(
      [`scout-${scout}`, m, team, auto, miscount ? teleop + 1 : teleop, climb, defense, `note-${m}`].join(
        '\t',
      ),
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
  if (converged) break;
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

/* ── an outsider tries to inject ──────────────────────────────────────────── */

rule('5 · A rival team injects forged records');

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
      '  That figure is an assumption carried through, not a measurement — see docs/MEASUREMENTS.md §5.',
  ),
);
console.log();
