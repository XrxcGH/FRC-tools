/**
 * Season Pack — the season's official scoring model as data.
 *
 * Every January the FRC data model breaks. The game is embargoed until kickoff,
 * FMS score details are finalised during Week 0/1, and Team Updates then mutate
 * scoring mid-season. Today eight separate tools each re-derive that model by
 * hand: The Blue Alliance maintains per-season Python files, Statbotics gives up
 * on interpretability and uses generic component columns, Cheesy Arena ships
 * current-game scoring months late every year without exception, and validation
 * tooling cannot exist at all.
 *
 * A pack describes what the official scoring fields MEAN — units, whether they
 * are additive, whether they attribute to an alliance or a robot slot, what a
 * count is worth in points, and where the ranking-point thresholds sit. That
 * semantic layer is the part no API exposes, because it lives in the Game
 * Manual.
 *
 * ── Scope boundary, stated once ─────────────────────────────────────────────
 * A pack describes OFFICIAL scoring only — a thing with exactly one correct
 * answer. It says nothing about anyone's scouting schema. Courier bodies stay
 * opaque; nothing here decodes one. Conflating the two would rebuild the
 * semantic-interchange standard that has already failed in this community.
 *
 * ── Deviation from the draft ────────────────────────────────────────────────
 * The design sketched packs as YAML. These are JSON: it needs no dependency, it
 * is what every consumer can already parse, and the canonical-CBOR signing path
 * needs a deterministic serialisation anyway.
 */

export const PACK_FORMAT_VERSION = 1;

/** Reserved Courier schema id, so a pack can ride the transport it needs anyway. */
export const PACK_SCHEMA_ID = 'courier.seasonpack.v1';

export type Unit = 'count' | 'points' | 'boolean' | 'seconds' | 'category';

/**
 * Who a field is attributed to.
 *
 * `alliance` is the normal case, because FMS publishes alliance-level scoring
 * and nothing else. `robot_slot` fields exist (leave, climb, park) but are keyed
 * to driver stations and are documented as sometimes outright wrong — hence
 * `trust`, below. Any consumer treating the official record as an oracle for
 * per-robot data is building on sand.
 */
export type Attribution = 'alliance' | 'robot_slot';

export type Trust = 'high' | 'low';

export interface PackField {
  /** Dotted path into the FMS score breakdown, e.g. "teleop.fuel.high". */
  readonly path: string;
  readonly type: 'integer' | 'boolean' | 'enum';
  readonly unit: Unit;
  /** Points per unit, where a count converts to points. The thing no API exposes. */
  readonly pointsEach?: number;
  /**
   * Points per enum value.
   *
   * Every real FRC game scores the endgame as an enum level — hang, traversal,
   * stage, cage — so a format with only a scalar `pointsEach` cannot express the
   * points model of any actual season, and a "generic scoring engine" built on
   * it would return a wrong total for essentially every match.
   */
  readonly pointsByValue?: Readonly<Record<string, number>>;
  /** Eligible for least-squares decomposition (OPR and friends). */
  readonly additive: boolean;
  readonly attribution: Attribution;
  /** Cross-year join key, so a query can span seasons without knowing field names. */
  readonly concept?: string;
  readonly values?: readonly string[];
  readonly trust?: Trust;
  /** Contended resource shared by the alliance, e.g. a common supply of game pieces. */
  readonly sharedResource?: string;
  readonly maxPlausiblePerMatch?: number;
  /** True for fields that legitimately go negative, e.g. adjustment points. */
  readonly allowNegative?: boolean;
}

export interface RankingPoint {
  readonly key: string;
  readonly threshold?: number;
  readonly description: string;
  /** Set when a Team Update moved this mid-season — the reason version != season. */
  readonly changedIn?: { tu: number; effectiveEventWeek: number };
}

export interface SeasonPack {
  readonly formatVersion: number;
  readonly packId: string;
  readonly season: number;
  readonly version: string;
  /** Team Update number this pack reflects; 0 for the kickoff drop. */
  readonly derivedFromTeamUpdate: number;
  readonly fields: readonly PackField[];
  readonly rankingPoints: readonly RankingPoint[];
  /**
   * Breakdown paths that exist but are deliberately not modelled — the
   * aggregates FMS always emits (`totalPoints`, `rp`, `foulCount`). Without an
   * allowlist, a staleness check that warns on unknown paths cries wolf on
   * every real match and is therefore ignored, which is worse than no check.
   */
  readonly ignoredPaths?: readonly string[];
  readonly notes?: string;
}

export class PackError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PackError';
  }
}

/* -------------------------------------------------------------------------- */
/* Versioning                                                                  */
/* -------------------------------------------------------------------------- */

export interface SemVer {
  major: number;
  minor: number;
  patch: number;
}

const SEMVER_RE = /^(\d+)\.(\d+)\.(\d+)$/;

export function parseVersion(v: string): SemVer {
  const m = SEMVER_RE.exec(v);
  if (!m) throw new PackError(`"${v}" is not a MAJOR.MINOR.PATCH version`);
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]) };
}

