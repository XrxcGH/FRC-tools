/**
 * Bridge profiles: how to find the routing fields inside somebody else's QR
 * payload, without understanding the rest of it.
 *
 * This is the adopt-nothing path. A scouting app author does not have to
 * integrate anything, agree to anything, or even know Courier exists — the
 * Bridge scans the QR code their app already emits, extracts only the four
 * fields the envelope needs to route (event, match, team, scout), and carries
 * the ENTIRE original payload through untouched as the opaque body.
 *
 * That restraint is the product. Every previous attempt to unify FRC scouting
 * data tried to standardise what the payload MEANS and died, because teams have
 * a positive incentive to diverge — differing data is treated as competitive
 * advantage, and building the app is the pedagogical good mentors are buying.
 * A profile therefore describes only where four values sit. It never describes
 * what any other field means, and the Bridge never parses one.
 */

export type FieldRef = number | string;

export interface ProfileFields {
  /** Where the scout's own identifier sits. Hashed immediately; never stored raw. */
  scout: FieldRef;
  /** Match number (qualification) or a full TBA-style match key. */
  match: FieldRef;
  team: FieldRef;
  /** Optional: profiles that carry the event key can override the Bridge's configured one. */
  eventKey?: FieldRef;
}

export type ProfileFormat = 'delimited' | 'json';

export interface BridgeProfile {
  readonly id: string;
  readonly name: string;
  readonly format: ProfileFormat;
  /** For `delimited`: the separator. Ignored for `json`. */
  readonly delimiter?: string;
  /** Minimum field count for a payload to be considered a match. */
  readonly minFields?: number;
  readonly fields: ProfileFields;
  /**
   * How the `match` field reads: a bare number (qualification only), or a full
   * TBA match key that carries its own comp level and set.
   */
  readonly matchFormat: 'number' | 'key';
  /** The schema id stamped into sealed records from this profile. */
  readonly schemaId: string;
  /**
   * Whether the field positions have been confirmed against real output from
   * the named app. UNVERIFIED profiles are shipped as scaffolding and MUST be
   * checked against an actual export before an event — a wrong index silently
   * routes every record to the wrong team, which is worse than not ingesting.
   */
  readonly verified: boolean;
  readonly notes?: string;
}

export interface BridgeProfileSet {
  readonly version: number;
  readonly profiles: readonly BridgeProfile[];
}

export class ProfileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProfileError';
  }
}

const FIELD_NAMES = ['scout', 'match', 'team'] as const;

export function validateProfile(p: BridgeProfile): void {
  if (!p.id) throw new ProfileError('profile has no id');
  if (p.format !== 'delimited' && p.format !== 'json') {
    throw new ProfileError(`${p.id}: unknown format "${p.format}"`);
  }
  if (p.format === 'delimited' && !p.delimiter) {
    throw new ProfileError(`${p.id}: delimited profiles need a delimiter`);
  }
  for (const f of FIELD_NAMES) {
    const ref = p.fields[f];
    if (ref === undefined) throw new ProfileError(`${p.id}: missing field mapping for "${f}"`);
    if (p.format === 'delimited' && typeof ref !== 'number') {
      throw new ProfileError(`${p.id}: delimited profiles address fields by index, got "${ref}"`);
    }
    if (p.format === 'json' && typeof ref !== 'string') {
      throw new ProfileError(`${p.id}: json profiles address fields by key path, got ${ref}`);
    }
  }
  if (p.matchFormat !== 'number' && p.matchFormat !== 'key') {
    throw new ProfileError(`${p.id}: matchFormat must be "number" or "key"`);
  }
  if (!p.schemaId) throw new ProfileError(`${p.id}: missing schemaId`);
}

