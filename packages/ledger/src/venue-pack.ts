/**
 * Venue packs — the event, in a file, for a pit with no internet.
 *
 * The research found no offline mirror of FRC ratings that a team can carry
 * into a venue. Every event-day tool assumes an uplink that convention centres
 * do not provide, and the 6 GHz field radios made the pit RF environment worse
 * rather than better. So: generate a pack the night before on hotel wifi, fan
 * it out over Courier or a flash drive, and be independent of the network for
 * the rest of the event.
 *
 * ── Staleness is a first-class field, not a footnote ────────────────────────
 * A pack is a snapshot and starts going stale the moment it is written. Two
 * fields say so explicitly, because the alternative is a picklist built on
 * yesterday's numbers with nothing on screen to say so:
 *
 *   `generatedAt`           — when the snapshot was taken.
 *   `officialResultsAsOfMatch` — the last match whose official result is in it.
 *
 * That second field exists because of a hole the design review found: Saturday's
 * official alliance totals cannot reach a pit with no uplink, so any analysis
 * that needs them is running unconstrained until someone carries them in
 * (D-5). A consumer that ignores this field will silently present stale
 * analysis as current.
 */

import {
  encode,
  decode,
  expectMap,
  expectArray,
  expectBytes,
  expectText,
  expectUint,
  hash256,
  toHex,
  sign,
  verify,
  deriveKeyId,
  CborError,
  type CborKey,
  type CborValue,
  type DeviceKeyPair,
} from '@courier/core';
import { attributionFor, type SourceId } from './sources.ts';

export const VENUE_PACK_VERSION = 1;
/** Reserved Courier schema id, so a pack can ride the transport it needs anyway. */
export const VENUE_PACK_SCHEMA_ID = 'courier.venuepack.v1';

export class VenuePackError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VenuePackError';
  }
}

export interface TeamEntry {
  readonly team: number;
  /** Short display name. Team nicknames are public data, not personal data. */
  readonly nickname: string;
}

export interface MatchEntry {
  /** Packed comp level / set / number — see @courier/core matchkey. */
  readonly match: number;
  readonly red: readonly number[];
  readonly blue: readonly number[];
  /** Official alliance totals, present only once the match has been played. */
  readonly redScore?: number;
  readonly blueScore?: number;
}

export interface RatingEntry {
  readonly team: number;
  /** Point estimate, in this season's units. */
  readonly mean: number;
  /**
   * Standard deviation. Not optional.
   *
   * A picklist needs variance: second-pick decisions are floor-driven, and a
   * rating without uncertainty cannot express a floor. Every shipped tool
   * displays a point estimate and hides the spread, which is precisely the gap
   * this field exists to close.
   */
  readonly sigma: number;
  readonly matchesPlayed: number;
}

export interface VenuePack {
  readonly version: number;
  readonly eventKey: string;
  readonly generatedAt: number;
  /** Last match whose official result is included. 0 when none are. */
  readonly officialResultsAsOfMatch: number;
  readonly attribution: string;
  readonly seasonPackId: string;
  readonly teams: readonly TeamEntry[];
  readonly matches: readonly MatchEntry[];
  readonly ratings: readonly RatingEntry[];
}

export interface SignedVenuePack {
  readonly pack: VenuePack;
  readonly kid: Uint8Array;
  /** BLAKE3 of the canonical payload — the pack's content address. */
  readonly digest: Uint8Array;
}

/* -------------------------------------------------------------------------- */
/* Encoding                                                                    */
/* -------------------------------------------------------------------------- */

const P_VERSION = 1;
const P_EVENT = 2;
const P_GENERATED = 3;
const P_AS_OF = 4;
const P_ATTRIBUTION = 5;
const P_SEASON_PACK = 6;
const P_TEAMS = 7;
const P_MATCHES = 8;
const P_RATINGS = 9;

/** Ratings are stored as integers scaled by 1000; the format has no floats. */
const SCALE = 1000;

