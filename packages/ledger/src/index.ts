/**
 * @courier/ledger — polite ingestion from the FRC data layer, and offline
 * venue packs.
 *
 * Scope, per the design review's cut: Ledger is not a rival analytics site. It
 * is free, current, account-free data, plus a pack a team can carry into a pit
 * that has no internet. That is the highest-feasibility item in the research,
 * it is genuinely missing, and it is the only deliverable here that survives
 * its founders leaving without anyone doing anything.
 */

export {
  SOURCES,
  attributionFor,
  SourceError,
  type SourceId,
  type SourceProfile,
  type AuthScheme,
} from './sources.ts';

export {
  PoliteClient,
  MemoryCache,
  systemClock,
  type FetchLike,
  type Clock,
  type HttpResponse,
  type ConditionalCache,
  type CacheEntry,
  type Credentials,
  type PoliteClientOptions,
  type GetResult,
  type ClientStats,
} from './http.ts';

export {
  TbaClient,
  TbaError,
  normaliseTeams,
  normaliseMatches,
  teamNumberFromKey,
  lastOfficialMatch,
  type TbaTeam,
  type TbaMatch,
  type TbaAlliance,
  type EventSnapshot,
} from './tba.ts';

export {
  FirstClient,
  FirstApiError,
  splitEventKey,
  compLevelFor,
  normaliseFirstTeams,
  normaliseFirstMatches,
  type FirstTeam,
  type FirstMatch,
  type FirstStation,
  type FirstSnapshot,
} from './first.ts';

export {
  fetchEvent,
  makeVenuePack,
  credentialsFromEnv,
  observationsFrom,
  nodeFetch,
  type LedgerResult,
  type FetchOptions,
  type PackOptions,
  type Credentials as LedgerCredentials,
} from './cli.ts';

export {
  buildBulkExport,
  toNdjson,
  toCsv,
  cacheControlFor,
  BulkError,
  BULK_FORMAT_VERSION,
  type BulkExport,
  type BulkArtifact,
  type BulkManifest,
  type BuildBulkInput,
  type ContentType,
} from './bulk.ts';

export {
  reconcileSnapshots,
  summariseConflicts,
  type Source,
  type Conflict,
  type ConflictKind,
  type ReconcileInput,
  type ReconcileOutput,
} from './reconcile.ts';

export {
  buildVenuePack,
  openVenuePack,
  describeStaleness,
  VenuePackError,
  VENUE_PACK_VERSION,
  VENUE_PACK_SCHEMA_ID,
  type VenuePack,
  type SignedVenuePack,
  type BuildVenuePackInput,
  type TeamEntry,
  type MatchEntry,
  type RatingEntry,
  type Staleness,
  type VenuePackKeyResolver,
} from './venue-pack.ts';
