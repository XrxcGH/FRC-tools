/**
 * Where to set the drift detector, measured rather than quoted.
 *
 * `CUSUM_SLACK` and `CUSUM_THRESHOLD` were originally 0.5 and 4 — the textbook
 * pairing, carried in with a comment admitting they had never been checked
 * against anything. Running the real `courier scouts` command against generated
 * events with NO drift injected raised an alarm on one or two innocent scouts
 * every single time, which is how this got looked at.
 *
 * The textbook figure for that pairing is an in-control run length around 168
 * observations, which sounds comfortable. It is the wrong statistic for this
 * job. A team runs four to eight scouts in parallel over roughly fifty paired
 * observations each, and what matters is the chance that ANY of them is falsely
 * accused during ONE event. At k=0.5, h=4 that is about one false alarm per
 * event — and a drift table that is usually wrong is worse than no table,
 * because people stop reading it and then miss the real one.
 *
 * Run with:
 *   node --experimental-strip-types packages/analytics/bench/cusum-operating-point.ts
 *
 * The generator is a fixed-seed PRNG, so the numbers below reproduce exactly.
 */

import { CUSUM_SLACK, CUSUM_THRESHOLD } from '../src/index.ts';

const TRIALS = 20_000;
/** Paired observations one scout accumulates at a typical two-day event. */
const N = 48;
/** A scout who stops paying attention partway through, not from match one. */
const DRIFT_STARTS_AT = 24;

let seed = 20260817;
function rnd(): number {
  seed ^= seed << 13;
  seed >>>= 0;
  seed ^= seed >> 17;
  seed ^= seed << 5;
  seed >>>= 0;
  return seed / 0x100000000;
}
function gaussian(): number {
  const u = Math.max(rnd(), 1e-12);
  const v = rnd();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

interface Outcome {
  /**
   * Fraction whose FIRST alarm lands at or after the drift began.
   *
   * An alarm that fires before the drift starts is a false accusation, not a
   * detection, and counting it as one flatters exactly the loose settings that
   * produce the most of them. That mistake made 0.5/4 look like a 99% detector.
   */
  readonly rate: number;
  /** Median observations from the drift starting to the alarm. NaN if never. */
  readonly delay: number;
}

function simulate(k: number, h: number, shift: number): Outcome {
  let counted = 0;
  const delays: number[] = [];
  for (let t = 0; t < TRIALS; t++) {
    let high = 0;
    let low = 0;
    for (let i = 0; i < N; i++) {
      const x = gaussian() + (i >= DRIFT_STARTS_AT ? shift : 0);
      high = Math.max(0, high + x - k);
      low = Math.max(0, low - x - k);
      if (high > h || low > h) {
        // shift === 0 is the clean run: every alarm anywhere is a false one.
        if (shift === 0 || i >= DRIFT_STARTS_AT) counted++;
        if (i >= DRIFT_STARTS_AT) delays.push(i - DRIFT_STARTS_AT);
        break;
      }
    }
  }
  delays.sort((a, b) => a - b);
  return {
    rate: counted / TRIALS,
    delay: delays.length > 0 ? delays[Math.floor(delays.length / 2)]! : NaN,
  };
}

const CANDIDATES: Array<[number, number]> = [
  [0.5, 4],
  [0.5, 5],
  [0.75, 5],
  [1.0, 4],
  [1.0, 5],
];

const pct = (x: number): string => `${(x * 100).toFixed(1)}%`;
const cell = (o: Outcome): string =>
  `${pct(o.rate).padStart(6)} in ${Number.isNaN(o.delay) ? ' -' : String(o.delay).padStart(2)}`;

console.log(
  `CUSUM operating point — ${TRIALS} trials, ${N} paired observations per scout,\n` +
    `drift beginning at observation ${DRIFT_STARTS_AT}. Shift is in units of the pool's own\n` +
    `disagreement spread, so "1.0" means a scout who has moved one typical\n` +
    `scout-to-scout disagreement away from everyone else.\n`,
);
console.log('   k     h   false alarm   detect 1.0σ   detect 1.5σ   detect 2.0σ');
for (const [k, h] of CANDIDATES) {
  const clean = simulate(k, h, 0);
  const row = [1.0, 1.5, 2.0].map((d) => cell(simulate(k, h, -d)));
  const mark = k === CUSUM_SLACK && h === CUSUM_THRESHOLD ? '  <- shipped' : '';
  console.log(
    `  ${k.toFixed(2)}  ${h.toFixed(1)}   ${pct(clean.rate).padStart(11)}   ` +
      `${row.join('   ')}${mark}`,
  );
}

console.log(
  '\n"detect" is the fraction that alarm, and the median number of paired observations\n' +
    'from the drift starting to the alarm firing.\n',
);

const team = [4, 6, 8];
console.log('Chance that AT LEAST ONE scout on a clean team is falsely accused in one event:');
console.log('   k     h   ' + team.map((n) => `${n} scouts`.padStart(9)).join('  '));
for (const [k, h] of CANDIDATES) {
  const p = simulate(k, h, 0).rate;
  console.log(
    `  ${k.toFixed(2)}  ${h.toFixed(1)}   ` +
      team.map((n) => pct(1 - (1 - p) ** n).padStart(9)).join('  '),
  );
}

console.log(
  '\nThe shipped pairing is chosen from the last table. An alarm has to be believable:\n' +
    'a detector that accuses somebody at a third of events gets ignored, and then the\n' +
    'real drift goes unnoticed too. The cost is missing about a fifth of MILD (1σ)\n' +
    'drifts; anything worse than that is caught essentially every time, within three\n' +
    'to five of a scout\'s own pairings — the medians in the table above, not fewer.',
);
