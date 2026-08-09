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
 * a positive incentive to diverge.
 *
 * ── The one rule ────────────────────────────────────────────────────────────
 * NEVER MIS-ROUTE. A refusal is visible at the scan and someone fixes it; a
 * mis-route is invisible until picklist night, when a robot's data turns out to
 * be under another team's number. Every ambiguity here resolves to refusal.
 */

export type FieldRef = number | string | readonly string[];

export interface ProfileFields {
  /**
   * Where the scout's own identifier sits.
   *
   * Note carefully: this is read to MINT A PSEUDONYM, but the raw value also
   * remains inside the opaque body, because the body is the original payload
   * verbatim. See `scoutIdInBody` on the profile.
   */
  scout: FieldRef;
  /** Match number (qualification) or a full TBA-style match key. */
  match: FieldRef;
  team: FieldRef;
  /** Optional: profiles whose payload carries the event key. */
  eventKey?: FieldRef;
}

export type ProfileFormat = 'delimited' | 'json';

export interface BridgeProfile {
  readonly id: string;
  readonly name: string;
  readonly format: ProfileFormat;
  /**
   * For `delimited`: the separator.
   *
   * Must be a character the source app cannot emit inside a field value, because
   * there is no quoting support and none is planned — an RFC-4180 parser here
   * would be a second place for the payload's structure to be misunderstood.
   * Tab is the safe choice and the only one shipped. A comma delimiter is
   * rejected outright: a scout name containing a comma silently shifts every
   * column, which is the exact failure this module exists to prevent.
   */
  readonly delimiter?: string;
  /** Minimum field count for a payload to be considered a match. */
  readonly minFields?: number;
  /** Exact field count. Use it as a discriminator between similar profiles. */
  readonly exactFields?: number;
  readonly fields: ProfileFields;
  readonly matchFormat: 'number' | 'key';
  readonly schemaId: string;
  /**
   * Whether the field positions have been confirmed against real output from
   * the named app. UNVERIFIED profiles must never ship in the active set — a
   * wrong index silently routes every record to the wrong team.
   */
  readonly verified: boolean;
  /**
   * True when the scout's raw identifier is present in the payload and
   * therefore inside the sealed body.
   *
   * This is true for every profile that can exist, because a profile must be
   * able to READ the scout id to mint a pseudonym, and the body is the payload
   * verbatim. It is a declared field rather than an implicit fact so that the
   * UI and the store listing can say so plainly instead of implying a zero-PII
   * posture the Bridge path does not have.
   */
  readonly scoutIdInBody: boolean;
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

/** Delimiters that cannot appear inside a field value in any app we accept. */
const ALLOWED_DELIMITERS = new Set(['\t', '', '|']);

function isFieldRef(v: unknown, format: ProfileFormat): boolean {
  if (format === 'delimited') return typeof v === 'number' && Number.isInteger(v) && v >= 0;
  return typeof v === 'string' || (Array.isArray(v) && v.every((s) => typeof s === 'string'));
}

export function validateProfile(p: BridgeProfile): void {
  if (!p.id) throw new ProfileError('profile has no id');
  if (p.format !== 'delimited' && p.format !== 'json') {
    throw new ProfileError(`${p.id}: unknown format "${p.format}"`);
  }
  // `verified` flips the safety posture, so its type is enforced rather than
  // coerced: a JSON edit producing the string "false" is truthy.
  if (typeof p.verified !== 'boolean') {
    throw new ProfileError(`${p.id}: "verified" must be a boolean, got ${typeof p.verified}`);
  }
  if (typeof p.scoutIdInBody !== 'boolean') {
    throw new ProfileError(`${p.id}: "scoutIdInBody" must be a boolean`);
  }
  if (p.format === 'delimited') {
    if (!p.delimiter) throw new ProfileError(`${p.id}: delimited profiles need a delimiter`);
    if (!ALLOWED_DELIMITERS.has(p.delimiter)) {
      throw new ProfileError(
        `${p.id}: delimiter ${JSON.stringify(p.delimiter)} is not permitted. There is no quoting ` +
          `support, so a delimiter that can appear inside a field value silently shifts every ` +
          `column. Permitted: tab, unit separator, pipe.`,
      );
    }
  }
  for (const key of ['minFields', 'exactFields'] as const) {
    const v = p[key];
    if (v !== undefined && (!Number.isInteger(v) || v < 1)) {
      throw new ProfileError(`${p.id}: ${key} must be a positive integer`);
    }
  }
  for (const f of FIELD_NAMES) {
    const ref = p.fields[f];
    if (ref === undefined) throw new ProfileError(`${p.id}: missing field mapping for "${f}"`);
    if (!isFieldRef(ref, p.format)) {
      throw new ProfileError(
        `${p.id}: field "${f}" must be ${
          p.format === 'delimited' ? 'a non-negative integer index' : 'a key path'
        }`,
      );
    }
  }
  if (p.fields.eventKey !== undefined && !isFieldRef(p.fields.eventKey, p.format)) {
    throw new ProfileError(`${p.id}: field "eventKey" has the wrong shape`);
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

/**
 * Strip only what is never part of the data: a BOM and trailing line endings.
 *
 * NOT `trim()`. Tab is a whitespace character, so trimming a tab-delimited
 * payload eats an empty leading column — and a scout who left the name field
 * blank is an ordinary event-day occurrence, not an edge case. The result is
 * every field shifting left by one and the record sealing under a wrong team.
 */
function stripEnvelopeWhitespace(s: string): string {
  return s.replace(/^﻿/, '').replace(/[\r\n]+$/, '');
}

/** Read a field by index, dotted path, or exact path segments. */
export function readField(
  payload: string[] | Record<string, unknown>,
  ref: FieldRef,
): string | undefined {
  if (Array.isArray(payload)) {
    if (typeof ref !== 'number') return undefined;
    const v = payload[ref];
    return v === undefined ? undefined : v.trim();
  }
  if (typeof ref === 'number') return undefined;

  // A dotted string is shorthand; an array addresses segments exactly, which is
  // the only way to reach a key that legitimately contains a dot.
  const segments = typeof ref === 'string' ? ref.split('.') : ref;
  let cur: unknown = payload;
  for (const part of segments) {
    if (typeof cur !== 'object' || cur === null) return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  if (cur === undefined || cur === null) return undefined;
  return String(cur).trim();
}

export interface DetectResult {
  readonly profile: BridgeProfile;
  readonly payload: string[] | Record<string, unknown>;
}

/**
 * Pick the profile for a payload, or refuse.
 *
 * If more than one profile fits, this returns null. It does NOT prefer the
 * verified one: "verified" means a profile's indices are right for payloads
 * *from that app*, and says nothing about whether *this* payload came from it.
 * Preferring it routes app-specific payloads through generic indices — which is
 * silent mis-routing, the one thing this module must never do.
 *
 * The practical consequence is that a shipped profile set must contain mutually
 * exclusive profiles. That is a constraint on the set, enforced by
 * `assertUnambiguous`, not something to paper over at detection time.
 */
export function detectProfile(set: BridgeProfileSet, text: string): DetectResult | null {
  const matches = matchingProfiles(set, text);
  return matches.length === 1 ? matches[0]! : null;
}

/** Every profile that structurally fits. Exposed so ambiguity can be reported. */
export function matchingProfiles(set: BridgeProfileSet, text: string): DetectResult[] {
  const jsonText = text.trim();
  const delimitedText = stripEnvelopeWhitespace(text);
  const out: DetectResult[] = [];

  for (const profile of set.profiles) {
    if (profile.format === 'json') {
      if (!jsonText.startsWith('{')) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(jsonText);
      } catch {
        continue;
      }
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) continue;
      const payload = parsed as Record<string, unknown>;
      if (!hasAllFields(payload, profile)) continue;
      out.push({ profile, payload });
    } else {
      if (jsonText.startsWith('{')) continue;
      const parts = delimitedText.split(profile.delimiter!);
      if (profile.exactFields !== undefined && parts.length !== profile.exactFields) continue;
      if (parts.length < (profile.minFields ?? 3)) continue;
      if (!hasAllFields(parts, profile)) continue;
      out.push({ profile, payload: parts });
    }
  }
  return out;
}

/**
 * Assert that no payload in `corpus` fits more than one profile.
 *
 * A shipped profile set must be mutually exclusive, because detection refuses
 * ambiguity rather than resolving it. This turns that requirement into
 * something a test can enforce instead of a property someone remembers.
 */
export function assertUnambiguous(set: BridgeProfileSet, corpus: readonly string[]): void {
  for (const text of corpus) {
    const hits = matchingProfiles(set, text);
    if (hits.length > 1) {
      throw new ProfileError(
        `payload ${JSON.stringify(text.slice(0, 60))} fits ${hits.length} profiles ` +
          `(${hits.map((h) => h.profile.id).join(', ')}). A shipped set must be mutually ` +
          `exclusive — add an exactFields discriminator, or move one profile out of the ` +
          `active set.`,
      );
    }
  }
}

/** A TBA-style match key: event key, underscore, then qm<n> or <level><set>m<n>. */
const MATCH_KEY_RE = /^[0-9a-z]{4,16}_(qm\d{1,4}|(?:ef|qf|sf|f)\d{1,4}m\d{1,4})$/;

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
  if (profile.matchFormat === 'number') {
    if (!/^\d{1,4}$/.test(match)) return false;
  } else {
    if (!MATCH_KEY_RE.test(match)) return false;
  }
  return true;
}
