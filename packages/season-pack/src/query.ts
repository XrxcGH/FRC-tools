/**
 * Consuming a pack.
 *
 * The point of the pack is that downstream tools stop re-deriving the scoring
 * model. This module is the proof: a scoring engine and a reconciliation
 * validator, both entirely generic over the season, both impossible to write
 * without the semantic layer a pack carries.
 */

import { PackError, type PackField, type SeasonPack } from './pack.ts';

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

  /** Points contributed by one field at one value. */
  pointsFor(path: string, value: unknown): number {
    const f = this.#byPath.get(path);
    if (!f) throw new PackError(`unknown field "${path}"`);
    if (f.unit === 'points') return asNumber(value, path);
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
   */
  scoreBreakdown(breakdown: Breakdown): { total: number; byField: Map<string, number> } {
    const byField = new Map<string, number>();
    let total = 0;
    for (const f of this.pack.fields) {
      const raw = readPath(breakdown, f.path);
      if (raw === undefined || raw === null) continue;
      if (f.unit === 'category' || f.type === 'enum') continue;
      const pts = this.pointsFor(f.path, raw);
      if (pts !== 0) byField.set(f.path, pts);
      total += pts;
    }
    return { total, byField };
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
      if (raw < 0) {
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

  // Anything present in the breakdown that the pack has never heard of is the
  // signal that the pack is stale — usually because a Team Update changed
  // scoring mid-season. That is worth surfacing loudly, since a silently stale
  // pack produces confidently wrong numbers.
  for (const key of Object.keys(breakdown)) {
    if (!index.pack.fields.some((f) => f.path === key || f.path.startsWith(key + '.'))) {
      issues.push({
        severity: 'warning',
        path: key,
        message: 'present in the breakdown but absent from the pack — the pack may be stale',
      });
    }
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
  const { total } = index.scoreBreakdown(breakdown);
  if (total === officialTotal) return [];
  return [
    {
      severity: 'error',
      message:
        `pack arithmetic gives ${total} but the official total is ${officialTotal} ` +
        `(difference ${officialTotal - total}). Either the pack is missing a field, a ` +
        `pointsEach is wrong, or the official record is — do not silently prefer one.`,
    },
  ];
}