export function compareVersions(a: string, b: string): number {
  const x = parseVersion(a);
  const y = parseVersion(b);
  return x.major - y.major || x.minor - y.minor || x.patch - y.patch;
}

export type ChangeKind = 'major' | 'minor' | 'patch' | 'none';

/**
 * Classify the change between two packs by the SemVer rule the spec fixes:
 *
 *   MAJOR — a field removed, renamed, or its semantics changed
 *   MINOR — a field added
 *   PATCH — a threshold or documentation correction that does not change shape
 *
 * This exists so the version bump is derived from the diff rather than chosen by
 * whoever is awake at 2 a.m. during the kickoff sprint.
 */
/**
 * Properties whose change alters what a consumer computes or accepts.
 * Anything here moving is MAJOR.
 */
const SEMANTIC_KEYS = [
  'type',
  'unit',
  'additive',
  'attribution',
  'pointsEach',
  'concept',
  'trust',
  'allowNegative',
] as const;

/** Properties that tune behaviour without changing meaning. PATCH. */
const TUNING_KEYS = ['maxPlausiblePerMatch', 'sharedResource'] as const;

function stable(v: unknown): string {
  return JSON.stringify(v ?? null);
}

export function classifyChange(from: SeasonPack, to: SeasonPack): ChangeKind {
  if (from.packId !== to.packId) {
    throw new PackError(
      `cannot compare packs with different ids ("${from.packId}" vs "${to.packId}")`,
    );
  }
  if (from.season !== to.season) {
    throw new PackError(`cannot compare packs from different seasons (${from.season} vs ${to.season})`);
  }

  const fromFields = new Map(from.fields.map((f) => [f.path, f]));
  const toFields = new Map(to.fields.map((f) => [f.path, f]));

  let sawMinor = false;
  let sawPatch = false;

  for (const path of fromFields.keys()) {
    if (!toFields.has(path)) return 'major'; // removed or renamed
  }

  for (const [path, f] of fromFields) {
    const t = toFields.get(path)!;

    for (const k of SEMANTIC_KEYS) {
      if (stable(f[k]) !== stable(t[k])) return 'major';
    }

    // Enum values: a pure addition is MINOR (old consumers still validate every
    // value they knew). A removal or rename is MAJOR — old consumers would now
    // flag real match values as errors.
    const fv = f.values ?? [];
    const tv = t.values ?? [];
    if (fv.length || tv.length) {
      const tvSet = new Set(tv);
      for (const v of fv) if (!tvSet.has(v)) return 'major';
      if (tv.length > fv.length) sawMinor = true;
    }

    // Per-value points: any change to an existing value's worth is MAJOR;
    // pricing a previously unpriced value is MINOR.
    const fp = f.pointsByValue ?? {};
    const tp = t.pointsByValue ?? {};
    for (const [k, v] of Object.entries(fp)) {
      if (!(k in tp) || tp[k] !== v) return 'major';
    }
    if (Object.keys(tp).length > Object.keys(fp).length) sawMinor = true;

    for (const k of TUNING_KEYS) {
      if (stable(f[k]) !== stable(t[k])) sawPatch = true;
    }
  }

  for (const path of toFields.keys()) {
    if (!fromFields.has(path)) sawMinor = true; // added
  }

  // Ranking points, compared key-wise. Adding or removing one changes the shape
  // consumers iterate over, so it is MINOR; moving a threshold is PATCH. A plain
  // JSON compare would call a reordering a change and an added RP a patch.
  const fromRp = new Map(from.rankingPoints.map((r) => [r.key, r]));
  const toRp = new Map(to.rankingPoints.map((r) => [r.key, r]));
  for (const k of fromRp.keys()) if (!toRp.has(k)) sawMinor = true;
  for (const k of toRp.keys()) if (!fromRp.has(k)) sawMinor = true;
  for (const [k, r] of fromRp) {
    const t = toRp.get(k);
    if (!t) continue;
    if (stable(r.threshold) !== stable(t.threshold)) sawPatch = true;
    if (r.description !== t.description) sawPatch = true;
    if (stable(r.changedIn) !== stable(t.changedIn)) sawPatch = true;
  }

  if (stable(from.ignoredPaths) !== stable(to.ignoredPaths)) sawPatch = true;
  if (from.derivedFromTeamUpdate !== to.derivedFromTeamUpdate) sawPatch = true;
  if (from.notes !== to.notes) sawPatch = true;

  if (sawMinor) return 'minor';
  if (sawPatch) return 'patch';
  return 'none';
}

/** The version `to` must carry, given `from`. Enforced in CI so drift cannot ship. */
export function requiredVersion(from: SeasonPack, to: SeasonPack): string {
  const v = parseVersion(from.version);
  switch (classifyChange(from, to)) {
    case 'major':
      return `${v.major + 1}.0.0`;
    case 'minor':
      return `${v.major}.${v.minor + 1}.0`;
    case 'patch':
      return `${v.major}.${v.minor}.${v.patch + 1}`;
    case 'none':
      return from.version;
  }
}

