/**
 * The commands.
 *
 * Every command is a plain function over a Workspace and returns text, so the
 * whole CLI is testable without spawning a process or capturing stdout.
 *
 * Everything moves by FILE. There is no daemon, no port, and no radio here:
 * this is the sneakernet tool, and its job is to make "copy a file to a flash
 * drive and walk it to the pit" a supported workflow rather than a fallback.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import {
  RecordStore,
  toHex,
  matchLabel,
  type CourierRecord,
} from '@courier/core';
import {
  ingestBatch,
  loadProfileSet,
  type BridgeProfileSet,
} from '@courier/bridge';
import {
  createJoinRequest,
  grantJoin,
  acceptGrant,
  sasMatches,
  parseJoinRequest,
  KeyRegistry,
} from '@courier/pairing';
import { writeBundle, mergeBundle, readBundle } from '@courier/transport';
import { Workspace, WorkspaceError } from './workspace.ts';

export interface CommandResult {
  readonly text: string;
  /** Non-zero when the operator needs to act. */
  readonly code: number;
  /**
   * Notes that must NOT land in `text`.
   *
   * A command whose output is meant to be piped — `courier extract` writing CSV
   * to stdout — still has things the operator needs to read. Mixing them into
   * the data corrupts the file; dropping them hides that records were skipped.
   * They go to stderr.
   */
  readonly stderr?: string;
}

const ok = (text: string): CommandResult => ({ text, code: 0 });
const fail = (text: string): CommandResult => ({ text, code: 1 });

/* -------------------------------------------------------------------------- */

export function init(ws: Workspace, eventKey: string, label: string): CommandResult {
  if (!/^\d{4}[a-z0-9]{2,12}$/.test(eventKey)) {
    return fail(`"${eventKey}" does not look like an event key (e.g. 2027mose)`);
  }
  if (!label || label.length > 32) {
    return fail('a device label is required, at most 32 characters');
  }
  if (/^[A-Z][a-z]+$/.test(label)) {
    // Not a hard block — a team could legitimately have a device called "Blue"
    // — but the nudge is worth it, because the registry is not a roster.
    return fail(
      `"${label}" looks like a person's name. Label the DEVICE, not its owner ` +
        `("pit-laptop", "stands-tablet-3"). This project holds no personal data and the ` +
        `label is the one field where it could sneak in.`,
    );
  }

  const device = ws.init({ eventKey, label });
  return ok(
    [
      `Initialised ${ws.dir} for ${eventKey}.`,
      ``,
      `  device  ${label} (${toHex(device.kid).toUpperCase()})`,
      `  mesh    new — this device is the first member`,
      ``,
      `Other devices join with "courier join-request", which you admit using`,
      `"courier grant". Back up ${ws.dir}/device.key: records signed by a key you`,
      `lose stay verifiable only on peers that already accepted them.`,
    ].join('\n'),
  );
}

export function status(ws: Workspace): CommandResult {
  if (!ws.exists) return fail(`no workspace at ${ws.dir} — run "courier init" first`);

  const registry = ws.registry();
  const soft = registry.softwareBacked();
  const lines = [ws.describe()];

  if (soft.length > 0) {
    lines.push(
      ``,
      `${soft.length} device(s) hold software-backed keys: ${soft.map((k) => k.label).join(', ')}.`,
      `Their signing key is a file, not hardware. That is the honest state of affairs on`,
      `ChromeOS and the web, where no non-exportable keystore is available.`,
    );
  }
  return ok(lines.join('\n'));
}

/* ------------------------------------------------------------- pairing ---- */

export function joinRequest(ws: Workspace, outPath: string): CommandResult {
  const device = ws.device();
  const mesh = ws.mesh();
  const pending = createJoinRequest(device, mesh.label);

  writeFileSync(outPath, pending.requestBytes);
  writeFileSync(`${outPath}.secret`, pending.ephemeralSecret);
  return ok(
    [
      `Wrote a join request to ${outPath} (${pending.requestBytes.length} bytes).`,
      ``,
      `Show this to a device already in the mesh, which will produce a grant.`,
      `${outPath}.secret stays here and must not be shared — without it the grant`,
      `cannot be opened, which is exactly what makes a photograph of the request useless.`,
    ].join('\n'),
  );
}

export async function grant(ws: Workspace, requestPath: string, outPath: string): Promise<CommandResult> {
  const mesh = ws.mesh();
  const registry = ws.registry();
  const requestBytes = new Uint8Array(readFileSync(requestPath));

  const parsed = parseJoinRequest(requestBytes);
  const result = await grantJoin(requestBytes, {
    meshKey: mesh.meshKey,
    eventKey: mesh.eventKey,
    roster: registry.active(),
  });

  // STAGED, not trusted. The whole point of the spoken code is that it is
  // compared before anything is believed; writing the joiner into registry.cbor
  // here would trust an attacker who substituted a request the moment the
  // operator ran the command, and no printed advice about deleting the grant
  // would take it back out again.
  ws.stageAdmission(result.joiner, result.sas);
  writeFileSync(outPath, result.grantBytes);

  return ok(
    [
      `Grant for "${parsed.label}" (${toHex(result.joiner.kid).toUpperCase()}, ${parsed.backing}-backed)`,
      `written to ${outPath}.`,
      ``,
      `  Confirmation code:  ${result.sas}`,
      ``,
      `This device is NOT trusted yet. Read that code aloud; the joining device must`,
      `show the SAME six digits. Then run:`,
      ``,
      `  courier confirm ${result.sas} <the code they read back>`,
      ``,
      `That is what admits them. If the codes differ, run confirm anyway — it will`,
      `throw the staged key away rather than leaving it lying around.`,
    ].join('\n'),
  );
}