function encodePayload(pack: VenuePack): Uint8Array {
  return encode(
    new Map<CborKey, CborValue>([
      [P_VERSION, pack.version],
      [P_EVENT, pack.eventKey],
      [P_GENERATED, pack.generatedAt],
      [P_AS_OF, pack.officialResultsAsOfMatch],
      [P_ATTRIBUTION, pack.attribution],
      [P_SEASON_PACK, pack.seasonPackId],
      [P_TEAMS, pack.teams.map((t) => [t.team, t.nickname] as CborValue)],
      [
        P_MATCHES,
        pack.matches.map(
          (m) =>
            [
              m.match,
              m.red as CborValue,
              m.blue as CborValue,
              m.redScore ?? -1,
              m.blueScore ?? -1,
            ] as CborValue,
        ),
      ],
      [
        P_RATINGS,
        pack.ratings.map(
          (r) =>
            [
              r.team,
              Math.round(r.mean * SCALE),
              Math.round(r.sigma * SCALE),
              r.matchesPlayed,
            ] as CborValue,
        ),
      ],
    ]),
  );
}

function decodePayload(bytes: Uint8Array): VenuePack {
  let m;
  try {
    m = expectMap(decode(bytes), 'venue pack');
  } catch (err) {
    if (err instanceof CborError) throw new VenuePackError(`malformed venue pack: ${err.message}`);
    throw err;
  }

  const version = expectUint(m.get(P_VERSION), 'version');
  if (version !== VENUE_PACK_VERSION) {
    throw new VenuePackError(`unsupported venue pack version ${version}`);
  }

  const teams = expectArray(m.get(P_TEAMS), 'teams').map((t) => {
    const a = expectArray(t, 'team');
    return { team: expectUint(a[0], 'team number'), nickname: expectText(a[1], 'nickname') };
  });

  const matches = expectArray(m.get(P_MATCHES), 'matches').map((x) => {
    const a = expectArray(x, 'match');
    const red = expectArray(a[1], 'red alliance').map((n) => expectUint(n, 'team'));
    const blue = expectArray(a[2], 'blue alliance').map((n) => expectUint(n, 'team'));
    const redScore = a[3] as number;
    const blueScore = a[4] as number;
    return {
      match: expectUint(a[0], 'match'),
      red,
      blue,
      // -1 is the sentinel for "not yet played", so an unplayed match is
      // distinguishable from a genuine 0-0 result.
      ...(redScore >= 0 ? { redScore } : {}),
      ...(blueScore >= 0 ? { blueScore } : {}),
    };
  });

  const ratings = expectArray(m.get(P_RATINGS), 'ratings').map((x) => {
    const a = expectArray(x, 'rating');
    return {
      team: expectUint(a[0], 'team'),
      mean: (a[1] as number) / SCALE,
      sigma: (a[2] as number) / SCALE,
      matchesPlayed: expectUint(a[3], 'matchesPlayed'),
    };
  });

  return {
    version,
    eventKey: expectText(m.get(P_EVENT), 'event key'),
    generatedAt: expectUint(m.get(P_GENERATED), 'generatedAt'),
    officialResultsAsOfMatch: expectUint(m.get(P_AS_OF), 'officialResultsAsOfMatch'),
    attribution: expectText(m.get(P_ATTRIBUTION), 'attribution'),
    seasonPackId: expectText(m.get(P_SEASON_PACK), 'season pack id'),
    teams,
    matches,
    ratings,
  };
}

/* -------------------------------------------------------------------------- */
/* Signing                                                                     */
/* -------------------------------------------------------------------------- */

const S_PAYLOAD = 1;
const S_KID = 2;
const S_SIG = 3;

export interface BuildVenuePackInput {
  readonly eventKey: string;
  readonly generatedAt: number;
  readonly officialResultsAsOfMatch: number;
  readonly sources: readonly SourceId[];
  readonly seasonPackId: string;
  readonly teams: readonly TeamEntry[];
  readonly matches: readonly MatchEntry[];
  readonly ratings: readonly RatingEntry[];
}

