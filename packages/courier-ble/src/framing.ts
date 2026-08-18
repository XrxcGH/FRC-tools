/**
 * Chunking and reassembly for GATT.
 *
 * A BLE characteristic carries at most (MTU - 3) bytes per write or
 * notification — around 20 bytes on an unnegotiated connection and 244 after
 * data-length extension. Courier's sync messages are kilobytes. So every frame
 * has to be split, sent as a series of packets, and put back together on the
 * far side, over a link that can drop between any two packets.
 *
 * This is deliberately the whole of the protocol that touches the radio's
 * shape, and it is platform-agnostic on purpose: the design identifies
 * cross-platform native maintenance as the thing that killed every predecessor,
 * so the native surface is reduced to "hand me bytes, take these bytes" and
 * everything else lives here where it can be tested without hardware.
 */

export const HEADER_BYTES = 5;
/** Refuse a reassembly larger than this, so a peer cannot exhaust memory. */
export const MAX_FRAME_BYTES = 4 * 1024 * 1024;
/** ATT overhead: 1 opcode + 2 handle. */
export const ATT_OVERHEAD = 3;
/** Sequence numbers are 16-bit, so this many packets fit in one frame. */
export const MAX_PACKETS_PER_FRAME = 65536;

export class FramingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FramingError';
  }
}

/**
 * Packet header: a 16-bit frame id, a 16-bit sequence, and flags.
 *
 * The frame id lets a receiver notice that a new frame started before the
 * previous one finished — which is what a dropped connection mid-frame looks
 * like from the far side — and discard the partial rather than splicing two
 * frames into a corrupt one.
 *
 *   byte 0-1  frame id (big endian)
 *   byte 2-3  sequence number within the frame (big endian)
 *   byte 4    flags: bit 0 = final packet
 *
 * The sequence started as 8-bit, which cost one byte less per packet and was
 * wrong: an unnegotiated 23-byte MTU leaves 15 payload bytes, so a routine
 * 8.6 kB sync frame needs ~590 packets and simply could not be sent. A 23-byte
 * MTU is not a hypothetical — it is what you get before negotiation succeeds,
 * which is exactly the moment two devices are trying to talk for the first
 * time. One byte per packet is the right price for that not being a dead end.
 */
const FLAG_FINAL = 0x01;

export function payloadPerPacket(mtu: number): number {
  // `usable < 1` alone is not a guard: NaN < 1 is false, so a NaN MTU sailed
  // through and split() then returned ZERO packets — Math.ceil(len / NaN) is
  // NaN, and `for (i = 0; i < NaN; i++)` never runs. GattLink.send would iterate
  // nothing, skip the whole backpressure loop, increment framesSent and resolve
  // normally, having transmitted nothing at all.
  //
  // MTU is not a local constant. It crosses the native bridge — hub.ts calls
  // setMtu(conn.mtu) straight from the plugin's connect() result — so a shim
  // that omits the field, returns null, or reports iOS's
  // maximumUpdateValueLength before subscription yields undefined and then NaN.
  if (!Number.isInteger(mtu)) {
    throw new FramingError(
      `MTU ${mtu} is not an integer. A missing or unreported MTU from the native layer ` +
        `must fail here, not silently send zero packets.`,
    );
  }
  const usable = mtu - ATT_OVERHEAD - HEADER_BYTES;
  if (usable < 1) throw new FramingError(`MTU ${mtu} is too small to carry any payload`);
  return usable;
}

