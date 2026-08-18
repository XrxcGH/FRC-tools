import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createJoinRequest,
  parseJoinRequest,
  grantJoin,
  acceptGrant,
  shortAuthString,
  sasMatches,
  describeRequest,
  KeyRegistry,
  PairingError,
  RegistryError,
  SAS_DIGITS,
  type RegisteredKey,
} from '../src/index.ts';
import {
  RecordStore,
  makeRecord,
  sealRecord,
  generateDeviceKey,
  generateMeshKey,
  mintScoutPseudonym,
  deriveKeyId,
  parseMatchKey,
  toHex,
  utf8,
} from '@courier/core';

const EVENT = '2027mose';
const meshKey = generateMeshKey();

function registered(label: string, backing: 'hardware' | 'software' = 'software'): {
  key: ReturnType<typeof generateDeviceKey>;
  entry: RegisteredKey;
} {
  const key = generateDeviceKey(backing);
  return {
    key,
    entry: { kid: key.kid, publicKey: key.publicKey, backing, label, addedAt: 1_800_000_000_000 },
  };
}

/* ------------------------------------------------------------- ceremony --- */

test('a device joins the mesh and both sides agree on the code', async () => {
  const admitterDev = registered('pit-laptop');
  const registry = KeyRegistry.from([admitterDev.entry]);

  const joinerDev = generateDeviceKey('software');
  const pending = createJoinRequest(joinerDev, 'stands-tablet-3');

  const grant = await grantJoin(pending.requestBytes, {
    meshKey,
    eventKey: EVENT,
    roster: registry.active(),
  });
  const accepted = await acceptGrant(grant.grantBytes, pending);

  assert.equal(accepted.sas, grant.sas, 'both screens must show the same code');
  assert.equal(accepted.sas.length, SAS_DIGITS);
  assert.match(accepted.sas, /^\d{6}$/);
  assert.ok(sasMatches(accepted.sas, grant.sas));

  assert.equal(toHex(accepted.meshKey), toHex(meshKey), 'the mesh secret transferred');
  assert.equal(accepted.eventKey, EVENT);
  assert.equal(accepted.roster.length, 1);
  assert.equal(accepted.roster[0]!.label, 'pit-laptop');

  assert.equal(toHex(grant.joiner.kid), toHex(joinerDev.kid));
  assert.equal(grant.joiner.label, 'stands-tablet-3');
});

test('the mesh secret is never in the clear on either QR code', async () => {
  // A QR on a screen is visible to anyone with a camera, including the team
  // behind you in the stands.
  const pending = createJoinRequest(generateDeviceKey(), 'tablet');
  const grant = await grantJoin(pending.requestBytes, { meshKey, eventKey: EVENT, roster: [] });

  const needle = toHex(meshKey);
  assert.ok(!toHex(pending.requestBytes).includes(needle), 'not in the request');
  assert.ok(!toHex(grant.grantBytes).includes(needle), 'not in the grant');
});

test('the ephemeral secret never leaves the joining device', async () => {
  const pending = createJoinRequest(generateDeviceKey(), 'tablet');
  assert.ok(
    !toHex(pending.requestBytes).includes(toHex(pending.ephemeralSecret)),
    'the request must carry only the public half',
  );
});

test('a grant issued for someone else cannot be redeemed', async () => {
  // The attack this defends against: photograph the request QR, race to present
  // your own, and walk away with the mesh key.
  const realJoiner = createJoinRequest(generateDeviceKey(), 'real-tablet');
  const attacker = createJoinRequest(generateDeviceKey(), 'attacker-tablet');

  const grantToAttacker = await grantJoin(attacker.requestBytes, {
    meshKey,
    eventKey: EVENT,
    roster: [],
  });

  await assert.rejects(
    () => acceptGrant(grantToAttacker.grantBytes, realJoiner),
    /could not decrypt/,
    'the real joiner cannot open a grant sealed to the attacker',
  );
});

test('a substituted request produces a different code on each screen', async () => {
  // This is what makes the race detectable: the two humans read the code aloud
  // and it does not match.
  const real = createJoinRequest(generateDeviceKey(), 'real');
  const attacker = createJoinRequest(generateDeviceKey(), 'attacker');

  const grant = await grantJoin(attacker.requestBytes, { meshKey, eventKey: EVENT, roster: [] });
  const attackerView = await acceptGrant(grant.grantBytes, attacker);

  // The admitter's screen shows the code for the transcript it actually saw.
  assert.equal(grant.sas, attackerView.sas);
  // The real joiner, who thinks it is pairing, computes a different one.
  assert.notEqual(shortAuthString(real.requestBytes, grant.grantBytes), grant.sas);
});