export async function accept(
  ws: Workspace,
  grantPath: string,
  requestPath: string,
): Promise<CommandResult> {
  const grantBytes = new Uint8Array(readFileSync(grantPath));
  const requestBytes = new Uint8Array(readFileSync(requestPath));
  const ephemeralSecret = new Uint8Array(readFileSync(`${requestPath}.secret`));

  const accepted = await acceptGrant(grantBytes, { requestBytes, ephemeralSecret });

  const registry = ws.registry();
  for (const k of accepted.roster) registry.add(k);
  ws.writeRegistry(registry);

  const device = ws.device();
  ws.writeMesh({
    meshKey: accepted.meshKey,
    eventKey: accepted.eventKey,
    label: ws.mesh().label,
  });

  return ok(
    [
      `Joined the mesh for ${accepted.eventKey}.`,
      ``,
      `  Confirmation code:  ${accepted.sas}`,
      ``,
      `This must match the admitting device's screen. If it does not, you are paired`,
      `with the wrong device — delete ${ws.dir} and start again.`,
      ``,
      // The registry count, not the roster length: the roster is what arrived,
      // and this device already trusted itself before any of it did.
      `  trusted  ${registry.active().length} device(s), including this one`,
      `  self     ${toHex(device.kid).toUpperCase()}`,
    ].join('\n'),
  );
}

/**
 * Compare the two spoken codes — and, on the admitting device, act on the answer.
 *
 * This is the commit point of the ceremony. `grant` stages the joiner and
 * trusts nothing; the key only enters registry.cbor here, and only when both
 * codes match each other AND match what this device actually computed. A
 * mismatch throws the staged key away rather than leaving it for someone to
 * commit later by accident.
 *
 * Checking against the staged code matters as much as checking the two against
 * each other: two operators who both mistype the same digits would otherwise
 * confirm a pairing neither device agrees with.
 */
export function confirm(ws: Workspace | null, a: string, b: string): CommandResult {
  const pending = ws?.exists ? ws.pendingAdmission() : null;

  if (!sasMatches(a, b)) {
    if (pending && ws) {
      ws.discardAdmission();
      return fail(
        'Codes DO NOT match. Someone substituted a request, or the two devices paired with\n' +
          'different partners.\n\n' +
          `The staged key for "${pending.key.label}" has been discarded and was never trusted.\n` +
          'Nothing to undo. Start the ceremony again.',
      );
    }
    return fail(
      'Codes DO NOT match. Someone substituted a QR code, or the two devices paired with\n' +
        'different partners. Delete the new workspace and start the ceremony again.',
    );
  }

  if (!pending || !ws) {
    // The joining side, or a device with nothing staged. A comparison is all
    // there is to do, and saying so beats implying something was admitted.
    return ok('Codes match. The pairing is genuine.');
  }

  if (!sasMatches(a, pending.sas)) {
    ws.discardAdmission();
    return fail(
      `Both codes read ${a}, but this device computed ${pending.sas}.\n\n` +
        'Matching each other is not enough — that only proves the two of you typed the same\n' +
        'thing. The staged key has been discarded. Start the ceremony again.',
    );
  }

  const registry = ws.registry();
  registry.add(pending.key);
  ws.writeRegistry(registry);
  ws.discardAdmission();

  return ok(
    [
      `Codes match. Admitted "${pending.key.label}" ` +
        `(${toHex(pending.key.kid).toUpperCase()}, ${pending.key.backing}-backed).`,
      ``,
      `Records signed by that device are accepted from now on.`,
    ].join('\n'),
  );
}

/* -------------------------------------------------------------- ingest ---- */