/**
 * Build and sign a pack.
 *
 * Signed because a pack travels by flash drive and BLE between devices that
 * have no way to check where it came from. Unlike a Courier bundle — whose
 * contents are individually signed records, making the container's provenance
 * irrelevant — a venue pack is a single aggregate assertion, so the container
 * is exactly what has to be authenticated.
 */
export function buildVenuePack(input: BuildVenuePackInput, key: DeviceKeyPair): Uint8Array {
  if (input.sources.length === 0) {
    throw new VenuePackError('a pack must name its sources so attribution can be emitted');
  }
  const pack: VenuePack = {
    version: VENUE_PACK_VERSION,
    eventKey: input.eventKey,
    generatedAt: input.generatedAt,
    officialResultsAsOfMatch: input.officialResultsAsOfMatch,
    attribution: attributionFor(input.sources),
    seasonPackId: input.seasonPackId,
    teams: input.teams,
    matches: input.matches,
    ratings: input.ratings,
  };

  const payload = encodePayload(pack);
  return encode(
    new Map<CborKey, CborValue>([
      [S_PAYLOAD, payload],
      [S_KID, key.kid],
      [S_SIG, sign(payload, key.secretKey)],
    ]),
  );
}

export type VenuePackKeyResolver = (kid: Uint8Array) => Uint8Array | undefined;

export function openVenuePack(
  bytes: Uint8Array,
  resolveKey: VenuePackKeyResolver,
): SignedVenuePack {
  let m;
  try {
    m = expectMap(decode(bytes), 'signed venue pack');
  } catch (err) {
    if (err instanceof CborError) throw new VenuePackError(`malformed venue pack: ${err.message}`);
    throw err;
  }

  const payload = expectBytes(m.get(S_PAYLOAD), 'payload');
  const kid = expectBytes(m.get(S_KID), 'kid', 8);
  const signature = expectBytes(m.get(S_SIG), 'signature', 64);

  const publicKey = resolveKey(kid);
  if (!publicKey) throw new VenuePackError(`venue pack signed by unknown key ${toHex(kid)}`);
  if (toHex(deriveKeyId(publicKey)) !== toHex(kid)) {
    throw new VenuePackError(`resolver returned a key whose id is not ${toHex(kid)}`);
  }
  if (!verify(signature, payload, publicKey)) {
    throw new VenuePackError(`venue pack signature does not verify for key ${toHex(kid)}`);
  }

  return { pack: decodePayload(payload), kid, digest: hash256(payload) };
}

/* -------------------------------------------------------------------------- */
/* Staleness                                                                   */
/* -------------------------------------------------------------------------- */

export interface Staleness {
  readonly ageMs: number;
  readonly ageLabel: string;
  /** Matches played at the event that this pack has no official result for. */
  readonly matchesBehind: number;
  /** True when analysis depending on official totals is running unconstrained. */
  readonly resultsIncomplete: boolean;
}

/**
 * Describe how out of date a pack is, for a banner that must always be on
 * screen. Returning a struct rather than a boolean because "is it stale" has no
 * single right threshold — a schedule is fine a day old, a rating is not.
 */
export function describeStaleness(
  pack: VenuePack,
  now: number,
  lastPlayedMatch = pack.officialResultsAsOfMatch,
): Staleness {
  const ageMs = Math.max(0, now - pack.generatedAt);
  const hours = ageMs / 3_600_000;
  const ageLabel =
    hours < 1
      ? `${Math.round(ageMs / 60_000)} min old`
      : hours < 48
        ? `${Math.round(hours)} h old`
        : `${Math.round(hours / 24)} days old`;

  const matchesBehind = Math.max(0, lastPlayedMatch - pack.officialResultsAsOfMatch);
  return {
    ageMs,
    ageLabel,
    matchesBehind,
    resultsIncomplete: matchesBehind > 0,
  };
}
