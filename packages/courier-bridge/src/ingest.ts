/**
 * Scan ingestion: someone else's QR payload in, a signed Courier envelope out.
 *
 * The body of the sealed record is the ORIGINAL payload bytes, verbatim. The
 * Bridge reads four routing fields and then stops looking. It does not
 * normalise, re-encode, validate, or log the rest — so a team's schema stays
 * theirs, and their own decoder reads back exactly what their app wrote.
 *
 * ── What that costs, stated plainly ─────────────────────────────────────────
 * Verbatim bodies and PII minimisation are in direct tension, and on the Bridge
 * path PII minimisation loses.
 *
 * A profile must be able to READ the scout's identifier in order to mint a
 * pseudonym from it. The body is the payload verbatim. Therefore the raw scout
 * identifier — often a real first name — is inside every Bridge-sealed record,
 * recoverable by anyone the record reaches.
 *
 * The `scout` FIELD is a per-event pseudonym and does provide unlinkability
 * across events for anything that reads that field. But the pseudonym is not a
 * privacy guarantee here: the cleartext sits forty bytes away in the same signed
 * record. Any claim that "no raw identifier ever enters a record" is false for
 * this path, and every profile declares `scoutIdInBody` so the UI and store
 * listing can say so rather than implying a posture the Bridge does not have.
 *
 * Two honest mitigations, neither of which is a fix:
 *   - Tell scouts to use a handle, not their name. This is a policy, not a
 *     control, and it will be forgotten.
 *   - Use the plugin path instead, where the app hands Courier a body it chose
 *     and the scout id can be omitted from it entirely.
 */

import {
  makeRecord,
  sealRecord,
  mintScoutPseudonym,
  parseMatchKey,
  packMatch,
  hash256,
  toHex,
  utf8,
  type CourierRecord,
  type DeviceKeyPair,
} from '@courier/core';
import {
  detectProfile,
  matchingProfiles,
  readField,
  type BridgeProfileSet,
} from './profiles.ts';

export type IngestStatus =
  | 'sealed'
  | 'duplicate-scan'
  | 'unmatched'
  | 'ambiguous'
  | 'invalid'
  | 'wrong-event';

export interface IngestResult {
  readonly status: IngestStatus;
  readonly envelope?: Uint8Array;
  readonly record?: CourierRecord;
  readonly profileId?: string;
  readonly reason?: string;
  /** Set when the profile used has not been confirmed against real app output. */
  readonly unverifiedProfile?: boolean;
  /** True when the raw scout identifier is inside the sealed body. Usually true. */
  readonly scoutIdInBody?: boolean;
}

export interface BridgeContext {
  readonly profiles: BridgeProfileSet;
  /** The Bridge is configured for one event; payloads claiming another are refused. */
  readonly eventKey: string;
  readonly meshKey: Uint8Array;
  readonly device: DeviceKeyPair;
  /** Injectable for tests; defaults to the wall clock. */
  readonly now?: () => number;
}

/**
 * Duplicate-SCAN suppression, on THIS DEVICE ONLY.
 *
 * Two scans of the same physical QR code on the same Bridge are collapsed. It
 * is an in-memory set with no sharing and no persistence, so it does NOT
 * deduplicate across two Bridge devices scanning the same code, and it forgets
 * everything on restart. Those cases are handled downstream instead:
 * `currentForObservation` collapses records by scout pseudonym, so the picklist
 * is correct either way — the cost of a missed suppression is inflated record
 * counts and storage, not a wrong answer.
 *
 * Keyed on the cleartext body hash, which is legitimate here and ONLY here. It
 * is a different layer from record-level deduplication, which is keyed on
 * record-id precisely so two scouts producing byte-identical bodies both
 * survive (spec/canonical-cbor.md §3).
 */
export class ScanSuppressor {
  readonly #seen = new Set<string>();

