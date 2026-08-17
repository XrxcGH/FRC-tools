/**
 * @courier/decode — the seam between opaque transport and analytics.
 *
 * A decoder is a team's own description of their own body format, registered on
 * their own device and applied at analysis time. It is not a shared schema, it
 * never travels with a record, and Courier still never parses a body in
 * transit. A record whose schema is unregistered is simply not decoded, and the
 * report says how many those were rather than substituting zeros.
 */

export {
  decodeBody,
  validateSchema,
  loadSchema,
  SchemaError,
  type BodySchema,
  type FieldSpec,
  type FieldType,
  type FieldValue,
  type DecodeResult,
  type DecodeSuccess,
  type DecodeFailure,
} from './schema.ts';

export {
  DecoderRegistry,
  RegistryError,
  describeGaps,
  type DecodedRecord,
  type DecodeReport,
  type StoredRecordLike,
} from './registry.ts';

export {
  toAllianceObservations,
  toScoutObservations,
  BridgeSchemas,
} from './observations.ts';
