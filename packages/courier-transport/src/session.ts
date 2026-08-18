/**
 * Driving anti-entropy over a Link.
 *
 * @courier/core's `reconcile()` runs both sides in one process, which is right
 * for tests but not for anything real. This is the asynchronous, one-sided
 * driver: it owns one store and one link, and it terminates cleanly whether the
 * peer finishes, hangs up, or walks out of range mid-transfer.
 *
 * The last case is the normal one on an event floor, and the design tolerates
 * it structurally rather than by retrying: the store is grow-only, so a session
 * that dies halfway has simply transferred fewer records. Nothing is corrupted,
 * nothing needs rolling back, and the next session starts from wherever both
 * sides have got to.
 */

import {
  AntiEntropySession,
  encodeSyncMessage,
  decodeSyncMessage,
  type RecordStore,
  type KeyResolver,
  type SyncMessage,
} from '@courier/core';
import { LinkClosedError, type Link } from './link.ts';

export type SyncRole = 'initiator' | 'responder';

export type SyncEnding =
  | 'complete'
  | 'peer-hung-up'
  | 'peer-silent'
  | 'round-limit'
  | 'protocol-error';

export interface SyncOutcome {
  readonly ending: SyncEnding;
  readonly rounds: number;
  readonly admitted: number;
  readonly duplicates: number;
  readonly rejected: number;
  readonly bytesSent: number;
  readonly bytesReceived: number;
  /** Set when `ending` is 'protocol-error'. */
  readonly error?: string;
}

export interface SyncOptions {
  /** Hard cap on messages, so a hostile or buggy peer cannot spin forever. */
  readonly maxRounds?: number;
  /** Abort a session that exceeds this many bytes received. */
  readonly maxBytes?: number;
  /**
   * Give up when a peer goes quiet for this long. See DEFAULT_RECEIVE_TIMEOUT.
   *
   * Pass 0 to wait forever, which is only ever right in a test that drives both
   * sides itself and can guarantee somebody eventually speaks.
   */
  readonly receiveTimeoutMs?: number;
  readonly onProgress?: (rounds: number, admitted: number) => void;
}

const DEFAULT_MAX_ROUNDS = 24;
const DEFAULT_MAX_BYTES = 32 * 1024 * 1024;

/**
 * How long to wait for a peer that has stopped speaking. Derived, not picked.
 *
 * maxRounds and maxBytes stop a peer that spins or floods. Neither stops the
 * commoner failure: somebody walks out of range mid-sync and the radio has not
 * noticed yet. A BLE supervision timeout can take tens of seconds, and until it
 * fires nothing resolves `receive()` — so the sync sits there, and with it the
 * gossip schedule that was meant to try somebody else.
 *
 * The floor is one worst-case frame. MAX_RECORDS_PER_MESSAGE is 32, records
 * measure 186-1215 bytes on the wire (MEASUREMENTS.md §1) so a full frame is
 * ~6-39 kB, and at the design's assumed 12 kB/s for the slowest BLE path that
 * is 0.5-3.3 s, plus the peer's own verify time — MEASUREMENTS.md §4 puts 32
 * records at ~55 ms. Call the realistic worst case 5 s.
 *
 * The ceiling is the gossip schedule: D-11 sets anti-entropy at 20 s, and a
 * session that has been silent for longer than that is holding up a round it
 * should have yielded. 15 s sits between the two with room on both sides, and
 * matches the BLE link's own ready timeout, which answers the same question one
 * layer down.
 *
 * Ending the session is cheap and correct: the store is grow-only, so whatever
 * arrived is kept, and the next round re-reconciles only the remaining
 * difference. There is nothing to roll back.
 */
export const DEFAULT_RECEIVE_TIMEOUT = 15_000;

/**
 * Receive, or give up after `ms`.
 *
 * The timer is deliberately not unref'd — see the note in GattLink#awaitReady.
 * A guard that switches itself off when it is the only thing left in the event
 * loop is not a guard, and that is exactly the stalled-peer case.
 */