  /** Record the payload and report whether it had already been seen here. */
  checkAndRemember(body: Uint8Array): boolean {
    const key = toHex(hash256(body));
    if (this.#seen.has(key)) return true;
    this.#seen.add(key);
    return false;
  }

  seen(body: Uint8Array): boolean {
    return this.#seen.has(toHex(hash256(body)));
  }

  get size(): number {
    return this.#seen.size;
  }
}

export function ingestScan(
  text: string,
  ctx: BridgeContext,
  suppressor?: ScanSuppressor,
): IngestResult {
  const body = utf8(text);

  if (suppressor?.seen(body)) return { status: 'duplicate-scan' };

  const detected = detectProfile(ctx.profiles, text);
  if (!detected) {
    // Distinguish "nothing fits" from "several fit", because they need
    // different fixes and both are refusals.
    const candidates = matchingProfiles(ctx.profiles, text);
    if (candidates.length > 1) {
      return {
        status: 'ambiguous',
        reason:
          `payload fits ${candidates.length} profiles (${candidates
            .map((c) => c.profile.id)
            .join(', ')}). Refused rather than routed by guess: picking one would read match ` +
          `and team from whichever column order won, silently. Add an exactFields discriminator.`,
      };
    }
    return {
      status: 'unmatched',
      reason: 'no bridge profile fits this payload. Add one to bridge_profiles.json.',
    };
  }

  const { profile, payload } = detected;

  const teamRaw = readField(payload, profile.fields.team)!;
  const matchRaw = readField(payload, profile.fields.match)!;
  const scoutRaw = readField(payload, profile.fields.scout)!;

  // Resolve the event key. Three distinct cases, deliberately not collapsed:
  // absent (use ours), present and foreign (refuse), present and malformed
  // (refuse). Treating malformed as absent silently re-homes another event's
  // data into this one.
  let eventKey = ctx.eventKey;
  if (profile.fields.eventKey !== undefined) {
    const raw = readField(payload, profile.fields.eventKey);
    if (raw !== undefined && raw !== '') {
      if (raw.length < 4) {
        return {
          status: 'invalid',
          profileId: profile.id,
          reason: `payload declares event "${raw}", which is too short to be an event key`,
        };
      }
      if (raw !== ctx.eventKey) {
        return {
          status: 'wrong-event',
          profileId: profile.id,
          reason: `payload is for event "${raw}" but this Bridge is configured for "${ctx.eventKey}"`,
        };
      }
      eventKey = raw;
    }
  }

  let match: number;
  try {
    if (profile.matchFormat === 'key') {
      // A full match key carries its own event key. Dropping it — as an earlier
      // version did — lets last week's practice event seal into this week's
      // dataset with no signal at all.
      const parsed = parseMatchKey(matchRaw);
      if (parsed.eventKey !== ctx.eventKey) {
        return {
          status: 'wrong-event',
          profileId: profile.id,
          reason:
            `match key "${matchRaw}" is for event "${parsed.eventKey}" but this Bridge is ` +
            `configured for "${ctx.eventKey}"`,
        };
      }
      match = parsed.packed;
    } else {
      match = packMatch({ level: 'qm', set: 0, number: Number(matchRaw) });
    }
  } catch (err) {
    return {
      status: 'invalid',
      profileId: profile.id,
      reason: `could not read match from "${matchRaw}": ${(err as Error).message}`,
    };
  }

  try {
    const record = makeRecord({
      eventKey,
      match,
      team: Number(teamRaw),
      // Minted here, and placed in the signed record from the start (D-6). Note
      // that this does NOT remove the raw identifier from the body — see the
      // module header.
      scout: mintScoutPseudonym(scoutRaw, eventKey, ctx.meshKey),
      schema: profile.schemaId,
      body,
      sealedAt: (ctx.now ?? Date.now)(),
    });

    const envelope = sealRecord(record, ctx.device);
    suppressor?.checkAndRemember(body);

    return {
      status: 'sealed',
      envelope,
      record,
      profileId: profile.id,
      unverifiedProfile: !profile.verified,
      scoutIdInBody: profile.scoutIdInBody,
    };
  } catch (err) {
    return { status: 'invalid', profileId: profile.id, reason: (err as Error).message };
  }
}

export interface BatchSummary {
  sealed: number;
  duplicateScan: number;
  unmatched: number;
  ambiguous: number;
  invalid: number;
  wrongEvent: number;
  /** Blank or whitespace-only inputs, counted so the summary sums to the input. */
  blank: number;
  envelopes: Uint8Array[];
  unverifiedProfilesUsed: Set<string>;
  /** True if any sealed record carries a raw scout identifier in its body. */
  scoutIdInBody: boolean;
  reasons: string[];
}

/** Ingest a batch — a stack of QR scans, or the lines of an exported file. */
export function ingestBatch(
  texts: readonly string[],
  ctx: BridgeContext,
  suppressor: ScanSuppressor = new ScanSuppressor(),
): BatchSummary {
  const s: BatchSummary = {
    sealed: 0,
    duplicateScan: 0,
    unmatched: 0,
    ambiguous: 0,
    invalid: 0,
    wrongEvent: 0,
    blank: 0,
    envelopes: [],
    unverifiedProfilesUsed: new Set(),
    scoutIdInBody: false,
    reasons: [],
  };

  for (const text of texts) {
    if (!text.trim()) {
      s.blank++;
      continue;
    }
    const r = ingestScan(text, ctx, suppressor);
    switch (r.status) {
      case 'sealed':
        s.sealed++;
        s.envelopes.push(r.envelope!);
        if (r.unverifiedProfile) s.unverifiedProfilesUsed.add(r.profileId!);
        if (r.scoutIdInBody) s.scoutIdInBody = true;
        break;
      case 'duplicate-scan':
        s.duplicateScan++;
        break;
      case 'unmatched':
        s.unmatched++;
        if (r.reason) s.reasons.push(r.reason);
        break;
      case 'ambiguous':
        s.ambiguous++;
        if (r.reason) s.reasons.push(r.reason);
        break;
      case 'wrong-event':
        s.wrongEvent++;
        if (r.reason) s.reasons.push(r.reason);
        break;
      case 'invalid':
        s.invalid++;
        if (r.reason) s.reasons.push(r.reason);
        break;
    }
  }
  return s;
}
