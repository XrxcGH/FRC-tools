/**
 * Anti-entropy: converge two stores over a link that may drop at any moment.
 *
 * Peers exchange a root digest; where digests differ they descend only into the
 * disagreeing subtrees, and at the leaves they exchange truncated id lists and
 * then the records themselves. Cost scales with the size of the difference, not
 * the size of the set — which is why this replaced IBLT (D-3): an IBLT must be
 * sized from an estimate of the symmetric difference, the very quantity being
 * discovered.
 *
 * Messages are CBOR-encoded with the same canonical codec as records, so the
 * byte counts this module reports are real wire sizes rather than estimates.
 * That matters: FR-4's budget ("≤2 round-trips and ≤8 kB for a 50-envelope
 * symmetric difference") is a claim that has to be measurable to be honest.
 */

import { encode, decode, expectArray, expectMap, expectBytes, expectText, expectUint } from './cbor.ts';
import type { CborKey, CborValue } from './cbor.ts';
import { compareBytes } from './cbor.ts';
import { toHex } from './hash.ts';
import { RecordStore } from './store.ts';
import type { KeyResolver } from './envelope.ts';
import {
  childDigests,
  digestsEqual,
  idsWithPrefix,
  rangeDigest,
  type DigestNode,
} from './digest.ts';

/**
 * Id lists carry 8-byte truncated record ids rather than the full 32.
 *
 * At event scale (~640 records) a 64-bit prefix has a collision probability
 * around 2^-45 — far below the probability of the tablet being dropped. The
 * saving is what makes the 8 kB round-trip budget reachable: 40 ids per leaf
 * bucket costs 320 bytes truncated versus 1,280 in full.
 */
export const ID_PREFIX_BYTES = 8;

/**
 * Descend no further once both sides' counts for a range sum to this or less.
 *
 * Derived from the transport, not picked by feel. Descending one level costs an
 * extra round trip; on BLE, connection setup and the round-trip itself run
 * ~1.5-2 s, while an id list of N entries costs N x 9 bytes — about 0.75 ms per
 * entry at the 12 kB/s figure the design uses for the iOS-peripheral GATT path.
 * Descending is therefore only worth it once the id list would exceed roughly
 * 2,000 entries.
 *
 * At 2048 a full event day (~640 records per side, 1,280 combined) skips the
 * descent entirely and reconciles in two round trips, which is what FR-4
 * requires. A laptop holding several events still descends, which is what the
 * hierarchy is for. Lower this and the round-trip count goes up; raise it and
 * the first reply grows without bound.
 */
export const LEAF_THRESHOLD = 2048;

/** 16^6 buckets; a depth this deep means pathological id clustering. */
export const MAX_DEPTH = 6;

export interface IdList {
  readonly prefix: string;
  /** Truncated ids, ID_PREFIX_BYTES each. */
  readonly ids: readonly Uint8Array[];
}

export interface SyncMessage {
  readonly digests?: readonly DigestNode[];
  readonly idLists?: readonly IdList[];
  readonly want?: readonly Uint8Array[];
  readonly records?: readonly Uint8Array[];
}

export interface SyncStats {
  rounds: number;
  bytes: number;
  admitted: number;
  duplicates: number;
  rejected: number;
}

const M_DIGESTS = 1;
const M_IDLISTS = 2;
const M_WANT = 3;
const M_RECORDS = 4;

export function isEmptyMessage(m: SyncMessage): boolean {
  return (
    !m.digests?.length && !m.idLists?.length && !m.want?.length && !m.records?.length
  );
}

/* -------------------------------------------------------------------------- */
/* Wire encoding                                                               */
/* -------------------------------------------------------------------------- */

export function encodeSyncMessage(m: SyncMessage): Uint8Array {
  const map = new Map<CborKey, CborValue>();
  if (m.digests?.length) {
    map.set(
      M_DIGESTS,
      m.digests.map((d) => [d.prefix, d.count, d.xor] as CborValue),
    );
  }
  if (m.idLists?.length) {
    map.set(
      M_IDLISTS,
      m.idLists.map((l) => [l.prefix, l.ids as CborValue[]] as CborValue),
    );
  }
  if (m.want?.length) map.set(M_WANT, m.want as CborValue[]);
  if (m.records?.length) map.set(M_RECORDS, m.records as CborValue[]);
  return encode(map);
}

