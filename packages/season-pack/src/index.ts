/**
 * @courier/season-pack — the season's official scoring model as versioned data.
 *
 * Describes OFFICIAL scoring only, which is a thing with exactly one correct
 * answer. It says nothing about anyone's scouting schema, and nothing here
 * decodes a Courier body.
 */

export {
  PACK_FORMAT_VERSION,
  PACK_SCHEMA_ID,
  validatePack,
  loadPack,
  parseVersion,
  compareVersions,
  classifyChange,
  requiredVersion,
  PackError,
  type SeasonPack,
  type PackField,
  type RankingPoint,
  type Unit,
  type Attribution,
  type Trust,
  type SemVer,
  type ChangeKind,
} from './pack.ts';

export {
  PackIndex,
  validateBreakdown,
  reconcileTotal,
  readPath,
  leafPaths,
  type Breakdown,
  type Issue,
  type IssueSeverity,
} from './query.ts';