export function ingest(
  ws: Workspace,
  scansPath: string,
  profiles: BridgeProfileSet,
): CommandResult {
  const mesh = ws.mesh();
  const device = ws.device();
  const store = ws.store();

  const text = readFileSync(scansPath, 'utf8');
  const lines = text.split(/\r?\n/);

  const summary = ingestBatch(lines, {
    profiles,
    eventKey: mesh.eventKey,
    meshKey: mesh.meshKey,
    device,
  });

  let admitted = 0;
  const resolver = ws.registry().resolver();
  for (const env of summary.envelopes) {
    if (store.admit(env, resolver).status === 'admitted') admitted++;
  }
  ws.writeStore(store);

  const lines_ = [
    `Ingested ${scansPath}:`,
    ``,
    `  sealed          ${summary.sealed}`,
    `  admitted        ${admitted}`,
    `  duplicate scans ${summary.duplicateScan}`,
    `  unmatched       ${summary.unmatched}`,
    `  ambiguous       ${summary.ambiguous}`,
    `  wrong event     ${summary.wrongEvent}`,
    `  invalid         ${summary.invalid}`,
    `  blank           ${summary.blank}`,
    ``,
    `  store now holds ${store.size} records`,
  ];

  if (summary.scoutIdInBody) {
    lines_.push(
      ``,
      `Note: these payloads carry the scout's own identifier, so it is inside every`,
      `sealed body. The scout field is a pseudonym, but the raw value travels with the`,
      `record. Use handles rather than names.`,
    );
  }
  if (summary.unverifiedProfilesUsed.size > 0) {
    lines_.push(
      ``,
      `WARNING: used unverified profiles (${[...summary.unverifiedProfilesUsed].join(', ')}).`,
      `Their column positions have not been confirmed against real output from that app.`,
      `Check that a sealed record reads back the right team before trusting any of this.`,
    );
  }
  if (summary.reasons.length > 0) {
    lines_.push(``, `First few refusals:`, ...summary.reasons.slice(0, 3).map((r) => `  - ${r}`));
  }

  return ok(lines_.join('\n'));
}

/* -------------------------------------------------------------- bundles --- */

export function exportBundle(ws: Workspace, outPath: string): CommandResult {
  const mesh = ws.mesh();
  const store = ws.store();
  const bytes = writeBundle(store, { eventKey: mesh.eventKey, producer: mesh.label });
  writeFileSync(outPath, bytes);
  return ok(
    [
      `Wrote ${store.size} records to ${outPath} (${(bytes.length / 1024).toFixed(1)} kB).`,
      ``,
      `Copy it anywhere. Every record inside is individually signed, so this file is`,
      `exactly as safe to accept from a stranger as from yourself — and exactly as`,
      `readable, since v1 has no body encryption.`,
    ].join('\n'),
  );
}

export function importBundle(ws: Workspace, inPath: string): CommandResult {
  const mesh = ws.mesh();
  const store = ws.store();
  const bytes = new Uint8Array(readFileSync(inPath));

  const meta = readBundle(bytes);
  const result = mergeBundle(store, bytes, ws.registry().resolver(), mesh.eventKey);
  ws.writeStore(store);

  if (result.wrongEvent > 0) {
    return fail(
      `${inPath} is for event "${meta.eventKey}" but this workspace is for "${mesh.eventKey}".\n` +
        `Nothing was merged.`,
    );
  }

  const lines = [
    `Merged ${inPath} (from "${meta.producer}"):`,
    ``,
    `  admitted   ${result.admitted}`,
    `  duplicate  ${result.duplicates}`,
    `  rejected   ${result.rejected}`,
    ``,
    `  store now holds ${store.size} records`,
  ];
  if (result.rejected > 0) {
    lines.push(
      ``,
      `Rejected records were signed by keys this device does not trust. That is the`,
      `system working: pair with the device first, then merge again.`,
      ...result.reasons.slice(0, 3).map((r) => `  - ${r}`),
    );
  }
  return ok(lines.join('\n'));
}

/* ---------------------------------------------------------------- report -- */

export function report(ws: Workspace, team?: number): CommandResult {
  const store = ws.store();
  const mesh = ws.mesh();
  if (store.size === 0) return ok('No records yet.');

  const seen = new Map<string, { match: number; team: number; scouts: number }>();
  for (const id of store.sortedIds) {
    const r = store.get(id)!.record as CourierRecord;
    if (team !== undefined && r.team !== team) continue;
    const key = `${r.match}/${r.team}`;
    if (seen.has(key)) continue;
    seen.set(key, {
      match: r.match,
      team: r.team,
      scouts: store.currentForObservation(r.eventKey, r.match, r.team).length,
    });
  }

  const rows = [...seen.values()].sort((a, b) => a.match - b.match || a.team - b.team);
  const doubled = rows.filter((r) => r.scouts > 1).length;

  return ok(
    [
      `${mesh.eventKey} — ${store.size} records over ${rows.length} observations`,
      `${doubled} observation(s) have a second opinion.`,
      ``,
      ...rows.slice(0, 40).map((r) => `  ${matchLabel(r.match).padEnd(8)} ${String(r.team).padStart(5)}  ${'●'.repeat(r.scouts)}`),
      ...(rows.length > 40 ? [`  … ${rows.length - 40} more`] : []),
    ].join('\n'),
  );
}

export function verifyStore(ws: Workspace): CommandResult {
  // Rebuilding the store from its own bundle re-verifies every signature, which
  // is the cheapest honest integrity check available.
  const store = new RecordStore();
  const bytes = new Uint8Array(readFileSync(ws.storePath));
  const result = mergeBundle(store, bytes, ws.registry().resolver());

  if (result.rejected > 0) {
    return fail(
      `${result.rejected} of ${result.admitted + result.rejected} records FAILED verification.\n` +
        result.reasons.slice(0, 5).map((r) => `  - ${r}`).join('\n'),
    );
  }
  return ok(`All ${result.admitted} records verify against the current registry.`);
}

export { Workspace, WorkspaceError, loadProfileSet, KeyRegistry };
