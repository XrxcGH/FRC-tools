/**
 * Telling a drifting scout apart from the people they sat next to.
 *
 * The defect these exist for was found by running `courier scouts` against a
 * generated event with exactly one bad scout: it raised an alarm on all four,
 * because with two people on a robot their residuals are exact negatives and a
 * drift in one is an equal and opposite "drift" in the other.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  scoutEffects,
  adjustForPeers,
  scoutReliability,
  cusumUpdate,
  type PeerComparison,
  type CusumState,
} from '../src/index.ts';

/**
 * Pairings for an event, with each scout carrying a known additive offset.
 * Every scout is paired with every other, which is what lets the fit separate
 * them.
 */
function pairings(truth: Record<string, number>, rounds = 6): PeerComparison[] {
  const names = Object.keys(truth);
  const rows: PeerComparison[] = [];
  for (let r = 0; r < rounds; r++) {
    for (let i = 0; i < names.length; i++) {
      for (let j = i + 1; j < names.length; j++) {
        const a = names[i]!;
        const b = names[j]!;
        rows.push({ scout: a, peers: [b], residual: truth[a]! - truth[b]! });
        rows.push({ scout: b, peers: [a], residual: truth[b]! - truth[a]! });
      }
    }
  }
  return rows;
}

test('the fit finds who is actually off, not who sat next to them', () => {
  const effects = scoutEffects(pairings({ ada: 0, bo: 0, cy: -6, di: 0 }));
  const by = new Map(effects.map((e) => [e.scout, e.effect]));

  assert.ok(by.get('cy')! < -3, `cy came out at ${by.get('cy')}`);
  for (const s of ['ada', 'bo', 'di']) {
    assert.ok(Math.abs(by.get(s)!) < 2.5, `${s} was blamed at ${by.get(s)}`);
  }
  // Ordered worst-first, which is the order the operator wants to read.
  assert.equal(effects[0]!.scout, 'cy');
});

test('effects are centred, so they describe offsets from the group', () => {
  // Adding a constant to every scout leaves every residual unchanged, so only
  // the differences are identifiable. Centring makes the answer reproducible
  // rather than a function of the ridge weight.
  const effects = scoutEffects(pairings({ ada: 10, bo: 10, cy: 4, di: 10 }));
  const total = effects.reduce((a, e) => a + e.effect, 0);
  assert.ok(Math.abs(total) < 1e-9, `effects summed to ${total}`);

  // And the SHAPE is the same as when the same offsets are written around zero.
  const shifted = scoutEffects(pairings({ ada: 0, bo: 0, cy: -6, di: 0 }));
  for (let i = 0; i < effects.length; i++) {
    assert.ok(Math.abs(effects[i]!.effect - shifted[i]!.effect) < 1e-6);
  }
});

test('removing the peers\' effects leaves each scout\'s own deviation', () => {
  const truth = { ada: 0, bo: 0, cy: -6, di: 0 };
  const rows = pairings(truth);
  const adjusted = adjustForPeers(rows, scoutEffects(rows));

  // Before: an honest scout paired with cy shows +6 through no fault of theirs.
  const honestVsCy = rows.findIndex((r) => r.scout === 'ada' && r.peers[0] === 'cy');
  assert.equal(rows[honestVsCy]!.residual, 6);
  assert.ok(Math.abs(adjusted[honestVsCy]!) < 2.5, `still ${adjusted[honestVsCy]}`);

  // And cy's own row keeps its signal.
  const cyVsHonest = rows.findIndex((r) => r.scout === 'cy' && r.peers[0] === 'ada');
  assert.ok(adjusted[cyVsHonest]! < -3, `cy's deviation was erased: ${adjusted[cyVsHonest]}`);
});