test('a tampered grant fails authentication rather than yielding garbage', async () => {
  const pending = createJoinRequest(generateDeviceKey(), 'tablet');
  const grant = await grantJoin(pending.requestBytes, { meshKey, eventKey: EVENT, roster: [] });

  for (const i of [10, 40, grant.grantBytes.length - 1]) {
    const tampered = grant.grantBytes.slice();
    tampered[i]! ^= 0x01;
    await assert.rejects(() => acceptGrant(tampered, pending), PairingError, `byte ${i}`);
  }
});

test('malformed pairing payloads are refused with a clear reason', async () => {
  assert.throws(() => parseJoinRequest(new Uint8Array([1, 2, 3])), PairingError);
  assert.throws(() => parseJoinRequest(new Uint8Array(0)), PairingError);
  await assert.rejects(
    () => grantJoin(new Uint8Array([9, 9]), { meshKey, eventKey: EVENT, roster: [] }),
    PairingError,
  );
});

test('labels are bounded and required, because they must not be names', () => {
  const dev = generateDeviceKey();
  assert.throws(() => createJoinRequest(dev, ''), /label/);
  assert.throws(() => createJoinRequest(dev, 'x'.repeat(33)), /label/);
  assert.match(describeRequest(createJoinRequest(dev, 'pit-2').requestBytes), /pit-2/);
});

test('key backing survives the ceremony honestly', async () => {
  const hardware = generateDeviceKey('hardware');
  const pending = createJoinRequest(hardware, 'secure-tablet');
  const grant = await grantJoin(pending.requestBytes, { meshKey, eventKey: EVENT, roster: [] });
  assert.equal(grant.joiner.backing, 'hardware');

  const software = generateDeviceKey('software');
  const p2 = createJoinRequest(software, 'chromebook');
  const g2 = await grantJoin(p2.requestBytes, { meshKey, eventKey: EVENT, roster: [] });
  assert.equal(g2.joiner.backing, 'software', 'a software key must not claim hardware backing');
});

/* ------------------------------------------------------------- registry --- */

test('the registry rejects a key whose id does not match its public key', () => {
  const a = registered('a');
  const b = registered('b');
  const r = new KeyRegistry();
  assert.throws(() => r.add({ ...a.entry, kid: b.entry.kid }), RegistryError);
});

test('the resolver accepts registered keys and refuses everything else', () => {
  const known = registered('known');
  const stranger = generateDeviceKey();
  const r = KeyRegistry.from([known.entry]);
  const resolve = r.resolver();

  assert.equal(toHex(resolve(known.key.kid)!), toHex(known.key.publicKey));
  assert.equal(resolve(stranger.kid), undefined);
});

test('revoking a key stops future admissions but leaves the store alone', () => {
  const dev = registered('lost-tablet');
  const r = KeyRegistry.from([dev.entry]);
  const store = new RecordStore();

  const record = makeRecord({
    eventKey: EVENT,
    match: parseMatchKey(`${EVENT}_qm1`).packed,
    team: 8793,
    scout: mintScoutPseudonym('ada', EVENT, meshKey),
    schema: 'demo.scout.v1',
    body: utf8('x'),
    sealedAt: 1_800_000_000_000,
  });
  const envelope = sealRecord(record, dev.key);

  assert.equal(store.admit(envelope, r.resolver()).status, 'admitted');
  assert.equal(store.size, 1);

  r.revoke(dev.key.kid, 'tablet left in a hotel room');

  // Already-held records stay: the store is grow-only and revocation does not
  // reach into it.
  assert.equal(store.size, 1);
  // But a peer that has not yet seen this record will now refuse it. That cost
  // is real and is why revocation is for lost devices, not for graduation.
  const fresh = new RecordStore();
  const res = fresh.admit(envelope, r.resolver());
  assert.equal(res.status, 'rejected');
  assert.match(res.reason!, /unknown key id/);

  assert.equal(r.has(dev.key.kid), false);
  assert.equal(r.active().length, 0);
  assert.equal(r.list().length, 1, 'the entry is retained, with its reason');
  assert.match(r.list()[0]!.revokedReason!, /hotel/);
});

test('revoking an unknown key is an error, not a silent no-op', () => {
  const r = new KeyRegistry();
  assert.throws(() => r.revoke(generateDeviceKey().kid, 'why'), /cannot revoke unknown key/);
});

test('software-backed devices can be listed for an honest UI warning', () => {
  const r = KeyRegistry.from([
    registered('chromebook', 'software').entry,
    registered('phone', 'hardware').entry,
  ]);
  assert.deepEqual(r.softwareBacked().map((k) => k.label), ['chromebook']);
});

