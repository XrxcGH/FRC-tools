/**
 * BLE framing conformance against spec/vectors/ble-framing.json.
 *
 * Committed, not regenerated. A change here is a wire-format change and breaks
 * every peer running a different build.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { split, Reassembler, payloadPerPacket, HEADER_BYTES, ATT_OVERHEAD } from '../src/index.ts';
import { toHex, fromHex } from '@courier/core';

interface Vectors {
  note: string;
  frameHex: string;
  cases: Array<{ mtu: number; frameId: number; packetsHex: string[] }>;
}

const V = JSON.parse(
  readFileSync(fileURLToPath(new URL('../../../spec/vectors/ble-framing.json', import.meta.url)), 'utf8'),
) as Vectors;

test('packet splitting matches the committed vectors at every MTU', () => {
  const frame = fromHex(V.frameHex);
  assert.ok(V.cases.length >= 3, 'the vectors must cover a range of MTUs');

  for (const c of V.cases) {
    const packets = split(frame, c.mtu, c.frameId).map(toHex);
    assert.deepEqual(packets, c.packetsHex, `MTU ${c.mtu}`);
  }
});

test('committed packets reassemble back to the original frame', () => {
  const frame = fromHex(V.frameHex);
  for (const c of V.cases) {
    const r = new Reassembler();
    let out: Uint8Array | null = null;
    for (const hex of c.packetsHex) out = r.push(fromHex(hex));
    assert.ok(out, `MTU ${c.mtu} completed`);
    assert.equal(toHex(out!), V.frameHex, `MTU ${c.mtu} round-trip`);
  }
});

test('the header layout the vectors pin is the one the code emits', () => {
  // frameId(2) | seq(2) | flags(1), big endian, flags bit 0 = final.
  const c = V.cases.find((x) => x.mtu === 247)!;
  const first = fromHex(c.packetsHex[0]!);
  const last = fromHex(c.packetsHex[c.packetsHex.length - 1]!);

  assert.equal((first[0]! << 8) | first[1]!, c.frameId, 'frame id, big endian');
  assert.equal((first[2]! << 8) | first[3]!, 0, 'first packet is sequence 0');
  assert.equal(first[4]! & 0x01, 0, 'and is not final');
  assert.equal((last[2]! << 8) | last[3]!, c.packetsHex.length - 1, 'last sequence');
  assert.equal(last[4]! & 0x01, 1, 'last packet is flagged final');
});

test('no committed packet exceeds what its MTU allows on the wire', () => {
  for (const c of V.cases) {
    for (const hex of c.packetsHex) {
      const len = hex.length / 2;
      assert.ok(len <= c.mtu - ATT_OVERHEAD, `MTU ${c.mtu}: packet of ${len} bytes is too large`);
    }
  }
});

test('the 16-bit sequence is load-bearing at the minimum MTU', () => {
  // An 8-bit sequence caps a frame at 256 packets. At 23 bytes the payload is
  // 15 per packet, so a routine 8.6 kB sync frame needs ~590 — which is why the
  // field is 16 bits and costs one byte on every packet.
  assert.equal(payloadPerPacket(23), 23 - ATT_OVERHEAD - HEADER_BYTES);
  const packets = split(new Uint8Array(8600), 23, 0);
  assert.ok(packets.length > 256, `needs ${packets.length} packets, over an 8-bit sequence`);

  const r = new Reassembler();
  let out: Uint8Array | null = null;
  for (const p of packets) out = r.push(p);
  assert.equal(out!.length, 8600);
});