test('the drift detector fires on the drifting scout and nobody else', () => {
  // The end-to-end property. Against raw residuals this test fails on all four
  // scouts, which is what shipping looked like before the fit existed.
  const rows = pairings({ ada: 0, bo: 0, cy: -6, di: 0 }, 12);
  const adjusted = adjustForPeers(rows, scoutEffects(rows));

  const scale = 2; // one typical scout-to-scout disagreement
  const alarms = new Set<string>();
  const states = new Map<string, CusumState | null>();
  rows.forEach((r, i) => {
    const next = cusumUpdate(states.get(r.scout) ?? null, adjusted[i]! / scale);
    states.set(r.scout, next);
    if (next.alarm) alarms.add(r.scout);
  });

  assert.deepEqual([...alarms], ['cy']);
});

test('bias estimates stop blaming the innocent once peers are removed', () => {
  const rows = pairings({ ada: 0, bo: 0, cy: -6, di: 0 });
  const adjusted = adjustForPeers(rows, scoutEffects(rows));

  const naive = new Map(
    scoutReliability(rows.map((r) => ({ scout: r.scout, residual: r.residual }))).map((q) => [
      q.scout,
      q.bias,
    ]),
  );
  const fixed = new Map(
    scoutReliability(rows.map((r, i) => ({ scout: r.scout, residual: adjusted[i]! }))).map((q) => [
      q.scout,
      q.bias,
    ]),
  );

  assert.ok(naive.get('ada')! > 1, 'the naive estimate should look bad for ada');
  assert.ok(Math.abs(fixed.get('ada')!) < Math.abs(naive.get('ada')!), 'no improvement for ada');
  assert.ok(fixed.get('cy')! < -2, 'cy must still be identified');
});

test('two scouts who only ever watch together cannot be separated', () => {
  // A real limit of peer consensus, not an estimator problem: with no third
  // opinion there is nothing to break the symmetry, so the fit splits the
  // difference. The CLI says this out loud.
  const rows: PeerComparison[] = [];
  for (let i = 0; i < 10; i++) {
    rows.push({ scout: 'ada', peers: ['bo'], residual: 8 });
    rows.push({ scout: 'bo', peers: ['ada'], residual: -8 });
  }
  const effects = scoutEffects(rows);
  const by = new Map(effects.map((e) => [e.scout, e.effect]));
  assert.ok(
    Math.abs(by.get('ada')! + by.get('bo')!) < 1e-9,
    'the difference should be split evenly between them',
  );
  assert.ok(by.get('ada')! > 0 && by.get('bo')! < 0);
});

test('a scout with three peers at once is weighted as one comparison', () => {
  const rows: PeerComparison[] = [
    { scout: 'ada', peers: ['bo', 'cy', 'di'], residual: 9 },
    { scout: 'bo', peers: ['ada', 'cy', 'di'], residual: -3 },
    { scout: 'cy', peers: ['ada', 'bo', 'di'], residual: -3 },
    { scout: 'di', peers: ['ada', 'bo', 'cy'], residual: -3 },
  ];
  const effects = scoutEffects(rows);
  assert.equal(effects.at(-1)!.scout, 'ada', 'ada is the high one');
  assert.equal(effects.find((e) => e.scout === 'ada')!.comparisons, 1);
});

test('empty and single-scout inputs do not throw', () => {
  assert.deepEqual(scoutEffects([]), []);
  const one = scoutEffects([{ scout: 'ada', peers: [], residual: 3 }]);
  assert.equal(one.length, 1);
  assert.equal(one[0]!.effect, 0, 'with nobody to compare against there is no offset');
  assert.deepEqual(adjustForPeers([{ scout: 'ada', peers: [], residual: 3 }], one), [3]);
});

test('a non-finite residual is skipped rather than poisoning the solve', () => {
  const rows: PeerComparison[] = [
    ...pairings({ ada: 0, bo: -4 }),
    { scout: 'ada', peers: ['bo'], residual: NaN },
  ];
  const effects = scoutEffects(rows);
  for (const e of effects) assert.ok(Number.isFinite(e.effect), `${e.scout} came out ${e.effect}`);
  assert.equal(effects[0]!.scout, 'bo');
});
