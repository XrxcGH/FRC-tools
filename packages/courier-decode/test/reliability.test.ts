/**
 * Peer-consensus residuals: the reference that exists offline.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { peerResiduals, residualScale, type DecodedRecord } from '../src/index.ts';

const rec = (
  scout: string,
  match: number,
  team: number,
  teleop: number | boolean | string,
): DecodedRecord => ({ team, match, eventKey: '2027mose', scout, values: { teleop } });

test('two scouts on one robot each get the other as their reference', () => {
  const { residuals, doubleScouted, unpaired } = peerResiduals(
    [rec('ada', 1, 8793, 20), rec('bo', 1, 8793, 14)],
    'teleop',
  );
  assert.equal(doubleScouted, 1);
  assert.equal(unpaired, 0);
  assert.equal(residuals.length, 2);

  const ada = residuals.find((r) => r.scout === 'ada')!;
  assert.equal(ada.peerMean, 14);
  assert.equal(ada.residual, 6);
  assert.deepEqual(ada.peerScouts, ['bo']);

  // Exactly antisymmetric, which is the whole reason a raw residual cannot be
  // read one row at a time.
  const bo = residuals.find((r) => r.scout === 'bo')!;
  assert.equal(bo.residual, -6);
});

test('the reference leaves the scout out of their own consensus', () => {
  // Including yourself in the mean shrinks every residual by 1/n and makes
  // everybody look better the fewer people are watching.
  const { residuals } = peerResiduals(
    [rec('ada', 1, 8793, 30), rec('bo', 1, 8793, 10), rec('cy', 1, 8793, 20)],
    'teleop',
  );
  const ada = residuals.find((r) => r.scout === 'ada')!;
  assert.equal(ada.peerMean, 15, 'the mean of bo and cy only');
  assert.equal(ada.residual, 15);
  assert.equal(ada.peers, 2);
});

test('a robot only one person watched produces no residual and is counted', () => {
  const { residuals, unpaired, doubleScouted, observations } = peerResiduals(
    [rec('ada', 1, 8793, 20), rec('ada', 2, 9143, 15), rec('bo', 2, 9143, 17)],
    'teleop',
  );
  assert.equal(residuals.length, 2, 'only match 2 had a second opinion');
  assert.equal(unpaired, 1);
  assert.equal(doubleScouted, 1);
  assert.equal(observations, 2);
});

test('the same scout twice on one robot is one opinion, not two', () => {
  // Otherwise a scout becomes their own peer and reports a residual of zero
  // against themselves, which reads as perfect agreement.
  const { residuals, unpaired } = peerResiduals(
    [rec('ada', 1, 8793, 20), rec('ada', 1, 8793, 24)],
    'teleop',
  );
  assert.deepEqual(residuals, []);
  assert.equal(unpaired, 1);
});

test('booleans count, strings do not', () => {
  const boolish = peerResiduals(
    [rec('ada', 1, 8793, true), rec('bo', 1, 8793, false)],
    'teleop',
  );
  assert.equal(boolish.residuals.find((r) => r.scout === 'ada')!.residual, 1);

  const texty = peerResiduals(
    [rec('ada', 1, 8793, 'deep'), rec('bo', 1, 8793, 'park')],
    'teleop',
  );
  assert.deepEqual(texty.residuals, [], 'no ordering was ever declared for these');
  assert.equal(texty.observations, 1, 'the observation still happened');
});

test('the same robot in different matches is not one observation', () => {
  const { residuals, unpaired } = peerResiduals(
    [rec('ada', 1, 8793, 20), rec('bo', 2, 8793, 14)],
    'teleop',
  );
  assert.deepEqual(residuals, []);
  assert.equal(unpaired, 2);
});

test('the same match number at different events is not one observation', () => {
  const a = { ...rec('ada', 1, 8793, 20), eventKey: '2027mose' };
  const b = { ...rec('bo', 1, 8793, 14), eventKey: '2027mimil' };
  const { residuals, observations } = peerResiduals([a, b], 'teleop');
  assert.deepEqual(residuals, []);
  assert.equal(observations, 2);
});

test('residuals come out in a stable order regardless of input order', () => {
  const records = [
    rec('bo', 2, 118, 9),
    rec('ada', 1, 8793, 20),
    rec('cy', 2, 118, 12),
    rec('bo', 1, 8793, 14),
  ];
  const key = (rs: readonly { match: number; team: number; scout: string }[]) =>
    rs.map((r) => `${r.match}/${r.team}/${r.scout}`).join(',');

  const forward = peerResiduals(records, 'teleop').residuals;
  const backward = peerResiduals([...records].reverse(), 'teleop').residuals;
  assert.equal(key(forward), key(backward), 'CUSUM would walk two different sequences');
});

test('the scale is the pool spread, and never zero', () => {
  const spread = peerResiduals(
    [
      rec('ada', 1, 8793, 20), rec('bo', 1, 8793, 10),
      rec('ada', 2, 9143, 5), rec('bo', 2, 9143, 25),
    ],
    'teleop',
  ).residuals;
  assert.ok(residualScale(spread) > 1);

  // Everyone agrees exactly: no drift to detect, and the divisor must stay finite.
  const identical = peerResiduals(
    [
      rec('ada', 1, 8793, 12), rec('bo', 1, 8793, 12),
      rec('ada', 2, 9143, 7), rec('bo', 2, 9143, 7),
    ],
    'teleop',
  ).residuals;
  assert.equal(residualScale(identical), 1);
  assert.equal(residualScale([]), 1);
});
