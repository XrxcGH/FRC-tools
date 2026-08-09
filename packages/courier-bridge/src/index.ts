/**
 * @courier/bridge — ingest the QR output of scouting apps that adopt nothing.
 *
 * The Bridge is the reason Courier can deliver value without anyone's
 * permission. A scouting-app author does not have to integrate, agree, or even
 * know this exists: the Bridge scans the QR their app already emits, reads the
 * four fields needed to route it, and carries the rest through untouched.
 */

export {
  loadProfileSet,
  validateProfile,
  detectProfile,
  readField,
  ProfileError,
  type BridgeProfile,
  type BridgeProfileSet,
  type ProfileFields,
  type ProfileFormat,
  type FieldRef,
} from './profiles.ts';

export {
  ingestScan,
  ingestBatch,
  ScanSuppressor,
  type IngestResult,
  type IngestStatus,
  type BridgeContext,
  type BatchSummary,
} from './ingest.ts';
