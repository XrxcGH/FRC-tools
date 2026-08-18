/**
 * Links: running anti-entropy over something that is not memory.
 *
 * The reconciliation protocol in @courier/core is deliberately transport-
 * agnostic — it produces and consumes byte-framed messages and knows nothing
 * about how they travel. This module defines the seam, so that BLE, USB, a
 * file on a flash drive, or a test harness all plug into the same driver.
 *
 * The seam is narrow on purpose. Every predecessor to this project died of
 * cross-platform maintenance burden, and the way to keep that survivable is to
 * make the platform-specific surface as small as it can possibly be: open,
 * send a frame, receive a frame, close. Everything above it is portable
 * TypeScript that a student can read.
 */

export interface Frame {
  readonly bytes: Uint8Array;
}

/**
 * A bidirectional, message-oriented, ordered channel to exactly one peer.
 *
 * Message-oriented, not stream-oriented: implementations are responsible for
 * framing. BLE characteristics and file records are both naturally framed, and
 * pushing that concern down avoids a length-prefix parser in the shared layer.
 *
 * Ordering within a link is assumed. Delivery is NOT assumed — a link may drop
 * at any moment, which on an event floor is the normal case rather than an
 * exception. The protocol tolerates this because the store is grow-only: a
 * session that dies halfway has simply transferred fewer records, and the next
 * session picks up from wherever both sides now are.
 */
export interface Link {
  /** Resolves with the next message, or null once the peer is done or gone. */
  receive(): Promise<Uint8Array | null>;
  send(bytes: Uint8Array): Promise<void>;
  close(): Promise<void>;
  /** Human-facing label for diagnostics: "BLE 4A:2C…", "usb:/E/courier". */
  readonly label: string;
}

export class LinkError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LinkError';
  }
}

export class LinkClosedError extends LinkError {
  constructor(label: string) {
    super(`link ${label} closed`);
    this.name = 'LinkClosedError';
  }
}

/**
 * The send side gave up waiting for the stack to drain.
 *
 * Distinct from `LinkClosedError` for the same reason `peer-silent` is distinct
 * from `peer-hung-up`: a close is the peer saying it is done, a stall is a peer
 * that may not know it is gone. Both are ordinary on an event floor and neither
 * is a protocol error — throwing a bare `Error` for this made a device walking
 * out of range come back as "either corruption or a hostile peer".
 */
export class LinkStalledError extends LinkError {
  constructor(label: string, ms: number) {
    super(`link ${label} stalled for ${ms} ms waiting for the stack to drain`);
    this.name = 'LinkStalledError';
  }
}

/* -------------------------------------------------------------------------- */
/* In-memory link pair                                                         */
/* -------------------------------------------------------------------------- */

interface Waiter {
  resolve: (v: Uint8Array | null) => void;
}

/**
 * One end of a paired in-memory link. Used by tests and the simulator, and as
 * the reference against which a real transport's behaviour is compared.
 *
 * Deliberately supports fault injection, because the interesting properties of
 * this system are all about what happens when the link dies mid-transfer —
 * a scout walking out of range is the expected case, not an edge case.
 */
export class MemoryLink implements Link {
  #peer: MemoryLink | null = null;
  #queue: Uint8Array[] = [];
  #waiters: Waiter[] = [];
  #closed = false;
  #sent = 0;
  #bytes = 0;

  /** Drop the link after this many sends. 0 disables. */
  failAfterSends = 0;
  /** Corrupt one byte of every Nth frame sent. 0 disables. */
  corruptEverySend = 0;

  readonly label: string;

  // Written out rather than using a parameter property: Node runs this
  // TypeScript in strip-only mode, which forbids any syntax that would emit
  // code. That constraint is the price of having no build step, and it is
  // worth paying — see README, "Language subset".
  constructor(label: string) {
    this.label = label;
  }

  static pair(labelA = 'A', labelB = 'B'): [MemoryLink, MemoryLink] {
    const a = new MemoryLink(labelA);
    const b = new MemoryLink(labelB);
    a.#peer = b;
    b.#peer = a;
    return [a, b];
  }

  get stats(): { sent: number; bytes: number } {
    return { sent: this.#sent, bytes: this.#bytes };
  }

  get closed(): boolean {
    return this.#closed;
  }

  async send(bytes: Uint8Array): Promise<void> {
    if (this.#closed) throw new LinkClosedError(this.label);
    const peer = this.#peer;
    if (!peer) throw new LinkError(`link ${this.label} is not paired`);

    this.#sent++;
    this.#bytes += bytes.length;

    let payload = bytes.slice();
    if (this.corruptEverySend > 0 && this.#sent % this.corruptEverySend === 0) {
      // Flip a byte in the middle. A correct receiver must reject the frame,
      // not act on half of it.
      const i = Math.floor(payload.length / 2);
      payload[i] = (payload[i]! ^ 0xff) & 0xff;
    }

    peer.#deliver(payload);

    if (this.failAfterSends > 0 && this.#sent >= this.failAfterSends) {
      await this.close();
    }
  }

  #deliver(bytes: Uint8Array): void {
    const w = this.#waiters.shift();
    if (w) w.resolve(bytes);
    else this.#queue.push(bytes);
  }

  async receive(): Promise<Uint8Array | null> {
    const queued = this.#queue.shift();
    if (queued) return queued;
    if (this.#closed) return null;
    return new Promise<Uint8Array | null>((resolve) => {
      this.#waiters.push({ resolve });
    });
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    for (const w of this.#waiters) w.resolve(null);
    this.#waiters = [];
    const peer = this.#peer;
    if (peer && !peer.#closed) {
      // Close BOTH directions. The comment here used to claim this left the peer
      // half-open, which it never did: `peer.#closed = true` also fails the peer's
      // next send(). That mattered because MemoryLink is described as the
      // reference a real transport is compared against, so the comment was the
      // specification a transport author would have coded to.
      //
      // Symmetric is also the honest model for BLE: a GATT disconnect ends the
      // connection in both directions. A genuinely half-open link is a TCP idea
      // that has no analogue here.
      for (const w of peer.#waiters) w.resolve(null);
      peer.#waiters = [];
      peer.#closed = true;
    }
  }
}