export function split(frame: Uint8Array, mtu: number, frameId: number): Uint8Array[] {
  const per = payloadPerPacket(mtu);
  const packets: Uint8Array[] = [];
  const total = Math.max(1, Math.ceil(frame.length / per));

  if (total > MAX_PACKETS_PER_FRAME) {
    throw new FramingError(
      `frame of ${frame.length} bytes needs ${total} packets at MTU ${mtu}, over the ` +
        `${MAX_PACKETS_PER_FRAME} limit. Negotiate a larger MTU, or send a smaller frame.`,
    );
  }

  for (let i = 0; i < total; i++) {
    const chunk = frame.subarray(i * per, (i + 1) * per);
    const packet = new Uint8Array(HEADER_BYTES + chunk.length);
    packet[0] = (frameId >> 8) & 0xff;
    packet[1] = frameId & 0xff;
    packet[2] = (i >> 8) & 0xff;
    packet[3] = i & 0xff;
    packet[4] = i === total - 1 ? FLAG_FINAL : 0;
    packet.set(chunk, HEADER_BYTES);
    packets.push(packet);
  }
  return packets;
}

export interface ReassemblyStats {
  framesCompleted: number;
  framesAbandoned: number;
  packetsDropped: number;
}

/**
 * Reassembles packets into frames.
 *
 * Strict about ordering: BLE guarantees ordered delivery within a connection,
 * so an out-of-sequence packet means something is wrong — a lost notification,
 * a peer bug, or a hostile sender. Guessing at the gap would hand a corrupt
 * frame to a signature check that would then fail confusingly. Discarding the
 * partial and waiting for the next frame is both simpler and honest.
 */
export class Reassembler {
  #frameId: number | null = null;
  #expectedSeq = 0;
  #parts: Uint8Array[] = [];
  #length = 0;
  readonly stats: ReassemblyStats = {
    framesCompleted: 0,
    framesAbandoned: 0,
    packetsDropped: 0,
  };

  /** Feed one packet. Returns a complete frame, or null if more are needed. */
  push(packet: Uint8Array): Uint8Array | null {
    if (packet.length < HEADER_BYTES) {
      this.stats.packetsDropped++;
      throw new FramingError(`packet of ${packet.length} bytes is shorter than the header`);
    }

    const frameId = (packet[0]! << 8) | packet[1]!;
    const seq = (packet[2]! << 8) | packet[3]!;
    const final = (packet[4]! & FLAG_FINAL) !== 0;
    const body = packet.subarray(HEADER_BYTES);

    if (this.#frameId !== null && frameId !== this.#frameId) {
      // A new frame started before the old one finished: the sender restarted,
      // or packets were lost at the tail. Abandon the partial.
      this.stats.framesAbandoned++;
      this.#reset();
    }

    if (this.#frameId === null) {
      if (seq !== 0) {
        // Joined mid-frame. Wait for the next frame rather than emitting a
        // truncated one.
        this.stats.packetsDropped++;
        return null;
      }
      this.#frameId = frameId;
      this.#expectedSeq = 0;
    }

    if (seq !== this.#expectedSeq) {
      // Read it BEFORE the reset, which zeroes it. The template literal is
      // evaluated after, so this used to report "expected sequence 0" no matter
      // how far into the frame the gap was — plausible enough to be misleading
      // rather than obviously broken.
      const expected = this.#expectedSeq;
      this.stats.framesAbandoned++;
      this.#reset();
      throw new FramingError(
        `out-of-order packet: expected sequence ${expected}, got ${seq}. ` +
          `The partial frame was discarded rather than spliced.`,
      );
    }

    this.#length += body.length;
    if (this.#length > MAX_FRAME_BYTES) {
      this.#reset();
      throw new FramingError(`frame exceeds the ${MAX_FRAME_BYTES} byte limit`);
    }
    this.#parts.push(body.slice());
    this.#expectedSeq = this.#expectedSeq + 1;

    if (!final) return null;

    const out = new Uint8Array(this.#length);
    let o = 0;
    for (const p of this.#parts) {
      out.set(p, o);
      o += p.length;
    }
    this.stats.framesCompleted++;
    this.#reset();
    return out;
  }

  /** True when a frame is partially received. Useful for a progress indicator. */
  get inProgress(): boolean {
    return this.#frameId !== null;
  }

  get bufferedBytes(): number {
    return this.#length;
  }

  #reset(): void {
    this.#frameId = null;
    this.#expectedSeq = 0;
    this.#parts = [];
    this.#length = 0;
  }
}