export function loadProfileSet(raw: unknown): BridgeProfileSet {
  if (typeof raw !== 'object' || raw === null) throw new ProfileError('profile set is not an object');
  const obj = raw as { version?: unknown; profiles?: unknown };
  if (typeof obj.version !== 'number') throw new ProfileError('profile set has no numeric version');
  if (!Array.isArray(obj.profiles)) throw new ProfileError('profile set has no profiles array');

  const profiles = obj.profiles as BridgeProfile[];
  const seen = new Set<string>();
  for (const p of profiles) {
    validateProfile(p);
    if (seen.has(p.id)) throw new ProfileError(`duplicate profile id "${p.id}"`);
    seen.add(p.id);
  }
  return { version: obj.version, profiles };
}

/** Read a field out of a parsed payload, by index or dotted key path. */
export function readField(
  payload: string[] | Record<string, unknown>,
  ref: FieldRef,
): string | undefined {
  if (Array.isArray(payload)) {
    if (typeof ref !== 'number') return undefined;
    const v = payload[ref];
    return v === undefined ? undefined : v.trim();
  }
  if (typeof ref !== 'string') return undefined;
  let cur: unknown = payload;
  for (const part of ref.split('.')) {
    if (typeof cur !== 'object' || cur === null) return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  if (cur === undefined || cur === null) return undefined;
  return String(cur).trim();
}

/**
 * Pick the profile that best fits a payload.
 *
 * Deliberately conservative: an ambiguous payload returns nothing rather than
 * guessing. Mis-routing a record to the wrong team is worse than refusing it,
 * because the refusal is visible at the scan and the mis-route is not.
 */
export function detectProfile(
  set: BridgeProfileSet,
  text: string,
): { profile: BridgeProfile; payload: string[] | Record<string, unknown> } | null {
  const trimmed = text.trim();
  const matches: Array<{
    profile: BridgeProfile;
    payload: string[] | Record<string, unknown>;
    score: number;
  }> = [];

  for (const profile of set.profiles) {
    if (profile.format === 'json') {
      if (!trimmed.startsWith('{')) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        continue;
      }
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) continue;
      const payload = parsed as Record<string, unknown>;
      if (!hasAllFields(payload, profile)) continue;
      matches.push({ profile, payload, score: Object.keys(payload).length });
    } else {
      if (trimmed.startsWith('{')) continue;
      const parts = trimmed.split(profile.delimiter!);
      if (parts.length < (profile.minFields ?? 3)) continue;
      if (!hasAllFields(parts, profile)) continue;
      matches.push({ profile, payload: parts, score: parts.length });
    }
  }

  if (matches.length === 0) return null;
  if (matches.length > 1) {
    // Prefer a verified profile over scaffolding; otherwise refuse to guess.
    const verified = matches.filter((m) => m.profile.verified);
    if (verified.length === 1) return { profile: verified[0]!.profile, payload: verified[0]!.payload };
    return null;
  }
  return { profile: matches[0]!.profile, payload: matches[0]!.payload };
}

function hasAllFields(
  payload: string[] | Record<string, unknown>,
  profile: BridgeProfile,
): boolean {
  for (const f of FIELD_NAMES) {
    const v = readField(payload, profile.fields[f]!);
    if (v === undefined || v === '') return false;
  }
  const team = readField(payload, profile.fields.team!);
  if (team === undefined || !/^\d{1,5}$/.test(team)) return false;
  const match = readField(payload, profile.fields.match!);
  if (match === undefined) return false;

  // Both match formats must be checked, not just the numeric one. Validating
  // only `number` left the key-format profile accepting bare numbers too, so
  // two otherwise-identical profiles both claimed every payload and detection
  // refused everything as ambiguous.
  if (profile.matchFormat === 'number') {
    if (!/^\d{1,4}$/.test(match)) return false;
  } else {
    if (!MATCH_KEY_RE.test(match)) return false;
  }
  return true;
}

/** A TBA-style match key: event key, underscore, then qm<n> or <level><set>m<n>. */
const MATCH_KEY_RE = /^[0-9a-z]{4,16}_(qm\d{1,4}|(?:ef|qf|sf|f)\d{1,4}m\d{1,4})$/;