test('a registry round-trips through its serialised form, revocations included', () => {
  const a = registered('pit-laptop', 'hardware');
  const b = registered('stands-tablet');
  const r = KeyRegistry.from([a.entry, b.entry]);
  r.revoke(b.key.kid, 'stolen', 1_800_000_600_000);

  const back = KeyRegistry.deserialize(r.serialize());
  assert.equal(back.size, 2);
  assert.equal(back.active().length, 1);
  assert.equal(back.get(a.key.kid)!.backing, 'hardware');

  const revoked = back.get(b.key.kid)!;
  assert.equal(revoked.revokedAt, 1_800_000_600_000);
  assert.equal(revoked.revokedReason, 'stolen');
  assert.equal(back.resolver()(b.key.kid), undefined);
});

/* --------------------------------------------------- end to end --------- */

test('a freshly paired device can immediately verify the mesh’s records', async () => {
  // The whole point: after the ceremony, the joiner trusts what the mesh signs
  // and can mint pseudonyms that agree with everyone else's.
  const laptop = registered('pit-laptop');
  const registry = KeyRegistry.from([laptop.entry]);

  const joinerDev = generateDeviceKey('software');
  const pending = createJoinRequest(joinerDev, 'tablet-7');
  const grant = await grantJoin(pending.requestBytes, {
    meshKey,
    eventKey: EVENT,
    roster: registry.active(),
  });
  const accepted = await acceptGrant(grant.grantBytes, pending);
  assert.ok(sasMatches(accepted.sas, grant.sas), 'operators confirm before proceeding');

  // Joiner builds its registry from the roster, plus itself.
  const joinerRegistry = KeyRegistry.from([
    ...accepted.roster,
    { kid: joinerDev.kid, publicKey: joinerDev.publicKey, backing: 'software', label: 'me', addedAt: 0 },
  ]);
  // Admitter adds the joiner.
  registry.add(grant.joiner);

  const laptopRecord = makeRecord({
    eventKey: EVENT,
    match: parseMatchKey(`${EVENT}_qm1`).packed,
    team: 8793,
    scout: mintScoutPseudonym('ada', EVENT, meshKey),
    schema: 'demo.scout.v1',
    body: utf8('from the laptop'),
    sealedAt: 1_800_000_000_000,
  });
  const joinerStore = new RecordStore();
  assert.equal(
    joinerStore.admit(sealRecord(laptopRecord, laptop.key), joinerRegistry.resolver()).status,
    'admitted',
    'the joiner trusts the mesh immediately',
  );

  // And a pseudonym minted on the joiner matches one minted on the laptop, so
  // the same human is one scout across devices.
  assert.equal(
    toHex(mintScoutPseudonym('ada', EVENT, accepted.meshKey)),
    toHex(mintScoutPseudonym('ada', EVENT, meshKey)),
  );

  // The stranger who never paired still gets nowhere.
  const stranger = generateDeviceKey();
  const strangerRecord = sealRecord(laptopRecord, stranger);
  assert.equal(joinerStore.admit(strangerRecord, joinerRegistry.resolver()).status, 'rejected');

  assert.equal(deriveKeyId(joinerDev.publicKey).length, 8);
});

test('a revoked key is not resurrected by re-learning it from a roster', () => {
  // The defect this exists for. add() ended in an unconditional set, and a key
  // arriving in a pairing grant roster carries no revokedAt — grantJoin
  // serialises only publicKey, backing, label and addedAt. So every later
  // pairing round trip was a chance for a device you had thrown out to walk
  // back in, silently.
  const d = generateDeviceKey('software');
  const entry = {
    kid: d.kid,
    publicKey: d.publicKey,
    backing: d.backing,
    label: 'stands-tablet-3',
    addedAt: 1_800_000_000_000,
  };

  const registry = KeyRegistry.from([entry]);
  registry.revoke(d.kid, 'lost at the venue', 1_800_000_060_000);
  assert.equal(registry.has(d.kid), false);
  assert.equal(registry.active().length, 0);

  // The same key comes back in a roster, exactly as acceptGrant would add it.
  registry.add({ ...entry });

  assert.equal(registry.has(d.kid), false, 'the revocation was undone by a roster merge');
  assert.equal(registry.active().length, 0);
  assert.equal(registry.get(d.kid)?.revokedReason, 'lost at the venue');
  assert.equal(registry.resolver()(d.kid), undefined, 'a revoked key must not resolve');
});

test('a roster merge still updates the label of a live key', () => {
  // Stickiness applies to the revocation, not to everything else.
  const d = generateDeviceKey('software');
  const entry = {
    kid: d.kid,
    publicKey: d.publicKey,
    backing: d.backing,
    label: 'old-name',
    addedAt: 1_800_000_000_000,
  };
  const registry = KeyRegistry.from([entry]);
  registry.add({ ...entry, label: 'pit-laptop' });
  assert.equal(registry.get(d.kid)?.label, 'pit-laptop');
  assert.equal(registry.has(d.kid), true);
});
