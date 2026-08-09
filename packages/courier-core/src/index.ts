/**
 * @courier/core — the Courier wire format and anti-entropy protocol.
 *
 * The layer beneath the FRC scouting-app rebuild. Courier moves signed,
 * deduplicated, OPAQUE payloads between devices at an event where Game Manual
 * E301 forbids creating a network. It standardises the envelope and never the
 * body, so adopting it costs a scouting-app author nothing they care about.
 *
 * Normative format: spec/courier-record.cddl + spec/canonical-cbor.md.
 */

export {
  encode,
  decode,
  encodeTagged,
  decodeTagged,
  compareBytes,
  expectMap,
  expectArray,
  expectUint,
  expectText,
  expectBytes,
  CborError,
  type CborValue,
  type CborKey,
} from './cbor.ts';

export {
  hash256,
  concat,
  toHex,
  fromHex,
  utf8,
  timingSafeEqual,
  HASH_BYTES,
  KEY_ID_BYTES,
  SCOUT_PSEUDONYM_BYTES,
} from './hash.ts';

export {
  packMatch,
  unpackMatch,
  parseMatchKey,
  formatMatchKey,
  matchLabel,
  MatchKeyError,
  COMP_LEVELS,
  type Match,
  type CompLevel,
} from './matchkey.ts';

export {
  generateDeviceKey,
  deviceKeyFromSecret,
  deriveKeyId,
  generateMeshKey,
  mintScoutPseudonym,
  kidLabel,
  sign,
  verify,
  MESH_KEY_BYTES,
  type DeviceKeyPair,
  type KeyBacking,
} from './keys.ts';

export {
  makeRecord,
  supersede,
  validateRecord,
  encodeRecord,
  decodeRecord,
  recordId,
  recordIdHex,
  compareRecords,
  observationKey,
  RecordError,
  RECORD_VERSION,
  LIMITS,
  F,
  type CourierRecord,
  type NewRecordInput,
} from './record.ts';

export {
  sealRecord,
  openEnvelope,
  peekKeyId,
  envelopeSize,
  EnvelopeError,
  COSE_SIGN1_TAG,
  ALG_EDDSA,
  SIGNATURE_BYTES,
  type OpenedEnvelope,
  type KeyResolver,
} from './envelope.ts';

export {
  RecordStore,
  type StoreStats,
  type AdmitResult,
} from './store.ts';

export {
  rangeDigest,
  childDigests,
  idsWithPrefix,
  digestsEqual,
  prefixRange,
  nibbleAt,
  buildDigestTree,
  DIGEST_FANOUT,
  type DigestNode,
} from './digest.ts';

export {
  AntiEntropySession,
  reconcile,
  storesConverged,
  encodeSyncMessage,
  decodeSyncMessage,
  messageSize,
  isEmptyMessage,
  hasContent,
  ID_PREFIX_BYTES,
  LEAF_THRESHOLD,
  MAX_DEPTH,
  MAX_RECORDS_PER_MESSAGE,
  type SyncMessage,
  type SyncStats,
  type ReconcileResult,
  type IdList,
} from './anti-entropy.ts';
