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

import {
  encode,
  decode,
  expectArray,
  expectMap,
  expectBytes,
  expectText,
  expectUint,
  compareBytes,
  CborError,
} from './cbor.ts';
import type { CborKey, CborValue } from './cbor.ts';
import { toHex, HASH_BYTES } from './hash.ts';
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

/**
 * Records carried in a single message.
 *
 * Without a cap, a whole store travels in one frame — and a link that dies at
 * 7 s of an 8 s transfer then delivers NOTHING, because a message is atomic.
 * That silently falsifies the design's central robustness claim, which is that
 * a half-finished session is simply a smaller one. Chunking makes the claim
 * true: each frame that lands is progress that survives the link dropping.
 *
 * At ~270 B per envelope, 32 records is ~8.6 kB — roughly 0.7 s of airtime on
 * the slowest assumed BLE path, which is a reasonable amount of work to lose.
 */
export const MAX_RECORDS_PER_MESSAGE = 32;

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
  /**
   * Turn control for chunked transfers.
   *
   * `true` means "I have further frames queued — reply so I can send them."
   * `false` on a message with no content is a bare turn-return: nothing to say,
   * but the conversation is not over. Absent means an ordinary message.
   *
   * Without this a peer with nothing to add would answer the first chunk with
   * "done" and the remaining chunks would never be sent.
   */
  readonly more?: boolean;
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
const M_MORE = 5;

/** True when a message carries no protocol payload, ignoring turn control. */
export function hasContent(m: SyncMessage): boolean {
  return Boolean(m.digests?.length || m.idLists?.length || m.want?.length || m.records?.length);
}

/**
 * A message that ends the conversation: no content and no turn control.
 * A bare `{more: false}` is NOT empty — it hands the turn back.
 */
export function isEmptyMessage(m: SyncMessage): boolean {
  return !hasContent(m) && m.more === undefined;
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
  if (m.more !== undefined) map.set(M_MORE, m.more);
  return encode(map);
}

/**
 * Every peer-supplied field is bounded here.
 *
 * `store.admit` is carefully written so one malformed envelope cannot kill a
 * sync loop; the message decoder needs the same discipline. Without it a peer
 * sends `prefix: "zz"` and `prefixRange` throws a raw Error straight through
 * `receive`, or sends a 100k-character prefix and buys arbitrary work for a few
 * bytes.
 */
const PREFIX_RE = /^[0-9a-f]*$/;
const MAX_DIGESTS_PER_MESSAGE = 4096;
const MAX_IDLISTS_PER_MESSAGE = 256;
const MAX_IDS_PER_LIST = 100_000;
const MAX_WANT_PER_MESSAGE = 100_000;
const MAX_RECORDS_PER_INCOMING_MESSAGE = 4096;

function checkPrefix(p: string, what: string): string {
  if (p.length > MAX_DEPTH) {
    throw new CborError(`${what}: prefix "${p}" exceeds maximum depth ${MAX_DEPTH}`);
  }
  if (!PREFIX_RE.test(p)) {
    throw new CborError(`${what}: prefix "${p}" is not lowercase hex`);
  }
  return p;
}