async function receiveWithin(link: Link, ms: number): Promise<Uint8Array | null | 'timeout'> {
  if (ms <= 0) return link.receive();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      link.receive(),
      new Promise<'timeout'>((resolve) => {
        timer = setTimeout(() => resolve('timeout'), ms);
      }),
    ]);
  } finally {
    // Always, including when receive() won the race, or the process holds the
    // loop open for the full timeout after every single frame.
    if (timer !== undefined) clearTimeout(timer);
  }
}

export async function syncOverLink(
  store: RecordStore,
  resolveKey: KeyResolver,
  link: Link,
  role: SyncRole,
  opts: SyncOptions = {},
): Promise<SyncOutcome> {
  const maxRounds = opts.maxRounds ?? DEFAULT_MAX_ROUNDS;
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
  const receiveTimeout = opts.receiveTimeoutMs ?? DEFAULT_RECEIVE_TIMEOUT;

  const session = new AntiEntropySession(store, resolveKey);
  let rounds = 0;
  let bytesSent = 0;
  let bytesReceived = 0;

  const finish = (ending: SyncEnding, error?: string): SyncOutcome => ({
    ending,
    rounds,
    admitted: session.stats.admitted,
    duplicates: session.stats.duplicates,
    rejected: session.stats.rejected,
    bytesSent,
    bytesReceived,
    ...(error ? { error } : {}),
  });

  const send = async (msg: SyncMessage): Promise<boolean> => {
    const wire = encodeSyncMessage(msg);
    try {
      await link.send(wire);
    } catch (err) {
      if (err instanceof LinkClosedError) return false;
      throw err;
    }
    bytesSent += wire.length;
    rounds++;
    opts.onProgress?.(rounds, session.stats.admitted);
    return true;
  };

  try {
    if (role === 'initiator') {
      if (!(await send(session.start()))) return finish('peer-hung-up');
    }

    while (rounds < maxRounds) {
      const received = await receiveWithin(link, receiveTimeout);
      if (received === 'timeout') {
        // Distinct from 'peer-hung-up' on purpose. A hang-up is a peer saying
        // it is done; silence is a peer that may not know it is gone. The
        // caller wants to retry the second one sooner, and a diagnostics screen
        // wants to show them differently.
        await link.close();
        return finish('peer-silent', `no frame for ${receiveTimeout} ms`);
      }
      const wire = received;
      if (wire === null) {
        // A clean end and a dropped link are indistinguishable from here, and
        // deliberately so — both mean "no more records are coming right now",
        // and both leave the store in a valid state.
        return finish('peer-hung-up');
      }

      bytesReceived += wire.length;
      if (bytesReceived > maxBytes) {
        return finish('protocol-error', `peer sent more than ${maxBytes} bytes`);
      }

      let msg: SyncMessage;
      try {
        msg = decodeSyncMessage(wire);
      } catch (err) {
        // A frame that will not decode is either corruption or a hostile peer.
        // Either way the session is over; the store is untouched.
        return finish('protocol-error', `undecodable frame: ${(err as Error).message}`);
      }

      const reply = session.receive(msg);
      if (reply === null) {
        await link.close();
        return finish('complete');
      }
      if (!(await send(reply))) return finish('peer-hung-up');
    }

    return finish('round-limit');
  } catch (err) {
    return finish('protocol-error', (err as Error).message);
  } finally {
    await link.close().catch(() => {});
  }
}

/** Run both ends of a paired link concurrently. Used by tests and the simulator. */
export async function syncBothEnds(
  a: { store: RecordStore; link: Link },
  b: { store: RecordStore; link: Link },
  resolveKey: KeyResolver,
  opts: SyncOptions = {},
): Promise<[SyncOutcome, SyncOutcome]> {
  return Promise.all([
    syncOverLink(a.store, resolveKey, a.link, 'initiator', opts),
    syncOverLink(b.store, resolveKey, b.link, 'responder', opts),
  ]);
}
