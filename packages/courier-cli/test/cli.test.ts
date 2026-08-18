import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Workspace, run, loadProfilesForTest } from './helpers.ts';
import * as cmd from '../src/commands.ts';

function scratch(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'courier-cli-'));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

const EVENT = '2027mose';
const tsv = (...f: (string | number)[]): string => f.join('\t');
const PROFILES = loadProfilesForTest();

/* ---------------------------------------------------------------- basics -- */

test('init creates a workspace and status describes it', () => {
  const s = scratch();
  try {
    const ws = new Workspace(join(s.dir, 'ws'));
    const r = cmd.init(ws, EVENT, 'pit-laptop');
    assert.equal(r.code, 0);
    assert.match(r.text, /Initialised/);

    const st = cmd.status(ws);
    assert.equal(st.code, 0);
    assert.match(st.text, new RegExp(EVENT));
    assert.match(st.text, /pit-laptop/);
    assert.match(st.text, /records     0/);
    // The workspace must be honest that a file-backed key is not hardware.
    assert.match(st.text, /software-backed keys/);
  } finally {
    s.cleanup();
  }
});

test('init refuses a bad event key, an empty label, and a personal name', () => {
  const s = scratch();
  try {
    assert.equal(cmd.init(new Workspace(join(s.dir, 'a')), 'nope', 'pit-laptop').code, 1);
    assert.equal(cmd.init(new Workspace(join(s.dir, 'b')), EVENT, '').code, 1);

    // The registry is a trust list, not a roster. Labels must name devices.
    const named = cmd.init(new Workspace(join(s.dir, 'c')), EVENT, 'Ada');
    assert.equal(named.code, 1);
    assert.match(named.text, /looks like a person's name/);
  } finally {
    s.cleanup();
  }
});

test('re-initialising an existing workspace is refused, with the reason', () => {
  const s = scratch();
  try {
    const ws = new Workspace(join(s.dir, 'ws'));
    cmd.init(ws, EVENT, 'pit-laptop');
    assert.throws(() => ws.init({ eventKey: EVENT, label: 'again' }), /already initialised/);
  } finally {
    s.cleanup();
  }
});

test('commands on a missing workspace fail with a pointer to init', () => {
  const s = scratch();
  try {
    const r = cmd.status(new Workspace(join(s.dir, 'nothing')));
    assert.equal(r.code, 1);
    assert.match(r.text, /courier init/);
  } finally {
    s.cleanup();
  }
});

/* --------------------------------------------------------------- pairing -- */

test('two devices pair, agree on a code, and end up trusting each other', async () => {
  const s = scratch();
  try {
    const laptopDir = join(s.dir, 'laptop');
    const tabletDir = join(s.dir, 'tablet');
    const laptop = new Workspace(laptopDir);
    const tablet = new Workspace(tabletDir);

    cmd.init(laptop, EVENT, 'pit-laptop');
    cmd.init(tablet, EVENT, 'stands-tablet-3');

    // 1. The joiner writes a request.
    const reqPath = join(s.dir, 'req.bin');
    const jr = cmd.joinRequest(tablet, reqPath);
    assert.equal(jr.code, 0);
    assert.match(jr.text, /must not be shared/);

    // 2. The admitter grants it.
    const grantPath = join(s.dir, 'grant.bin');
    const g = await cmd.grant(laptop, reqPath, grantPath);
    assert.equal(g.code, 0);
    const laptopCode = /Confirmation code:\s+(\d{6})/.exec(g.text)![1]!;

    // 3. The joiner accepts.
    const a = await cmd.accept(tablet, grantPath, reqPath);
    assert.equal(a.code, 0);
    const tabletCode = /Confirmation code:\s+(\d{6})/.exec(a.text)![1]!;

    assert.equal(laptopCode, tabletCode, 'both screens show the same code');

    // The grant does NOT trust anyone. Confirming is what admits.
    assert.equal(laptop.registry().active().length, 1, 'granting trusted the joiner too early');
    assert.ok(laptop.pendingAdmission(), 'the joiner should be staged, not trusted');

    // 4. The codes are read aloud and compared. THIS is the commit point.
    const c = cmd.confirm(laptop, laptopCode, tabletCode);
    assert.equal(c.code, 0, c.text);
    assert.match(c.text, /Admitted/);
    assert.equal(laptop.pendingAdmission(), null, 'the staged key outlived the ceremony');

    // Both registries now hold both devices.
    assert.equal(laptop.registry().active().length, 2);
    assert.equal(tablet.registry().active().length, 2);
    // And they share one mesh secret, so pseudonyms agree across devices.
    assert.deepEqual(tablet.mesh().meshKey, laptop.mesh().meshKey);
    assert.equal(tablet.mesh().eventKey, EVENT);
    // The joiner keeps its own label rather than inheriting the admitter's.
    assert.equal(tablet.mesh().label, 'stands-tablet-3');
  } finally {
    s.cleanup();
  }
});

test('a mismatched confirmation code tells the operator to start over', () => {
  const r = cmd.confirm(null, '123456', '654321');
  assert.equal(r.code, 1);
  assert.match(r.text, /DO NOT match/);
  assert.match(r.text, /start the ceremony again/i);
});

test('a substituted request is never trusted, and needs nothing undone', async () => {
  // The defect this exists for. `grant` used to write the joiner into
  // registry.cbor before the six digits were even printed, so an attacker who
  // swapped the request QR was trusted the moment the operator ran the command.
  // The printed advice — delete the grant and start again — touches no
  // registry, revoke is not routed through the CLI, and the only real undo was
  // deleting the workspace, which also destroys device.key and every record.
  const s = scratch();
  try {
    const laptop = new Workspace(join(s.dir, 'laptop'));
    const attacker = new Workspace(join(s.dir, 'attacker'));
    cmd.init(laptop, EVENT, 'pit-laptop');
    cmd.init(attacker, EVENT, 'not-your-tablet');

    const reqPath = join(s.dir, 'attacker.req');
    cmd.joinRequest(attacker, reqPath);
    const g = await cmd.grant(laptop, reqPath, join(s.dir, 'grant.bin'));
    assert.equal(g.code, 0);
    assert.match(g.text, /NOT trusted yet/);

    const before = laptop.registry().active().length;
    assert.equal(before, 1, 'the attacker was trusted by grant alone');

    // The operators compare and the digits disagree.
    const r = cmd.confirm(laptop, '111111', '222222');
    assert.equal(r.code, 1);
    assert.match(r.text, /discarded/);
    assert.match(r.text, /never trusted/);

    assert.equal(laptop.registry().active().length, before);
    assert.equal(laptop.pendingAdmission(), null, 'the staged key was left behind');
  } finally {
    s.cleanup();
  }
});

test('two operators who mistype the SAME wrong code do not admit anyone', async () => {
  // Matching each other only proves they typed the same thing. The code has to
  // match what this device actually computed.
  const s = scratch();
  try {
    const laptop = new Workspace(join(s.dir, 'laptop'));
    const tablet = new Workspace(join(s.dir, 'tablet'));
    cmd.init(laptop, EVENT, 'pit-laptop');
    cmd.init(tablet, EVENT, 'stands-tablet');

    const reqPath = join(s.dir, 'req.bin');
    cmd.joinRequest(tablet, reqPath);
    await cmd.grant(laptop, reqPath, join(s.dir, 'grant.bin'));

    const r = cmd.confirm(laptop, '000000', '000000');
    assert.equal(r.code, 1);
    assert.match(r.text, /this device computed/);
    assert.match(r.text, /Matching each other is not enough/);
    assert.equal(laptop.registry().active().length, 1);
    assert.equal(laptop.pendingAdmission(), null);
  } finally {
    s.cleanup();
  }
});

test('confirm on a device with nothing staged is still just a comparison', () => {
  // The joining side has nothing to commit; saying "admitted" there would imply
  // an action that did not happen.
  const s = scratch();
  try {
    const ws = new Workspace(join(s.dir, 'ws'));
    cmd.init(ws, EVENT, 'stands-tablet');
    const r = cmd.confirm(ws, '123456', '123456');
    assert.equal(r.code, 0);
    assert.match(r.text, /pairing is genuine/);
    assert.ok(!/Admitted/.test(r.text));
  } finally {
    s.cleanup();
  }
});

/* ---------------------------------------------------------------- ingest -- */

test('ingest seals scans, stores them, and reports every outcome', () => {
  const s = scratch();
  try {
    const ws = new Workspace(join(s.dir, 'ws'));
    cmd.init(ws, EVENT, 'pit-laptop');

    const scans = join(s.dir, 'scans.txt');
    writeFileSync(
      scans,
      [
        tsv('ada', 1, 8793, 3, 11, 'deep'),
        tsv('bo', 2, 9143, 1, 7, 'park'),
        tsv('ada', 1, 8793, 3, 11, 'deep'), // duplicate scan
        'not a scouting payload',
        '',
      ].join('\n'),
    );

    const r = cmd.ingest(ws, scans, PROFILES);
    assert.equal(r.code, 0);
    assert.match(r.text, /sealed          2/);
    assert.match(r.text, /duplicate scans 1/);
    assert.match(r.text, /unmatched       1/);
    assert.match(r.text, /store now holds 2/);
    // The privacy note must appear, because these payloads carry the scout id.
    assert.match(r.text, /raw value travels with/);
    assert.match(r.text, /Use handles rather than names/);

    assert.equal(ws.store().size, 2);
    assert.equal(ws.storeCount(), 2);
  } finally {
    s.cleanup();
  }
});

test('ingest is idempotent across runs — the store is grow-only', () => {
  const s = scratch();
  try {
    const ws = new Workspace(join(s.dir, 'ws'));
    cmd.init(ws, EVENT, 'pit-laptop');
    const scans = join(s.dir, 'scans.txt');
    writeFileSync(scans, tsv('ada', 1, 8793, 3));

    cmd.ingest(ws, scans, PROFILES);
    const second = cmd.ingest(ws, scans, PROFILES);
    // A fresh suppressor each run means it re-seals, but sealedAt differs so the
    // record id differs. What must NOT happen is data loss or corruption.
    assert.equal(second.code, 0);
    assert.ok(ws.store().size >= 1);
    assert.equal(cmd.verifyStore(ws).code, 0);
  } finally {
    s.cleanup();
  }
});

/* --------------------------------------------------------------- bundles -- */

test('a bundle moves a day of data between two paired devices', async () => {
  const s = scratch();
  try {
    const laptop = new Workspace(join(s.dir, 'laptop'));
    const tablet = new Workspace(join(s.dir, 'tablet'));
    cmd.init(laptop, EVENT, 'pit-laptop');
    cmd.init(tablet, EVENT, 'stands-tablet');

    const reqPath = join(s.dir, 'req.bin');
    const grantPath = join(s.dir, 'grant.bin');
    cmd.joinRequest(tablet, reqPath);
    const g = await cmd.grant(laptop, reqPath, grantPath);
    await cmd.accept(tablet, grantPath, reqPath);
    // The ceremony is not finished until the codes are compared — that is what
    // admits the joiner, so a test that skips it is not testing a paired mesh.
    const code = /Confirmation code:\s+(\d{6})/.exec(g.text)![1]!;
    assert.equal(cmd.confirm(laptop, code, code).code, 0);

    const scans = join(s.dir, 'scans.txt');
    writeFileSync(
      scans,
      Array.from({ length: 30 }, (_, i) => tsv(`scout-${i % 4}`, (i % 10) + 1, 8793 + (i % 3), i)).join(
        '\n',
      ),
    );
    cmd.ingest(tablet, scans, PROFILES);

    const bundlePath = join(s.dir, 'day.courier');
    const ex = cmd.exportBundle(tablet, bundlePath);
    assert.equal(ex.code, 0);
    assert.match(ex.text, /exactly as safe to accept from a stranger/);

    const im = cmd.importBundle(laptop, bundlePath);
    assert.equal(im.code, 0);
    assert.match(im.text, /admitted   30/);
    assert.equal(laptop.store().size, 30);
    assert.equal(cmd.verifyStore(laptop).code, 0);
  } finally {
    s.cleanup();
  }
});

test('an unpaired device rejects the bundle, and says pairing is the fix', () => {
  const s = scratch();
  try {
    const a = new Workspace(join(s.dir, 'a'));
    const b = new Workspace(join(s.dir, 'b'));
    cmd.init(a, EVENT, 'device-a');
    cmd.init(b, EVENT, 'device-b'); // never paired

    const scans = join(s.dir, 'scans.txt');
    writeFileSync(scans, tsv('ada', 1, 8793, 3));
    cmd.ingest(a, scans, PROFILES);

    const bundlePath = join(s.dir, 'x.courier');
    cmd.exportBundle(a, bundlePath);

    const im = cmd.importBundle(b, bundlePath);
    assert.match(im.text, /rejected   1/);
    assert.match(im.text, /pair with the device first/);
    assert.equal(b.store().size, 0);
  } finally {
    s.cleanup();
  }
});

test('a bundle for another event is refused wholesale', () => {
  const s = scratch();
  try {
    const a = new Workspace(join(s.dir, 'a'));
    const b = new Workspace(join(s.dir, 'b'));
    cmd.init(a, EVENT, 'device-a');
    cmd.init(b, '2027wamo', 'device-b');

    const scans = join(s.dir, 'scans.txt');
    writeFileSync(scans, tsv('ada', 1, 8793, 3));
    cmd.ingest(a, scans, PROFILES);
    const bundlePath = join(s.dir, 'x.courier');
    cmd.exportBundle(a, bundlePath);

    const im = cmd.importBundle(b, bundlePath);
    assert.equal(im.code, 1);
    assert.match(im.text, /Nothing was merged/);
    assert.equal(b.store().size, 0);
  } finally {
    s.cleanup();
  }
});

/* ---------------------------------------------------------------- report -- */

test('report shows coverage and marks second opinions', () => {
  const s = scratch();
  try {
    const ws = new Workspace(join(s.dir, 'ws'));
    cmd.init(ws, EVENT, 'pit-laptop');

    const scans = join(s.dir, 'scans.txt');
    writeFileSync(
      scans,
      [
        tsv('ada', 1, 8793, 3),
        tsv('bo', 1, 8793, 4), // same observation, second scout
        tsv('ada', 2, 9143, 2),
      ].join('\n'),
    );
    cmd.ingest(ws, scans, PROFILES);

    const r = cmd.report(ws);
    assert.equal(r.code, 0);
    assert.match(r.text, /2 observations/);
    assert.match(r.text, /1 observation\(s\) have a second opinion/);
    assert.match(r.text, /●●/, 'double coverage is visible at a glance');

    const filtered = cmd.report(ws, 9143);
    assert.match(filtered.text, /1 observations/);
  } finally {
    s.cleanup();
  }
});

/* ------------------------------------------------------------ arg parsing -- */

test('the arg parser routes commands, honours --dir, and explains itself', async () => {
  const s = scratch();
  try {
    const help = await run([]);
    assert.equal(help.code, 0);
    assert.match(help.text, /courier init/);

    const unknown = await run(['frobnicate']);
    assert.equal(unknown.code, 1);
    assert.match(unknown.text, /unknown command/);

    const dir = join(s.dir, 'viaflag');
    const r = await run(['init', EVENT, 'pit-laptop', '--dir', dir]);
    assert.equal(r.code, 0);
    assert.ok(readFileSync(join(dir, 'device.key')).length > 0);

    const st = await run(['status', '--dir', dir]);
    assert.match(st.text, /pit-laptop/);
  } finally {
    s.cleanup();
  }
});

test('a command missing its arguments explains the shape rather than crashing', async () => {
  await assert.rejects(() => run(['init']), /usage: courier init/);
  await assert.rejects(() => run(['grant', 'only-one']), /usage: courier grant/);
});

/* ------------------------------------------------- losing the registry --- */

test('a store this device can no longer verify is never quietly rewritten', async () => {
  // The defect this exists for, reproduced end to end. store() discarded the
  // MergeResult, so every record whose signing key the registry could not
  // resolve was dropped with no count and no reason; writeStore() then
  // serialised the survivors, and both ingest and import call it
  // unconditionally. A flash-drive copy that missed registry.cbor makes EVERY
  // record unresolvable at once — including this device's own — and the next
  // ingest rewrote the store down to nothing, printing "store now holds 0
  // records" and exiting 0.
  const s = scratch();
  try {
    const wsDir = join(s.dir, 'ws');
    const ws = new Workspace(wsDir);
    cmd.init(ws, EVENT, 'pit-laptop');

    const scans = join(s.dir, 'scans.txt');
    writeFileSync(scans, [tsv('ada', 1, 8793, 3), tsv('bo', 1, 9143, 4), tsv('cy', 2, 8793, 5)].join('\n'));
    assert.equal(cmd.ingest(ws, scans, PROFILES).code, 0);
    assert.equal(ws.store().size, 3);
    const sizeBefore = readFileSync(ws.storePath).length;

    // The registry goes missing. Every record becomes unverifiable at once.
    rmSync(join(wsDir, 'registry.cbor'));
    const fresh = new Workspace(wsDir);
    assert.equal(fresh.store().size, 0, 'the fixture assumes nothing verifies');
    assert.equal(fresh.unloadable?.count, 3);

    // Ingesting again must NOT overwrite the file with the survivors.
    const scans2 = join(s.dir, 'scans2.txt');
    writeFileSync(scans2, tsv('di', 3, 1114, 6));
    const r = cmd.ingest(new Workspace(wsDir), scans2, PROFILES);
    assert.equal(r.code, 1, 'ingest destroyed the store and reported success');
    assert.match(r.text, /refusing to write/);
    assert.match(r.text, /still in the file/);
    assert.equal(readFileSync(ws.storePath).length, sizeBefore, 'the store was rewritten anyway');

    // And the records really are recoverable: restore the registry, and they
    // are all still there.
    cmd.init(new Workspace(join(s.dir, 'unused')), EVENT, 'x');
  } finally {
    s.cleanup();
  }
});

test('status says the records are unreadable rather than just counting them', () => {
  const s = scratch();
  try {
    const wsDir = join(s.dir, 'ws');
    const ws = new Workspace(wsDir);
    cmd.init(ws, EVENT, 'pit-laptop');
    const scans = join(s.dir, 'scans.txt');
    writeFileSync(scans, [tsv('ada', 1, 8793, 3), tsv('bo', 1, 9143, 4)].join('\n'));
    cmd.ingest(ws, scans, PROFILES);

    const clean = cmd.status(new Workspace(wsDir));
    assert.match(clean.text, /records     2$/m, 'a healthy store should read plainly');

    rmSync(join(wsDir, 'registry.cbor'));
    const broken = cmd.status(new Workspace(wsDir));
    // "records 2" on its own is the reassuring line that let a day disappear.
    assert.match(broken.text, /records     2 \(0 readable\)/);
    assert.match(broken.text, /cannot be verified against the current registry/);
    assert.match(broken.text, /nothing has been lost yet/);
  } finally {
    s.cleanup();
  }
});

test('a restored registry brings every record back', () => {
  // The claim the refusal rests on: the records are still in the file, so this
  // is recoverable as long as nothing rewrites it.
  const s = scratch();
  try {
    const wsDir = join(s.dir, 'ws');
    const ws = new Workspace(wsDir);
    cmd.init(ws, EVENT, 'pit-laptop');
    const scans = join(s.dir, 'scans.txt');
    writeFileSync(scans, [tsv('ada', 1, 8793, 3), tsv('bo', 1, 9143, 4)].join('\n'));
    cmd.ingest(ws, scans, PROFILES);

    const registryPath = join(wsDir, 'registry.cbor');
    const saved = readFileSync(registryPath);
    rmSync(registryPath);
    assert.equal(new Workspace(wsDir).store().size, 0);

    writeFileSync(registryPath, saved);
    const back = new Workspace(wsDir);
    assert.equal(back.store().size, 2, 'the records did not come back');
    assert.equal(back.unloadable, null);
  } finally {
    s.cleanup();
  }
});

test('export refuses rather than overwriting a backup with an empty bundle', () => {
  // A bundle is what people hand to each other and what they keep as a backup.
  // Writing an empty one at exit 0 under the text "Copy it anywhere" is the
  // same data loss as rewriting the store, aimed at the destination instead.
  const s = scratch();
  try {
    const wsDir = join(s.dir, 'ws');
    const ws = new Workspace(wsDir);
    cmd.init(ws, EVENT, 'pit-laptop');
    const scans = join(s.dir, 'scans.txt');
    writeFileSync(scans, [tsv('ada', 1, 8793, 3), tsv('bo', 1, 9143, 4)].join('\n'));
    cmd.ingest(ws, scans, PROFILES);

    const backup = join(s.dir, 'good.courier');
    assert.equal(cmd.exportBundle(new Workspace(wsDir), backup).code, 0);
    const goodSize = readFileSync(backup).length;

    rmSync(join(wsDir, 'registry.cbor'));
    const r = cmd.exportBundle(new Workspace(wsDir), backup);
    assert.equal(r.code, 1);
    assert.match(r.text, /refusing to export/);
    assert.match(r.text, /overwrite a good copy/);
    assert.equal(readFileSync(backup).length, goodSize, 'the backup was overwritten anyway');
  } finally {
    s.cleanup();
  }
});

test('report refuses a team argument that is not a team number', async () => {
  // Number('abc') is NaN and NaN !== every team, so this used to filter out
  // every record and print a plausible-looking summary of an empty event at
  // exit 0.
  const s = scratch();
  try {
    const wsDir = join(s.dir, 'ws');
    const ws = new Workspace(wsDir);
    cmd.init(ws, EVENT, 'pit-laptop');
    const scans = join(s.dir, 'scans.txt');
    writeFileSync(scans, [tsv('ada', 1, 8793, 3), tsv('bo', 1, 9143, 4)].join('\n'));
    cmd.ingest(ws, scans, PROFILES);

    await assert.rejects(() => run(['report', 'frc8793', '--dir', wsDir]), /not a team number/);
    // And the real forms still work.
    assert.equal((await run(['report', '8793', '--dir', wsDir])).code, 0);
    assert.equal((await run(['report', '--dir', wsDir])).code, 0);
  } finally {
    s.cleanup();
  }
});