function checkCount(n: number, max: number, what: string): void {
  if (n > max) throw new CborError(`${what}: ${n} exceeds the limit of ${max}`);
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
    const arr = expectArray(d, 'digests');
    checkCount(arr.length, MAX_DIGESTS_PER_MESSAGE, 'digests');
    out.digests = arr.map((n) => {
      const a = expectArray(n, 'digest node');
      return {
        prefix: checkPrefix(expectText(a[0], 'digest prefix'), 'digest'),
        count: expectUint(a[1], 'digest count'),
        xor: expectBytes(a[2], 'digest xor', HASH_BYTES),
      };
    });
  }

  const l = map.get(M_IDLISTS);
  if (l !== undefined) {
    const arr = expectArray(l, 'id lists');
    checkCount(arr.length, MAX_IDLISTS_PER_MESSAGE, 'id lists');
    out.idLists = arr.map((n) => {
      const a = expectArray(n, 'id list');
      const ids = expectArray(a[1], 'id list ids');
      checkCount(ids.length, MAX_IDS_PER_LIST, 'id list entries');
      return {
        prefix: checkPrefix(expectText(a[0], 'id list prefix'), 'id list'),
        ids: ids.map((x) => expectBytes(x, 'truncated id', ID_PREFIX_BYTES)),
      };
    });
  }

  const w = map.get(M_WANT);
  if (w !== undefined) {
    const arr = expectArray(w, 'want');
    checkCount(arr.length, MAX_WANT_PER_MESSAGE, 'want entries');
    out.want = arr.map((x) => expectBytes(x, 'truncated id', ID_PREFIX_BYTES));
  }

  const r = map.get(M_RECORDS);
  if (r !== undefined) {
    const arr = expectArray(r, 'records');
    checkCount(arr.length, MAX_RECORDS_PER_INCOMING_MESSAGE, 'records');
    out.records = arr.map((x) => expectBytes(x, 'envelope'));
  }

  const more = map.get(M_MORE);
  if (more !== undefined) {
    if (typeof more !== 'boolean') throw new Error('sync message: `more` must be a boolean');
    (out as { more?: boolean }).more = more;
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
  /** Envelopes owed to the peer but not yet sent, because of the per-message cap. */
  #pending: Uint8Array[] = [];
  readonly stats: SyncStats = { rounds: 0, bytes: 0, admitted: 0, duplicates: 0, rejected: 0 };

  constructor(store: RecordStore, resolveKey: KeyResolver) {
    this.#store = store;
    this.#resolveKey = resolveKey;
  }

  /** Opening move: the root digest over the whole id space. */
  start(): SyncMessage {
    return { digests: [rangeDigest(this.#store.sortedIds, '')] };
  }

  /**
   * Index from truncated id to EVERY full id sharing that prefix.
   *
   * It must be a multimap. A `Map<trunc, id>` keeps only the last record when
   * two ids share an 8-byte prefix, which makes the other one permanently
   * unreachable: `want` serves one of the pair, the id-list diff sees the
   * prefix present on both sides and never re-offers the sibling, and the two
   * stores then differ forever while the protocol falls silent.
   *
   * At event scale an accidental collision is ~2^-46, but a mesh member with a
   * valid key can grind ~2^32 bodies to mint a self-colliding pair, inject
   * both, and poison that leaf for every peer.
   */
  #truncIndex(): Map<string, Uint8Array[]> {
    const m = new Map<string, Uint8Array[]>();
    for (const id of this.#store.sortedIds) {
      const k = toHex(trunc(id));
      const list = m.get(k);
      if (list) list.push(id);
      else m.set(k, [id]);
    }
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

    // 2. Serve explicit requests. Every record sharing the wanted prefix goes,
    //    not just one, or a colliding sibling is never delivered.
    if (msg.want?.length) {
      const index = this.#truncIndex();
      const full: Uint8Array[] = [];
      for (const t of msg.want) {
        const ids = index.get(toHex(t));
        if (ids) full.push(...ids);
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
    //
    //    Compared as MULTISETS, not sets. Truncated ids are not record
    //    identities — two records can share an 8-byte prefix — so presence
    //    alone is not enough. When the counts for a prefix disagree, the side
    //    holding more sends all of its records for that prefix and lets the
    //    receiver deduplicate by record-id, which it does for free. Sending a
    //    record the peer already has costs one duplicate; failing to send one
    //    costs permanent divergence.
    for (const list of msg.idLists ?? []) {
      const theirCount = countByHex(list.ids);
      const mine = idsWithPrefix(this.#store.sortedIds, list.prefix);
      const mineCount = countByHex(mine.map(trunc));

      for (const [t, n] of theirCount) {
        if ((mineCount.get(t) ?? 0) < n) outWant.push(fromHexBytes(t));
      }
      const give = mine.filter((id) => {
        const t = toHex(trunc(id));
        return (theirCount.get(t) ?? 0) < (mineCount.get(t) ?? 0);
      });
      outRecords.push(...this.#store.envelopesFor(give));
    }

    // Queue records and release them a chunk at a time. A message is atomic, so
    // without this the whole transfer is all-or-nothing and a link that drops
    // near the end delivers nothing at all.
    if (outRecords.length) {
      this.#pending = dedupeBytes([...this.#pending, ...outRecords]);
    }
    const chunk = this.#pending.splice(0, MAX_RECORDS_PER_MESSAGE);

    const reply: SyncMessage = {
      ...(outDigests.length ? { digests: outDigests } : {}),
      ...(outIdLists.length ? { idLists: outIdLists } : {}),
      ...(outWant.length ? { want: dedupeBytes(outWant) } : {}),
      ...(chunk.length ? { records: chunk } : {}),
      ...(this.#pending.length ? { more: true } : {}),
    };

    if (!hasContent(reply)) {
      // Nothing to say. If the peer is still chunking, hand the turn back so it
      // can continue; otherwise the conversation is genuinely finished.
      if (msg.more === true) return { more: false };
      return null;
    }

    this.stats.bytes += messageSize(reply);
    return reply;
  }

  /** Envelopes queued for later frames. Exposed for progress UI and tests. */
  get pendingCount(): number {
    return this.#pending.length;
  }
}

function countByHex(items: readonly Uint8Array[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const b of items) {
    const k = toHex(b);
    m.set(k, (m.get(k) ?? 0) + 1);
  }
  return m;
}

function fromHexBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
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
  /** Both true: the exchange finished AND the two stores verifiably match. */
  converged: boolean;
  /** The exchange ran to a natural end rather than hitting the round cap. */
  quiet: boolean;
  /** The two stores hold the same set of record ids. Checked, not inferred. */
  setsEqual: boolean;
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
  // Generous, because chunked transfers legitimately take many frames: moving
  // 640 records at 32 per frame is 20 frames before any protocol overhead.
  maxRounds = 128,
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

  // `converged` is VERIFIED, never inferred from the conversation falling
  // silent. A protocol bug that strands a record makes both sides go quiet
  // while their sets still differ, and reporting that as success is how silent
  // data loss reaches a picklist.
  const quiet = msg === null;
  const equal = storesConverged(a, b);

  return {
    rounds,
    bytes: sizes.reduce((x, y) => x + y, 0),
    admitted: sa.stats.admitted + sb.stats.admitted,
    duplicates: sa.stats.duplicates + sb.stats.duplicates,
    rejected: sa.stats.rejected + sb.stats.rejected,
    converged: quiet && equal,
    quiet,
    setsEqual: equal,
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