export function decodeSyncMessage(bytes: Uint8Array): SyncMessage {
  const map = expectMap(decode(bytes), 'sync message');
  const out: {
    digests?: DigestNode[];
    idLists?: IdList[];
    want?: Uint8Array[];
    records?: Uint8Array[];
  } = {};

  const d = map.get(M_DIGESTS);
  if (d !== undefined) {
    out.digests = expectArray(d, 'digests').map((n) => {
      const a = expectArray(n, 'digest node');
      return {
        prefix: expectText(a[0], 'digest prefix'),
        count: expectUint(a[1], 'digest count'),
        xor: expectBytes(a[2], 'digest xor'),
      };
    });
  }

  const l = map.get(M_IDLISTS);
  if (l !== undefined) {
    out.idLists = expectArray(l, 'id lists').map((n) => {
      const a = expectArray(n, 'id list');
      return {
        prefix: expectText(a[0], 'id list prefix'),
        ids: expectArray(a[1], 'id list ids').map((x) =>
          expectBytes(x, 'truncated id', ID_PREFIX_BYTES),
        ),
      };
    });
  }

  const w = map.get(M_WANT);
  if (w !== undefined) {
    out.want = expectArray(w, 'want').map((x) => expectBytes(x, 'truncated id', ID_PREFIX_BYTES));
  }

  const r = map.get(M_RECORDS);
  if (r !== undefined) {
    out.records = expectArray(r, 'records').map((x) => expectBytes(x, 'envelope'));
  }

  return out;
}

export function messageSize(m: SyncMessage): number {
  return encodeSyncMessage(m).length;
}

/* -------------------------------------------------------------------------- */
/* Session                                                                     */
/* -------------------------------------------------------------------------- */

const trunc = (id: Uint8Array): Uint8Array => id.slice(0, ID_PREFIX_BYTES);

export class AntiEntropySession {
  readonly #store: RecordStore;
  readonly #resolveKey: KeyResolver;
  readonly stats: SyncStats = { rounds: 0, bytes: 0, admitted: 0, duplicates: 0, rejected: 0 };

  constructor(store: RecordStore, resolveKey: KeyResolver) {
    this.#store = store;
    this.#resolveKey = resolveKey;
  }

