/**
 * The device key registry — who this device will accept records from.
 *
 * A record is only as trustworthy as the resolver that maps its key id to a
 * public key. `openEnvelope` does the cryptography; this decides the policy.
 */

import {
  encode,
  decode,
  expectMap,
  expectArray,
  expectBytes,
  expectText,
  expectUint,
  deriveKeyId,
  toHex,
  type CborKey,
  type CborValue,
  type KeyBacking,
  type KeyResolver,
} from '@courier/core';

export interface RegisteredKey {
  readonly kid: Uint8Array;
  readonly publicKey: Uint8Array;
  readonly backing: KeyBacking;
  /** Operator-chosen, non-name label. Never a student's name (D-20). */
  readonly label: string;
  readonly addedAt: number;
  readonly revokedAt?: number;
  readonly revokedReason?: string;
}

export class RegistryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RegistryError';
  }
}

/**
 * ── On revocation, and what it actually costs ───────────────────────────────
 *
 * Revoking a key stops this device accepting ANY record signed by it, including
 * records it would otherwise have accepted yesterday. There is no way to do
 * better: `sealedAt` is self-asserted by the sealing device, and a device with a
 * wrong clock is a routine field condition, so "reject anything signed after
 * time T" is not a decision this system can make honestly.
 *
 * The consequence is worth stating plainly, because it is easy to reach for
 * revocation and get a surprise:
 *
 *   - Records already admitted STAY. The store is grow-only and nothing here
 *     removes them.
 *   - Records not yet admitted are lost to peers that revoke. A scout's whole
 *     day can vanish from the mesh if their tablet is revoked before it syncs.
 *
 * So revoke a LOST or COMPROMISED device, where refusing its future records is
 * the point. Do not revoke a graduating student's device: stop using it. The
 * registry is a trust list, not a roster, and it holds no personal data — a
 * label like "pit-tablet-2" is the intended granularity.
 */
export class KeyRegistry {
  readonly #byKid = new Map<string, RegisteredKey>();

  static from(keys: Iterable<RegisteredKey>): KeyRegistry {
    const r = new KeyRegistry();
    for (const k of keys) r.add(k);
    return r;
  }

  get size(): number {
    return this.#byKid.size;
  }

  add(key: RegisteredKey): void {
    const expected = deriveKeyId(key.publicKey);
    if (toHex(expected) !== toHex(key.kid)) {
      throw new RegistryError(
        `key id ${toHex(key.kid)} does not match its public key (expected ${toHex(expected)})`,
      );
    }
    if (key.publicKey.length !== 32) throw new RegistryError('public key must be 32 bytes');
    if (!key.label) throw new RegistryError('a registered key needs a label');

    const hex = toHex(key.kid);
    const existing = this.#byKid.get(hex);
    if (existing && toHex(existing.publicKey) !== toHex(key.publicKey)) {
      // Cannot happen while kid is a hash of the key, but if it ever does it is
      // an attack or a corrupt registry, not something to resolve silently.
      throw new RegistryError(`key id collision for ${hex}`);
    }

    // Revocation is STICKY. `add` used to end in an unconditional set, and a
    // key arriving in a pairing grant roster carries no `revokedAt` — grantJoin
    // serialises only publicKey, backing, label and addedAt — so re-learning a
    // key you had revoked silently un-revoked it. Every later pairing round
    // trip was an opportunity for a device you had thrown out to walk back in,
    // and nothing said so.
    //
    // A kid is a hash of the public key, so the same kid IS the same key: there
    // is no legitimate reading of "add" that means "forgive". Un-revoking is a
    // deliberate local act and needs its own call, not a side effect of sync.
    if (existing?.revokedAt !== undefined && key.revokedAt === undefined) {
      this.#byKid.set(hex, {
        ...key,
        revokedAt: existing.revokedAt,
        ...(existing.revokedReason === undefined ? {} : { revokedReason: existing.revokedReason }),
      });
      return;
    }

    this.#byKid.set(hex, key);
  }

  get(kid: Uint8Array): RegisteredKey | undefined {
    return this.#byKid.get(toHex(kid));
  }

  has(kid: Uint8Array): boolean {
    const k = this.#byKid.get(toHex(kid));
    return k !== undefined && k.revokedAt === undefined;
  }

  revoke(kid: Uint8Array, reason: string, at: number = Date.now()): void {
    const hex = toHex(kid);
    const k = this.#byKid.get(hex);
    if (!k) throw new RegistryError(`cannot revoke unknown key ${hex}`);
    this.#byKid.set(hex, { ...k, revokedAt: at, revokedReason: reason });
  }

  list(): RegisteredKey[] {
    return [...this.#byKid.values()].sort((a, b) => a.addedAt - b.addedAt);
  }

  /** Keys eligible to appear in a pairing grant's roster. */
  active(): RegisteredKey[] {
    return this.list().filter((k) => k.revokedAt === undefined);
  }

  /** Devices whose signing key is software-backed, for an honest UI warning. */
  softwareBacked(): RegisteredKey[] {
    return this.active().filter((k) => k.backing === 'software');
  }

  /** The resolver to hand to `openEnvelope` / `RecordStore.admit`. */
  resolver(): KeyResolver {
    return (kid) => {
      const k = this.#byKid.get(toHex(kid));
      if (!k || k.revokedAt !== undefined) return undefined;
      return k.publicKey;
    };
  }

  /* ------------------------------------------------------------ persistence */

  serialize(): Uint8Array {
    return encode(
      new Map<CborKey, CborValue>([
        [1, 1], // format version
        [
          2,
          this.list().map(
            (k) =>
              [
                k.publicKey,
                k.backing === 'hardware' ? 1 : 0,
                k.label,
                k.addedAt,
                k.revokedAt ?? 0,
                k.revokedReason ?? '',
              ] as CborValue,
          ),
        ],
      ]),
    );
  }

  static deserialize(bytes: Uint8Array): KeyRegistry {
    const m = expectMap(decode(bytes), 'registry');
    const version = expectUint(m.get(1), 'registry version');
    if (version !== 1) throw new RegistryError(`unsupported registry version ${version}`);

    const r = new KeyRegistry();
    for (const entry of expectArray(m.get(2), 'registry keys')) {
      const e = expectArray(entry, 'registry key');
      const publicKey = expectBytes(e[0], 'public key', 32);
      const revokedAt = expectUint(e[4], 'revokedAt');
      const reason = expectText(e[5], 'revokedReason');
      r.add({
        kid: deriveKeyId(publicKey),
        publicKey,
        backing: expectUint(e[1], 'backing') === 1 ? 'hardware' : 'software',
        label: expectText(e[2], 'label'),
        addedAt: expectUint(e[3], 'addedAt'),
        ...(revokedAt > 0 ? { revokedAt, revokedReason: reason } : {}),
      });
    }
    return r;
  }
}
