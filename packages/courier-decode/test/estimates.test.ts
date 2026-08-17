/**
 * Per-team estimates straight from scouting data.
 *
 * The property that matters most here is the one about certainty: a picklist
 * sorted by a floor will promote whichever team has the smallest sigma, so a
 * team whose three scouts happened to agree exactly must NOT report sigma of
 * zero. Half these tests are about that.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  teamEstimatesFrom,
  DEFAULT_MIN_OBSERVATIONS,
  type DecodedRecord,
} from '../src/index.ts';

const rec = (team: number, match: number, values: Record<string, number | boolean | string>): DecodedRecord => ({
  team,
  match,
  eventKey: '2027mose',
  scout: 'aa',
  values,
});

/** n records for one team with the given values. */
function series(team: number, values: readonly (number | boolean)[]): DecodedRecord[] {
  return values.map((v, i) => rec(team, i + 1, { teleop: v }));
}

test('a team mean is the mean of its own observations', () => {
  const { estimates } = teamEstimatesFrom(series(8793, [10, 20, 30]), 'teleop');
  assert.equal(estimates.length, 1);
  assert.equal(estimates[0]!.team, 8793);
  assert.equal(estimates[0]!.mean, 20);
  assert.equal(estimates[0]!.observations, 3);
});

test('estimates come back sorted by mean, best first', () => {
  const records = [...series(1, [5, 5, 5]), ...series(2, [40, 40, 40]), ...series(3, [12, 12, 12])];
  const { estimates } = teamEstimatesFrom(records, 'teleop');
  assert.deepEqual(
    estimates.map((e) => e.team),
    [2, 3, 1],
  );
});

test('a team below the observation floor is omitted and reported, not estimated', () => {
  const records = [...series(1, [10, 10, 10]), ...series(2, [99, 99])];
  const { estimates, thin } = teamEstimatesFrom(records, 'teleop');

  assert.deepEqual(
    estimates.map((e) => e.team),
    [1],
    'team 2 has two observations against a floor of three',
  );
  assert.deepEqual(thin, [{ team: 2, observations: 2 }]);
});

test('the observation floor is configurable, and reporting follows it', () => {
  const records = [...series(1, [10, 10, 10]), ...series(2, [99, 99])];

  const loose = teamEstimatesFrom(records, 'teleop', { minObservations: 2 });
  assert.deepEqual(
    loose.estimates.map((e) => e.team),
    [2, 1],
  );
  assert.deepEqual(loose.thin, []);

  const strict = teamEstimatesFrom(records, 'teleop', { minObservations: 4 });
  assert.deepEqual(strict.estimates, []);
  assert.deepEqual(
    strict.thin.map((t) => t.team),
    [1, 2],
    'thin is sorted by team, so the message is stable between runs',
  );
});

test('three identical observations do NOT produce a sigma of zero', () => {
  // The failure this guards: a team scouted three times who happened to score
  // the same number each time has a sample standard deviation of exactly zero.
  // Sorted by floor (mean - k*sigma) that team leaps over genuinely better
  // robots on the strength of a coincidence.
  const records = [
    ...series(1, [30, 30, 30]), // suspiciously consistent
    ...series(2, [45, 25, 50, 20, 43, 27]), // real spread, and genuinely better
    ...series(3, [10, 50, 5, 55]),
  ];
  const { estimates } = teamEstimatesFrom(records, 'teleop');
  const one = estimates.find((e) => e.team === 1)!;

  assert.ok(one.sigma > 1, `sigma was ${one.sigma}, which is small enough to be a bug`);

  // And the floor it implies must not beat the team that actually scores more.
  const two = estimates.find((e) => e.team === 2)!;
  assert.ok(
    two.mean - two.sigma > one.mean - one.sigma,
    'the coincidence team out-floored the better team',
  );
});

test('more observations tighten sigma', () => {
  const few = teamEstimatesFrom(series(1, [10, 20, 30]), 'teleop').estimates[0]!;
  const many = teamEstimatesFrom(
    series(1, [10, 20, 30, 10, 20, 30, 10, 20, 30, 10, 20, 30]),
    'teleop',
  ).estimates[0]!;

  assert.equal(few.mean, many.mean, 'same spread, same centre');
  assert.ok(many.sigma < few.sigma, `${many.sigma} should be under ${few.sigma}`);
});

test('sigma is always positive, even for a single-valued pool', () => {
  // Every observation in the event is identical, so the pool spread is zero
  // too and there is nothing to shrink toward. Sigma must still be usable as a
  // divisor downstream.
  const { estimates } = teamEstimatesFrom(
    [...series(1, [7, 7, 7]), ...series(2, [7, 7, 7])],
    'teleop',
  );
  for (const e of estimates) assert.ok(e.sigma > 0, `team ${e.team} reported sigma ${e.sigma}`);
});

test('booleans count as one and zero', () => {
  const { estimates } = teamEstimatesFrom(series(1, [true, false, true, true]), 'teleop');
  assert.equal(estimates[0]!.mean, 0.75);
});

test('a string field contributes nothing rather than being coerced', () => {
  // "deep" and "park" have no numeric ordering the team ever declared. Mapping
  // them onto numbers here would invent a scale.
  const records = [
    rec(1, 1, { endgame: 'deep' }),
    rec(1, 2, { endgame: 'park' }),
    rec(1, 3, { endgame: 'deep' }),
  ];
  const { estimates, thin } = teamEstimatesFrom(records, 'endgame');
  assert.deepEqual(estimates, []);
  assert.deepEqual(thin, [], 'a team with no readable values is not even a thin team');
});

test('records missing the field are skipped without disqualifying the team', () => {
  const records = [
    rec(1, 1, { teleop: 10 }),
    rec(1, 2, {}), // the scout left it blank; the schema reported it missing
    rec(1, 3, { teleop: 20 }),
    rec(1, 4, { teleop: 30 }),
  ];
  const { estimates } = teamEstimatesFrom(records, 'teleop');
  assert.equal(estimates.length, 1);
  assert.equal(estimates[0]!.observations, 3, 'the blank match is not an observation');
  assert.equal(estimates[0]!.mean, 20);
});

test('an empty input yields nothing rather than throwing', () => {
  const { estimates, thin } = teamEstimatesFrom([], 'teleop');
  assert.deepEqual(estimates, []);
  assert.deepEqual(thin, []);
});

test('the default floor is stated once and exported', () => {
  assert.equal(DEFAULT_MIN_OBSERVATIONS, 3);
  const { thin } = teamEstimatesFrom(series(1, [10, 10]), 'teleop');
  assert.equal(thin.length, 1, 'two observations is under the exported default');
});

test('double-scouted matches both count — this is not a per-match average', () => {
  // Deliberate: two scouts watching the same robot is two observations of it,
  // and the disagreement between them is real uncertainty that belongs in
  // sigma. Collapsing them to a match average would hide exactly the noise a
  // picklist needs to see. (Alliance-level fitting DOES average them, in
  // toAllianceObservations, because there the sum must not double-count.)
  const records = [
    { ...rec(1, 1, { teleop: 10 }), scout: 'aa' },
    { ...rec(1, 1, { teleop: 30 }), scout: 'bb' },
    { ...rec(1, 2, { teleop: 20 }), scout: 'aa' },
  ];
  const { estimates } = teamEstimatesFrom(records, 'teleop');
  assert.equal(estimates[0]!.observations, 3);
  assert.equal(estimates[0]!.mean, 20);
});
