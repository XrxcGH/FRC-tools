/**
 * @courier/ble — everything above the radio.
 *
 * The native shim has four jobs: advertise or scan, report the MTU, hand up
 * packets, take packets. Framing, reassembly, ordering, and backpressure are
 * here, portable and tested, because the native surface is the maintenance
 * burden that killed every predecessor to this project.
 */

export {
  split,
  payloadPerPacket,
  Reassembler,
  FramingError,
  HEADER_BYTES,
  MAX_FRAME_BYTES,
  ATT_OVERHEAD,
  type ReassemblyStats,
} from './framing.ts';

export {
  GattLink,
  FakeGattTransport,
  fakeGattPair,
  COURIER_SERVICE_UUID,
  COURIER_RX_UUID,
  COURIER_TX_UUID,
  MIN_MTU,
  PREFERRED_MTU,
  type GattTransport,
  type GattLinkOptions,
  type GattLinkStats,
  type FakeGattOptions,
} from './gatt.ts';