  /** Opening move: the root digest over the whole id space. */
  start(): SyncMessage {
    return { digests: [rangeDigest(this.#store.sortedIds, '')] };
  }

  /** Index from truncated id to full id, for resolving `want` entries. */
  #truncIndex(): Map<string, Uint8Array> {
    const m = new Map<string, Uint8Array>();
    for (const id of this.#store.sortedIds) m.set(toHex(trunc(id)), id);
    return m;
  }

  /**
   * Process a peer message and produce the reply, or null when there is
   * nothing left to say — which is how the session terminates.
   */
  receive(msg: SyncMessage): SyncMessage | null {
    this.stats.rounds++;

    // 1. Absorb anything the peer sent. Do this first so subsequent digest
    //    comparisons in this same message reflect the newly-admitted records.
    if (msg.records?.length) {
      for (const env of msg.records) {
        const r = this.#store.admit(env, this.#resolveKey);
        if (r.status === 'admitted') this.stats.admitted++;
        else if (r.status === 'duplicate') this.stats.duplicates++;
        else this.stats.rejected++;
      }
    }

    const outDigests: DigestNode[] = [];
    const outIdLists: IdList[] = [];
    const outWant: Uint8Array[] = [];
    const outRecords: Uint8Array[] = [];

    // 2. Serve explicit requests.
    if (msg.want?.length) {
      const index = this.#truncIndex();
      const full: Uint8Array[] = [];
      for (const t of msg.want) {
        const id = index.get(toHex(t));
        if (id) full.push(id);
      }
      outRecords.push(...this.#store.envelopesFor(full));
    }

    // 3. Compare digests; descend or switch to id lists at the leaves.
    for (const theirs of msg.digests ?? []) {
      const mine = rangeDigest(idsWithPrefix(this.#store.sortedIds, theirs.prefix), theirs.prefix);
      if (digestsEqual(mine, theirs)) continue;

      const small = mine.count + theirs.count <= LEAF_THRESHOLD;
      if (small || theirs.prefix.length >= MAX_DEPTH) {
        outIdLists.push({
          prefix: theirs.prefix,
          ids: idsWithPrefix(this.#store.sortedIds, theirs.prefix).map(trunc),
        });
      } else {
        // Send only the children that could possibly differ. We cannot know
        // which those are without the peer's children, so send all 16 — each
        // is 35 bytes, and this is what buys the shallow round-trip count.
        outDigests.push(...childDigests(this.#store.sortedIds, theirs.prefix));
      }
    }

    // 4. Diff id lists both ways: ask for what we lack, push what they lack.
    for (const list of msg.idLists ?? []) {
      const theirs = new Set(list.ids.map((t) => toHex(t)));
      const mine = idsWithPrefix(this.#store.sortedIds, list.prefix);
      const mineTrunc = new Set(mine.map((id) => toHex(trunc(id))));

      for (const t of list.ids) {
        if (!mineTrunc.has(toHex(t))) outWant.push(t);
      }
      const give = mine.filter((id) => !theirs.has(toHex(trunc(id))));
      outRecords.push(...this.#store.envelopesFor(give));
    }

    const reply: SyncMessage = {
      ...(outDigests.length ? { digests: outDigests } : {}),
      ...(outIdLists.length ? { idLists: outIdLists } : {}),
      ...(outWant.length ? { want: dedupeBytes(outWant) } : {}),
      ...(outRecords.length ? { records: dedupeBytes(outRecords) } : {}),
    };

    if (isEmptyMessage(reply)) return null;
    this.stats.bytes += messageSize(reply);
    return reply;
  }
}

function dedupeBytes(items: Uint8Array[]): Uint8Array[] {
  const seen = new Set<string>();
  const out: Uint8Array[] = [];
  for (const b of items) {
    const k = toHex(b);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(b);
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/* Driver                                                                      */
/* -------------------------------------------------------------------------- */

export interface ReconcileResult extends SyncStats {
  converged: boolean;
  /** Wire bytes in each direction, in order, for budget checking. */
  messageSizes: number[];
}

/**
 * Run a full session between two stores, alternating turns. Used by tests and
 * by the simulator; a real transport drives the same two sessions across BLE
 * or a USB file instead of in memory.
 */
export function reconcile(
  a: RecordStore,
  b: RecordStore,
  resolveKey: KeyResolver,
  maxRounds = 16,
): ReconcileResult {
  const sa = new AntiEntropySession(a, resolveKey);
  const sb = new AntiEntropySession(b, resolveKey);

  const sizes: number[] = [];
  let msg: SyncMessage | null = sa.start();
  let current = sb;
  let rounds = 0;

  while (msg && rounds < maxRounds) {
    // Every message crosses the wire encoded, so measure it there.
    const wire = encodeSyncMessage(msg);
    sizes.push(wire.length);
    rounds++;
    msg = current.receive(decodeSyncMessage(wire));
    current = current === sb ? sa : sb;
  }

  return {
    rounds,
    bytes: sizes.reduce((x, y) => x + y, 0),
    admitted: sa.stats.admitted + sb.stats.admitted,
    duplicates: sa.stats.duplicates + sb.stats.duplicates,
    rejected: sa.stats.rejected + sb.stats.rejected,
    converged: msg === null,
    messageSizes: sizes,
  };
}

/** True when two stores hold exactly the same set of record ids. */
export function storesConverged(a: RecordStore, b: RecordStore): boolean {
  if (a.size !== b.size) return false;
  const ai = a.sortedIds;
  const bi = b.sortedIds;
  for (let i = 0; i < ai.length; i++) {
    if (compareBytes(ai[i]!, bi[i]!) !== 0) return false;
  }
  return true;
}
