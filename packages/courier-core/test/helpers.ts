import {
  generateDeviceKey,
  generateMeshKey,
  mintScoutPseudonym,
  makeRecord,
  sealRecord,
  parseMatchKey,
  type DeviceKeyPair,
  type KeyResolver,
  type CourierRecord,
} from '../src/index.ts';
import { toHex } from '../src/hash.ts';

/** A team's mesh: some devices, a mesh key, and a resolver over the known keys. */
export class TestMesh {
  readonly meshKey = generateMeshKey();
  readonly devices = new Map<string, DeviceKeyPair>();

  device(name: string): DeviceKeyPair {
    let d = this.devices.get(name);
    if (!d) {
      d = generateDeviceKey('software');
      this.devices.set(name, d);
    }
    return d;
  }

  get resolver(): KeyResolver {
    return (kid) => {
      for (const d of this.devices.values()) {
        if (toHex(d.kid) === toHex(kid)) return d.publicKey;
      }
      return undefined;
    };
  }

  scout(name: string, eventKey: string): Uint8Array {
    return mintScoutPseudonym(name, eventKey, this.meshKey);
  }

  /** Seal an observation as `scoutName` from device `deviceName`. */
  seal(opts: {
    device: string;
    scout: string;
    matchKey: string;
    team: number;
    body: Uint8Array;
    schema?: string;
    sealedAt?: number;
    revision?: number;
    supersedes?: Uint8Array | null;
  }): { envelope: Uint8Array; record: CourierRecord } {
    const { eventKey, packed } = parseMatchKey(opts.matchKey);
    const record = makeRecord({
      eventKey,
      match: packed,
      team: opts.team,
      scout: this.scout(opts.scout, eventKey),
      schema: opts.schema ?? 'demo.scout.v1',
      body: opts.body,
      sealedAt: opts.sealedAt ?? 1_800_000_000_000,
      revision: opts.revision,
      supersedes: opts.supersedes ?? null,
    });
    return { envelope: sealRecord(record, this.device(opts.device)), record };
  }
}

/** A deterministic pseudo-random source, so failures reproduce. */
export function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s ^= s << 13;
    s >>>= 0;
    s ^= s >> 17;
    s ^= s << 5;
    s >>>= 0;
    return s / 0x100000000;
  };
}

/** A plausible scouting body: a few counters and flags, CBOR-ish but opaque to Courier. */
export function fakeBody(rand: () => number): Uint8Array {
  const b = new Uint8Array(12 + Math.floor(rand() * 40));
  for (let i = 0; i < b.length; i++) b[i] = Math.floor(rand() * 256);
  return b;
}
