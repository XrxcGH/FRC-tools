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

export type SyncEnding = 'complete' | 'peer-hung-up' | 'round-limit' | 'protocol-error';

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
  readonly onProgress?: (rounds: number, admitted: number) => void;
}

const DEFAULT_MAX_ROUNDS = 24;
const DEFAULT_MAX_BYTES = 32 * 1024 * 1024;

export async function syncOverLink(
  store: RecordStore,
  resolveKey: KeyResolver,
  link: Link,
  role: SyncRole,
  opts: SyncOptions = {},
): Promise<SyncOutcome> {
  const maxRounds = opts.maxRounds ?? DEFAULT_MAX_ROUNDS;
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;

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
      const wire = await link.receive();
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
