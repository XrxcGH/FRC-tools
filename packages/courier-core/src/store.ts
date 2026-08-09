/**
 * The record store: a grow-only set of verified records, held sorted by
 * record-id so the anti-entropy layer can take range digests over it.
 *
 * Grow-only is what makes the sync model sound. Replaying a valid signed record
 * into a grow-only set is genuinely idempotent, which is why v1 carries no
 * sequence-number replay defence (D-8) — a high-water-mark rule would be fatal
 * here, since out-of-order arrival is the NORMAL case under epidemic gossip and
 * a device hearing match 60 before match 55 would drop 55 permanently.
 *
 * Corrections append. A record with `supersedes` set does not remove the record
 * it replaces; both stay in the log and the view layer resolves which is
 * current. Anything that overwrites by primary key is destroying the audit
 * chain (spec/canonical-cbor.md §3).
 */

import { compareBytes } from './cbor.ts';
import { toHex } from './hash.ts';
import { openEnvelope, EnvelopeError, type KeyResolver } from './envelope.ts';
import { compareRecords, observationKey, type CourierRecord } from './record.ts';

export interface StoredRecord {
  readonly recordId: Uint8Array;
  readonly record: CourierRecord;
  /** The original signed bytes. Forwarded verbatim — never re-sealed. */
  readonly envelope: Uint8Array;
}

export type AdmitStatus = 'admitted' | 'duplicate' | 'rejected';

export interface AdmitResult {
  readonly status: AdmitStatus;
  readonly recordId?: Uint8Array;
  readonly reason?: string;
}

export interface StoreStats {
  readonly records: number;
  readonly observations: number;
  readonly bytes: number;
  readonly scouts: number;
}

export class RecordStore {
  readonly #byId = new Map<string, StoredRecord>();
  /** Sorted bytewise by record-id. The digest layer depends on this order. */
  readonly #sorted: Uint8Array[] = [];
  #bytes = 0;

  get size(): number {
    return this.#byId.size;
  }

  has(id: Uint8Array): boolean {
    return this.#byId.has(toHex(id));
  }

  get(id: Uint8Array): StoredRecord | undefined {
    return this.#byId.get(toHex(id));
  }

  /** Record ids in bytewise order. Do not mutate. */
  get sortedIds(): readonly Uint8Array[] {
    return this.#sorted;
  }

  /**
   * Verify an envelope and add it if new.
   *
   * Never throws for ordinary bad input — an event-day sync loop should not die
   * because one peer sent something malformed. Verification failures come back
   * as `rejected` with a reason for the diagnostics UI.
   */
  admit(envelope: Uint8Array, resolveKey: KeyResolver): AdmitResult {
    let opened;
    try {
      opened = openEnvelope(envelope, resolveKey);
    } catch (err) {
      if (err instanceof EnvelopeError) return { status: 'rejected', reason: err.message };
      return { status: 'rejected', reason: (err as Error).message };
    }

    const hex = toHex(opened.recordId);
    if (this.#byId.has(hex)) {
      return { status: 'duplicate', recordId: opened.recordId };
    }

    const stored: StoredRecord = {
      recordId: opened.recordId,
      record: opened.record,
      envelope: envelope.slice(),
    };
    this.#byId.set(hex, stored);
    this.#insertSorted(opened.recordId);
    this.#bytes += envelope.length;
    return { status: 'admitted', recordId: opened.recordId };
  }

  #insertSorted(id: Uint8Array): void {
    let lo = 0;
    let hi = this.#sorted.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (compareBytes(this.#sorted[mid]!, id) < 0) lo = mid + 1;
      else hi = mid;
    }
    this.#sorted.splice(lo, 0, id);
  }

  /**
   * All records for one observation, oldest revision first.
   * Multiple scouts observing the same robot all appear here — that is the
   * point, not a bug to be deduplicated away.
   */
  forObservation(eventKey: string, match: number, team: number): StoredRecord[] {
    const want = `${eventKey}/${match}/${team}`;
    const out: StoredRecord[] = [];
    for (const s of this.#byId.values()) {
      if (observationKey(s.record) === want) out.push(s);
    }
    return out.sort((a, b) => compareRecords(a.record, b.record));
  }

  /**
   * The current record from each scout for one observation, with superseded
   * revisions filtered out. One entry per scout — so a double-scouted match
   * still yields two, which is what the reliability model consumes.
   */
  currentForObservation(eventKey: string, match: number, team: number): StoredRecord[] {
    const all = this.forObservation(eventKey, match, team);
    const superseded = new Set<string>();
    for (const s of all) {
      if (s.record.supersedes) superseded.add(toHex(s.record.supersedes));
    }
    const byScout = new Map<string, StoredRecord>();
    for (const s of all) {
      if (superseded.has(toHex(s.recordId))) continue;
      const scout = toHex(s.record.scout);
      const prev = byScout.get(scout);
      if (!prev || compareRecords(s.record, prev.record) > 0) byScout.set(scout, s);
    }
    return [...byScout.values()];
  }

  stats(): StoreStats {
    const obs = new Set<string>();
    const scouts = new Set<string>();
    for (const s of this.#byId.values()) {
      obs.add(observationKey(s.record));
      scouts.add(toHex(s.record.scout));
    }
    return {
      records: this.#byId.size,
      observations: obs.size,
      bytes: this.#bytes,
      scouts: scouts.size,
    };
  }

  /** Envelopes for the given ids, skipping any this store does not hold. */
  envelopesFor(ids: readonly Uint8Array[]): Uint8Array[] {
    const out: Uint8Array[] = [];
    for (const id of ids) {
      const s = this.#byId.get(toHex(id));
      if (s) out.push(s.envelope);
    }
    return out;
  }
}
