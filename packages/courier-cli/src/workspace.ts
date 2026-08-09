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

import { readFileSync, writeFileSync, existsSync, mkdirSync, chmodSync } from 'node:fs';
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
import { KeyRegistry } from '@courier/pairing';
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

  registry(): KeyRegistry {
    if (!existsSync(this.#registryPath)) return new KeyRegistry();
    return KeyRegistry.deserialize(new Uint8Array(readFileSync(this.#registryPath)));
  }

  writeRegistry(r: KeyRegistry): void {
    writeFileSync(this.#registryPath, r.serialize());
  }

  store(): RecordStore {
    const store = new RecordStore();
    if (!existsSync(this.storePath)) return store;
    const bytes = new Uint8Array(readFileSync(this.storePath));
    if (bytes.length === 0) return store;
    mergeBundle(store, bytes, this.registry().resolver());
    return store;
  }

  writeStore(store: RecordStore): void {
    const mesh = existsSync(this.#meshPath) ? this.mesh() : null;
    writeFileSync(
      this.storePath,
      writeBundle(store, {
        eventKey: mesh?.eventKey ?? '0000none',
        producer: mesh?.label ?? 'unknown',
      }),
    );
  }

  /** Records held, without loading and verifying the whole store. */
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
    return [
      `workspace   ${this.dir}`,
      `event       ${m.eventKey}`,
      `device      ${m.label} (${toHex(d.kid).toUpperCase()}, ${d.backing}-backed)`,
      `mesh        ${r.active().length} active device(s), ${r.list().length - r.active().length} revoked`,
      `records     ${this.storeCount()}`,
    ].join('\n');
  }
}
