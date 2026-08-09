/**
 * @courier/transport — links and bundles.
 *
 * The seam between the portable protocol and the platform. Deliberately narrow:
 * open, send a frame, receive a frame, close. Everything above it is portable
 * TypeScript, because cross-platform maintenance burden is what killed every
 * predecessor to this project.
 */

export {
  MemoryLink,
  LinkError,
  LinkClosedError,
  type Link,
  type Frame,
} from './link.ts';

export {
  syncOverLink,
  syncBothEnds,
  type SyncRole,
  type SyncEnding,
  type SyncOutcome,
  type SyncOptions,
} from './session.ts';

export {
  writeBundle,
  readBundle,
  peekBundle,
  mergeBundle,
  BundleError,
  BUNDLE_VERSION,
  BUNDLE_EXTENSION,
  type Bundle,
  type BundleMeta,
  type MergeResult,
  type WriteBundleOptions,
} from './bundle.ts';
