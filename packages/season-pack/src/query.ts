/**
 * Consuming a pack.
 *
 * The point of the pack is that downstream tools stop re-deriving the scoring
 * model. This module is the proof: a scoring engine and a reconciliation
 * validator, both entirely generic over the season, both impossible to write
 * without the semantic layer a pack carries.
 */

import { PackError, type PackField, type SeasonPack } from './pack.ts';

/** Every leaf path in a nested breakdown, dotted. */
export function* leafPaths(obj: Record<string, unknown>, prefix = ''): Generator<string> {
  for (const [k, v] of Object.entries(obj)) {
    const path = prefix ? `${prefix}.${k}` : k;
    if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
      yield* leafPaths(v as Record<string, unknown>, path);
    } else {
      yield path;
    }
  }
}

export type Breakdown = Record<string, unknown>;

/** Read a dotted path out of a nested FMS score breakdown. */
export function readPath(breakdown: Breakdown, path: string): unknown {
  let cur: unknown = breakdown;
  for (const part of path.split('.')) {
    if (typeof cur !== 'object' || cur === null) return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

export class PackIndex {
  readonly pack: SeasonPack;
  readonly #byPath = new Map<string, PackField>();
  readonly #byConcept = new Map<string, PackField[]>();

  constructor(pack: SeasonPack) {
    this.pack = pack;
    for (const f of pack.fields) {
      this.#byPath.set(f.path, f);
      if (f.concept) {
        const list = this.#byConcept.get(f.concept) ?? [];
        list.push(f);
        this.#byConcept.set(f.concept, list);
      }
    }
  }

  field(path: string): PackField | undefined {
    return this.#byPath.get(path);
  }

  /**
   * Fields sharing a cross-year concept. This is what lets a query span seasons
   * without knowing that 2027 called it `teleop.fuel.high` and 2026 called it
   * something else.
   */
  byConcept(concept: string): readonly PackField[] {
    return this.#byConcept.get(concept) ?? [];
  }

  /** Fields eligible for least-squares decomposition (OPR and relatives). */
  additiveFields(): readonly PackField[] {
    return this.pack.fields.filter((f) => f.additive);
  }

  /** Fields the official record reports per robot — and reports unreliably. */
  robotSlotFields(): readonly PackField[] {
    return this.pack.fields.filter((f) => f.attribution === 'robot_slot');
  }

  /** Whether a field declares how it converts to points at all. */
  isPriced(f: PackField): boolean {
    if (f.type === 'enum') return f.pointsByValue !== undefined;
    if (f.unit === 'points') return true;
    if (f.unit === 'category') return false;
    return f.pointsEach !== undefined;
  }

  /** Points contributed by one field at one value. */
  pointsFor(path: string, value: unknown): number {
    const f = this.#byPath.get(path);
    if (!f) throw new PackError(`unknown field "${path}"`);

    if (f.type === 'enum') {
      // Every real FRC endgame is an enum level. Scoring them is not optional.
      if (!f.pointsByValue) return 0;
      return f.pointsByValue[String(value)] ?? 0;
    }
    if (f.unit === 'points') return asNumber(value, path);
    if (f.unit === 'category') return 0;
    if (f.pointsEach === undefined) return 0;
    if (f.type === 'boolean') return value === true ? f.pointsEach : 0;
    return asNumber(value, path) * f.pointsEach;
  }

  /**
   * Total points implied by a breakdown, from the pack alone.
   *
   * A generic scoring engine is the thing Cheesy Arena rebuilds by hand months
   * after every kickoff, and the thing that makes Week 0 events possible with
   * current-game scoring.
   *
   * `unpriced` lists fields that were present in the breakdown but carry no
   * points model, so a caller can tell "scored zero" from "could not be
   * scored". Returning a total that silently omits them is how `reconcileTotal`
   * ends up sending a pack author hunting in the wrong place.
   */
  scoreBreakdown(breakdown: Breakdown): {
    total: number;
    byField: Map<string, number>;
    unpriced: string[];
  } {
    const byField = new Map<string, number>();
    const unpriced: string[] = [];
    let total = 0;

    for (const f of this.pack.fields) {
      const raw = readPath(breakdown, f.path);
      if (raw === undefined || raw === null) continue;
      if (!this.isPriced(f)) {
        unpriced.push(f.path);
        continue;
      }
      const pts = this.pointsFor(f.path, raw);
      if (pts !== 0) byField.set(f.path, pts);
      total += pts;
    }
    return { total, byField, unpriced };
  }
}

function asNumber(v: unknown, path: string): number {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'boolean') return v ? 1 : 0;
  throw new PackError(`${path}: expected a number, got ${typeof v}`);
}

/* -------------------------------------------------------------------------- */
/* Reconciliation validator                                                    */
/* -------------------------------------------------------------------------- */

export type IssueSeverity = 'error' | 'warning';

export interface Issue {
  readonly severity: IssueSeverity;
  readonly path?: string;
  readonly message: string;
}

/**
 * Check a score breakdown against the pack.
 *
 * Five teams independently hand-rolled TBA reconciliation and none of them could
 * package it, because the game-specific half had to be rewritten every January.
 * With a pack, the whole thing is generic.
 */
export function validateBreakdown(index: PackIndex, breakdown: Breakdown): Issue[] {
  const issues: Issue[] = [];

  for (const f of index.pack.fields) {
    const raw = readPath(breakdown, f.path);
    if (raw === undefined || raw === null) {
      issues.push({ severity: 'warning', path: f.path, message: 'field absent from breakdown' });
      continue;
    }

    if (f.type === 'integer') {
      if (typeof raw !== 'number' || !Number.isInteger(raw)) {
        issues.push({ severity: 'error', path: f.path, message: `expected an integer, got ${JSON.stringify(raw)}` });
        continue;
      }
      if (raw < 0 && !f.allowNegative) {
        // Adjustment points are legitimately negative in real FMS breakdowns,
        // so the field declares it rather than the validator guessing.
        issues.push({ severity: 'error', path: f.path, message: `negative value ${raw}` });
      }
      if (f.maxPlausiblePerMatch !== undefined && raw > f.maxPlausiblePerMatch) {
        issues.push({
          severity: 'error',
          path: f.path,
          message: `${raw} exceeds the plausible per-match maximum of ${f.maxPlausiblePerMatch}`,
        });
      }
    } else if (f.type === 'boolean') {
      if (typeof raw !== 'boolean') {
        issues.push({ severity: 'error', path: f.path, message: `expected a boolean, got ${JSON.stringify(raw)}` });
      }
    } else if (f.type === 'enum') {
      if (typeof raw !== 'string' || !f.values!.includes(raw)) {
        issues.push({
          severity: 'error',
          path: f.path,
          message: `${JSON.stringify(raw)} is not one of ${f.values!.join(', ')}`,
        });
      }
    }
  }

  // Anything present in the breakdown that the pack has never heard of signals
  // a stale pack — usually a Team Update that changed scoring mid-season.
  //
  // This must walk LEAVES. Checking only top-level keys both misses the common
  // case (a new field added inside an existing group: the pack knows
  // `auto.fuel.high`, so a new `auto.fuel.mid` is hidden behind the satisfied
  // `auto` prefix) and fires on every real match, because FMS breakdowns always
  // carry aggregates like `totalPoints` and `rp`. A warning that always fires
  // and never fires correctly is worse than no warning.
  const known = new Set(index.pack.fields.map((f) => f.path));
  const ignored = new Set(index.pack.ignoredPaths ?? []);
  for (const path of leafPaths(breakdown)) {
    if (known.has(path) || ignored.has(path)) continue;
    issues.push({
      severity: 'warning',
      path,
      message:
        'present in the breakdown but absent from the pack — the pack may be stale, or add ' +
        'this path to ignoredPaths if it is an aggregate the pack deliberately does not model',
    });
  }

  return issues;
}

/**
 * Cross-check the pack's own arithmetic against an official alliance total.
 *
 * If these disagree, either the pack is wrong or the official record is — and
 * knowing which is the entire reason validation tooling is worth having.
 */
export function reconcileTotal(
  index: PackIndex,
  breakdown: Breakdown,
  officialTotal: number,
): Issue[] {
  const { total, unpriced } = index.scoreBreakdown(breakdown);
  if (total === officialTotal) return [];
  const hint = unpriced.length
    ? ` Note that ${unpriced.length} field(s) were present but carry no points model, so they ` +
      `contributed nothing: ${unpriced.join(', ')}. Price them before investigating elsewhere.`
    : '';
  return [
    {
      severity: 'error',
      message:
        `pack arithmetic gives ${total} but the official total is ${officialTotal} ` +
        `(difference ${officialTotal - total}). Either the pack is missing a field, a ` +
        `points value is wrong, or the official record is — do not silently prefer one.${hint}`,
    },
  ];
}