/* -------------------------------------------------------------------------- */
/* Validation                                                                  */
/* -------------------------------------------------------------------------- */

const UNITS: readonly Unit[] = ['count', 'points', 'boolean', 'seconds', 'category'];

export function validatePack(p: SeasonPack): void {
  if (p.formatVersion !== PACK_FORMAT_VERSION) {
    throw new PackError(`unsupported pack format version ${p.formatVersion}`);
  }
  if (!p.packId) throw new PackError('pack has no packId');
  if (!Number.isInteger(p.season) || p.season < 1992 || p.season > 2100) {
    throw new PackError(`implausible season ${p.season}`);
  }
  parseVersion(p.version);
  if (!Number.isInteger(p.derivedFromTeamUpdate) || p.derivedFromTeamUpdate < 0) {
    throw new PackError('derivedFromTeamUpdate must be a non-negative integer');
  }
  if (p.fields.length === 0) throw new PackError('pack declares no fields');

  const paths = new Set<string>();
  for (const f of p.fields) {
    if (!f.path) throw new PackError('field with no path');
    if (paths.has(f.path)) throw new PackError(`duplicate field path "${f.path}"`);
    paths.add(f.path);

    if (!UNITS.includes(f.unit)) throw new PackError(`${f.path}: unknown unit "${f.unit}"`);
    if (f.attribution !== 'alliance' && f.attribution !== 'robot_slot') {
      throw new PackError(`${f.path}: attribution must be "alliance" or "robot_slot"`);
    }
    if (f.type === 'enum' && (!f.values || f.values.length === 0)) {
      throw new PackError(`${f.path}: enum fields must list their values`);
    }
    if (f.type !== 'enum' && f.values) {
      throw new PackError(`${f.path}: only enum fields may list values`);
    }

    // The rules that keep downstream maths honest.
    if (f.additive && f.unit === 'category') {
      throw new PackError(`${f.path}: a category cannot be additive — it has no sum`);
    }
    if (f.additive && f.type === 'enum') {
      throw new PackError(`${f.path}: an enum cannot be additive`);
    }
    // Every field must declare how it converts to points, or declare that it
    // does not score. Without this rule a scored boolean or an unpriced count
    // silently contributes zero, and `scoreBreakdown` quietly under-reports
    // while claiming to give "the total points implied by a breakdown".
    if (f.type === 'enum') {
      if (f.pointsByValue) {
        for (const k of Object.keys(f.pointsByValue)) {
          if (!f.values!.includes(k)) {
            throw new PackError(`${f.path}: pointsByValue has "${k}", which is not one of its values`);
          }
          if (!Number.isFinite(f.pointsByValue[k])) {
            throw new PackError(`${f.path}: pointsByValue["${k}"] must be a finite number`);
          }
        }
      }
      if (f.pointsEach !== undefined) {
        throw new PackError(`${f.path}: enum fields score via pointsByValue, not pointsEach`);
      }
    } else if (f.unit !== 'points' && f.unit !== 'category') {
      if (f.pointsEach === undefined) {
        throw new PackError(
          `${f.path}: needs pointsEach so consumers can convert it to points. Declare 0 ` +
            `explicitly if the field genuinely scores nothing — silence is indistinguishable ` +
            `from an omission.`,
        );
      }
    }
    if (f.pointsByValue && f.type !== 'enum') {
      throw new PackError(`${f.path}: only enum fields may use pointsByValue`);
    }
    if (f.pointsEach !== undefined && !Number.isFinite(f.pointsEach)) {
      throw new PackError(`${f.path}: pointsEach must be a finite number`);
    }
    if (f.attribution === 'robot_slot' && f.trust !== 'low') {
      throw new PackError(
        `${f.path}: robot_slot fields are keyed to driver stations and are documented as ` +
          `sometimes wrong, so they must be declared trust:"low" — this is deliberate friction`,
      );
    }
  }

  const rpKeys = new Set<string>();
  for (const rp of p.rankingPoints) {
    if (!rp.key) throw new PackError('ranking point with no key');
    if (rpKeys.has(rp.key)) throw new PackError(`duplicate ranking point "${rp.key}"`);
    rpKeys.add(rp.key);
    if (rp.changedIn && !Number.isInteger(rp.changedIn.tu)) {
      throw new PackError(`${rp.key}: changedIn.tu must be an integer`);
    }
  }
}

export function loadPack(raw: unknown): SeasonPack {
  if (typeof raw !== 'object' || raw === null) throw new PackError('pack is not an object');
  const p = raw as SeasonPack;
  if (!Array.isArray(p.fields)) throw new PackError('pack has no fields array');
  if (!Array.isArray(p.rankingPoints)) throw new PackError('pack has no rankingPoints array');
  try {
    validatePack(p);
  } catch (err) {
    // Callers catch PackError; a raw TypeError from a malformed shape leaking
    // through would bypass every error path they wrote.
    if (err instanceof PackError) throw err;
    throw new PackError(`malformed pack: ${(err as Error).message}`);
  }
  return p;
}
