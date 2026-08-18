/**
 * The on-disk workspace.
 *
 * Everything a device knows lives in one directory, which makes the whole state
 * of a Courier install copyable, inspectable, and — importantly for a tool
 * maintained by students who graduate — deletable without ceremony.
 *
 * Layout:
 *   device.key    the device's Ed25519 secret. The only secret that must not
 *                 leave this machine.
 *   mesh.cbor     mesh key, event key, and this device's label.
 *   registry.cbor the keys this device accepts records from.
 *   store.courier every record held, as a Courier bundle.
 *
 * The store is written as a bundle rather than a bespoke format so that the
 * on-disk file IS the thing you hand to someone else. There is no export step
 * and no way for the two to drift.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, chmodSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import {
  RecordStore,
  deviceKeyFromSecret,
  generateDeviceKey,
  generateMeshKey,
  encode,
  decode,
  expectMap,
  expectBytes,
  expectText,
  toHex,
  type CborKey,
  type CborValue,
  type DeviceKeyPair,
  type KeyBacking,
} from '@courier/core';
import { KeyRegistry, type RegisteredKey } from '@courier/pairing';
import { writeBundle, mergeBundle, readBundle } from '@courier/transport';

export const DEFAULT_DIR = '.courier';

export class WorkspaceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorkspaceError';
  }
}

export interface MeshConfig {
  readonly meshKey: Uint8Array;
  readonly eventKey: string;
  readonly label: string;
}

export class Workspace {
  readonly dir: string;

  constructor(dir: string = DEFAULT_DIR) {
    this.dir = dir;
  }

  get #devicePath(): string {
    return join(this.dir, 'device.key');
  }
  get #meshPath(): string {
    return join(this.dir, 'mesh.cbor');
  }
  get #registryPath(): string {
    return join(this.dir, 'registry.cbor');
  }
  get storePath(): string {
    return join(this.dir, 'store.courier');
  }

  get exists(): boolean {
    return existsSync(this.#devicePath);
  }

  /* ------------------------------------------------------------------ init */

  init(opts: { eventKey: string; label: string; backing?: KeyBacking }): DeviceKeyPair {
    if (this.exists) {
      throw new WorkspaceError(
        `${this.dir} is already initialised. Delete it to start over — but note that ` +
          `deleting device.key makes every record this device signed unverifiable to peers ` +
          `that have not already accepted them.`,
      );
    }
    mkdirSync(this.dir, { recursive: true });

    const device = generateDeviceKey(opts.backing ?? 'software');
    writeFileSync(this.#devicePath, device.secretKey);
    this.#restrictPermissions(this.#devicePath);

    this.writeMesh({ meshKey: generateMeshKey(), eventKey: opts.eventKey, label: opts.label });
    this.writeRegistry(
      KeyRegistry.from([
        {
          kid: device.kid,
          publicKey: device.publicKey,
          backing: device.backing,
          label: opts.label,
          addedAt: Date.now(),
        },
      ]),
    );
    this.writeStore(new RecordStore());
    return device;
  }

  #restrictPermissions(path: string): void {
    try {
      chmodSync(path, 0o600);
    } catch {
      // Windows and some filesystems do not honour POSIX modes. Not fatal, but
      // the caller should know the key is only as protected as the directory.
    }
  }

  /* --------------------------------------------------------------- reading */

  device(): DeviceKeyPair {
    if (!this.exists) throw new WorkspaceError(`no workspace at ${this.dir} — run "courier init"`);
    const secret = new Uint8Array(readFileSync(this.#devicePath));
    // Backing is a property of the key, recorded once in the registry entry for
    // our own key rather than re-asserted per use.
    const own = this.registry().get(deviceKeyFromSecret(secret).kid);
    return deviceKeyFromSecret(secret, own?.backing ?? 'software');
  }

  mesh(): MeshConfig {
    const m = expectMap(decode(new Uint8Array(readFileSync(this.#meshPath))), 'mesh config');
    return {
      meshKey: expectBytes(m.get(1), 'mesh key', 32),
      eventKey: expectText(m.get(2), 'event key'),
      label: expectText(m.get(3), 'label'),
    };
  }

  writeMesh(cfg: MeshConfig): void {
    writeFileSync(
      this.#meshPath,
      encode(
        new Map<CborKey, CborValue>([
          [1, cfg.meshKey],
          [2, cfg.eventKey],
          [3, cfg.label],
        ]),
      ),
    );
  }

  /* ------------------------------------------------- a staged admission --- */

  get #pendingPath(): string {
    return join(this.dir, 'pending-admission.cbor');
  }

  /**
   * A device that has been granted, but whose code has not been compared yet.
   *
   * It lives OUTSIDE the registry on purpose. `grant` used to add the joiner
   * and write registry.cbor before the six digits were even printed, so an
   * attacker who substituted a request was trusted the moment the operator ran
   * the command — and the printed remedy, "delete the grant and start again",
   * touches no registry. Nothing in the CLI could undo it: revoke exists in
   * @courier/pairing but is not routed, so the only real undo was deleting the
   * workspace, which also destroys device.key and every record held.
   *
   * Staged here, `confirm` commits it or throws it away.
   */
  stageAdmission(key: RegisteredKey, sas: string): void {
    writeFileSync(
      this.#pendingPath,
      encode(
        new Map<CborKey, CborValue>([
          [1, KeyRegistry.from([key]).serialize()],
          [2, sas],
        ]),
      ),
    );
  }

  pendingAdmission(): { key: RegisteredKey; sas: string } | null {
    if (!existsSync(this.#pendingPath)) return null;
    const m = expectMap(decode(new Uint8Array(readFileSync(this.#pendingPath))), 'pending admission');
    const key = KeyRegistry.deserialize(expectBytes(m.get(1), 'staged key')).list()[0];
    if (!key) return null;
    return { key, sas: expectText(m.get(2), 'staged code') };
  }

  discardAdmission(): void {
    if (existsSync(this.#pendingPath)) rmSync(this.#pendingPath, { force: true });
  }

  registry(): KeyRegistry {
    if (!existsSync(this.#registryPath)) return new KeyRegistry();
    return KeyRegistry.deserialize(new Uint8Array(readFileSync(this.#registryPath)));
  }

  writeRegistry(r: KeyRegistry): void {
    writeFileSync(this.#registryPath, r.serialize());
  }

  /**
   * Records the last load could NOT verify against the current registry.
   *
   * Loading is lossy by nature — a record whose signing key this device cannot
   * resolve is not admitted — and the loss used to be invisible: `store()`
   * discarded the MergeResult, `writeStore()` then serialised only the
   * survivors, and both `ingest` and `import` call it unconditionally. Losing
   * registry.cbor (a flash-drive copy that missed one file) makes every record
   * unresolvable at once, including this device's own, and the next ingest
   * rewrites the store down to nothing while printing "store now holds 0
   * records" and exiting 0.
   *
   * FR-3 says quarantine, never silently drop. This is the counter that makes
   * the difference sayable, and `writeStore` refuses to run while it is set.
   */
  #unloadable: { count: number; reasons: string[] } | null = null;

  get unloadable(): { count: number; reasons: string[] } | null {
    return this.#unloadable;
  }

  store(): RecordStore {
    const store = new RecordStore();
    this.#unloadable = null;
    if (!existsSync(this.storePath)) return store;
    const bytes = new Uint8Array(readFileSync(this.storePath));
    if (bytes.length === 0) return store;

    const held = readBundle(bytes).count;
    const merged = mergeBundle(store, bytes, this.registry().resolver());
    const lost = held - store.size;
    if (lost > 0) {
      this.#unloadable = { count: lost, reasons: merged.reasons.slice(0, 8) };
    }
    return store;
  }

  /**
   * Persist the store.
   *
   * Refuses while the last load dropped records, because writing would make the
   * loss permanent. `force` exists for a caller that has shown the operator
   * what is about to be discarded and been told to go ahead; nothing in the CLI
   * passes it today.
   */
  writeStore(store: RecordStore, opts: { force?: boolean } = {}): void {
    const lost = this.#unloadable;
    if (lost && !opts.force) {
      throw new WorkspaceError(
        `refusing to write ${this.storePath}: ${lost.count} record(s) in it could not be ` +
          `verified against the current registry, and writing would discard them permanently.\n` +
          (lost.reasons.length ? `  - ${lost.reasons.join('\n  - ')}\n` : '') +
          `Run "courier verify" for the full picture. The usual cause is a missing or ` +
          `incomplete registry.cbor — restore it and nothing is lost, because the records ` +
          `themselves are still in the file.`,
      );
    }
    const mesh = existsSync(this.#meshPath) ? this.mesh() : null;
    writeFileSync(
      this.storePath,
      writeBundle(store, {
        eventKey: mesh?.eventKey ?? '0000none',
        producer: mesh?.label ?? 'unknown',
      }),
    );
  }

  /**
   * Records held, without loading and verifying the whole store.
   *
   * This is the BUNDLE HEADER count, so it can exceed what `store()` admits.
   * That divergence is the point — it is how `status` can say "3 records held,
   * 3 of which this device cannot currently verify" instead of quietly
   * reporting 0 and letting the operator think their day never happened.
   */
  storeCount(): number {
    if (!existsSync(this.storePath)) return 0;
    const bytes = new Uint8Array(readFileSync(this.storePath));
    if (bytes.length === 0) return 0;
    return readBundle(bytes).count;
  }

  describe(): string {
    const d = this.device();
    const m = this.mesh();
    const r = this.registry();
    // Loading is what discovers unverifiable records, so do it before
    // reporting a count. "records 3" beside a store this device can no longer
    // read is the reassuring line that let a day of scouting disappear.
    const loaded = this.store().size;
    const held = this.storeCount();
    const lines = [
      `workspace   ${this.dir}`,
      `event       ${m.eventKey}`,
      `device      ${m.label} (${toHex(d.kid).toUpperCase()}, ${d.backing}-backed)`,
      `mesh        ${r.active().length} active device(s), ${r.list().length - r.active().length} revoked`,
      `records     ${held}${held === loaded ? '' : ` (${loaded} readable)`}`,
    ];
    const lost = this.unloadable;
    if (lost) {
      lines.push(
        ``,
        `${lost.count} record(s) in the store cannot be verified against the current registry.`,
        `They are still in the file and nothing has been lost yet — but ingest and import`,
        `will refuse to write until this is resolved, because writing would discard them.`,
        `The usual cause is a missing or incomplete registry.cbor. Run "courier verify".`,
      );
    }
    return lines.join('\n');
  }
}
