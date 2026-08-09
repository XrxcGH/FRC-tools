/**
 * Match key packing — spec/canonical-cbor.md §2.
 *
 * TBA-style keys ("2027mose_qm42", "2027mose_sf1m2") are 12-16 bytes of text in
 * every record and invite format drift. Field 3 packs comp level, set, and
 * number into one unsigned integer:
 *
 *   packed = (level << 24) | (set << 12) | number
 *
 * The packing is total and reversible for every match key FRC has produced.
 * Round-tripping is a conformance test, not an implementation detail.
 */

export const COMP_LEVELS = ['qm', 'ef', 'qf', 'sf', 'f'] as const;
export type CompLevel = (typeof COMP_LEVELS)[number];

const LEVEL_CODE: Record<CompLevel, number> = { qm: 1, ef: 2, qf: 3, sf: 4, f: 5 };
const CODE_LEVEL: Record<number, CompLevel> = { 1: 'qm', 2: 'ef', 3: 'qf', 4: 'sf', 5: 'f' };

const MAX_FIELD = 0xfff; // 4095 — far above any real event

export interface Match {
  level: CompLevel;
  /** 0 for qualification matches, which have no set. 1-based otherwise. */
  set: number;
  /** 1-based. */
  number: number;
}

export class MatchKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MatchKeyError';
  }
}

export function packMatch(m: Match): number {
  const code = LEVEL_CODE[m.level];
  if (code === undefined) throw new MatchKeyError(`unknown comp level "${m.level}"`);
  if (!Number.isInteger(m.set) || m.set < 0 || m.set > MAX_FIELD) {
    throw new MatchKeyError(`set ${m.set} out of range 0..${MAX_FIELD}`);
  }
  if (!Number.isInteger(m.number) || m.number < 1 || m.number > MAX_FIELD) {
    throw new MatchKeyError(`match number ${m.number} out of range 1..${MAX_FIELD}`);
  }
  if (m.level === 'qm' && m.set !== 0) {
    throw new MatchKeyError('qualification matches have no set; expected set 0');
  }
  if (m.level !== 'qm' && m.set < 1) {
    throw new MatchKeyError(`${m.level} matches are in a 1-based set; got ${m.set}`);
  }
  return (code << 24) | (m.set << 12) | m.number;
}

export function unpackMatch(packed: number): Match {
  if (!Number.isInteger(packed) || packed < 0 || packed > 0xffffffff) {
    throw new MatchKeyError(`packed match ${packed} is not a 32-bit unsigned integer`);
  }
  const code = (packed >>> 24) & 0xff;
  const level = CODE_LEVEL[code];
  if (level === undefined) throw new MatchKeyError(`unknown comp level code ${code}`);
  const set = (packed >>> 12) & MAX_FIELD;
  const number = packed & MAX_FIELD;
  if (number < 1) throw new MatchKeyError('packed match number is zero');
  return { level, set, number };
}

/** Parse a TBA match key ("2027mose_qm42") into its event key and packed match. */
export function parseMatchKey(key: string): { eventKey: string; packed: number } {
  const us = key.indexOf('_');
  if (us < 1) throw new MatchKeyError(`match key "${key}" has no "_" separator`);
  const eventKey = key.slice(0, us);
  const rest = key.slice(us + 1);

  const qual = /^qm(\d+)$/.exec(rest);
  if (qual) {
    return { eventKey, packed: packMatch({ level: 'qm', set: 0, number: Number(qual[1]) }) };
  }

  const elim = /^(ef|qf|sf|f)(\d+)m(\d+)$/.exec(rest);
  if (elim) {
    return {
      eventKey,
      packed: packMatch({
        level: elim[1] as CompLevel,
        set: Number(elim[2]),
        number: Number(elim[3]),
      }),
    };
  }

  throw new MatchKeyError(`match key "${key}" does not match any known FRC format`);
}

/** Rebuild a TBA match key from an event key and packed match. */
export function formatMatchKey(eventKey: string, packed: number): string {
  const m = unpackMatch(packed);
  if (m.level === 'qm') return `${eventKey}_qm${m.number}`;
  return `${eventKey}_${m.level}${m.set}m${m.number}`;
}

/** Human-facing label for a pit or stands UI. Deliberately short. */
export function matchLabel(packed: number): string {
  const m = unpackMatch(packed);
  if (m.level === 'qm') return `Q${m.number}`;
  if (m.level === 'f') return `F${m.number}`;
  return `${m.level.toUpperCase()}${m.set}-${m.number}`;
}
