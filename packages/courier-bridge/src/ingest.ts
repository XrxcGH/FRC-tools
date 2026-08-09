/**
 * Scan ingestion: someone else's QR payload in, a signed Courier envelope out.
 *
 * The body of the sealed record is the ORIGINAL payload bytes, verbatim. The
 * Bridge reads four routing fields and then stops looking. It does not
 * normalise, re-encode, validate, or log the rest — so a team's schema stays
 * theirs, and their own decoder reads back exactly what their app wrote.
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
  readField,
  type BridgeProfile,
  type BridgeProfileSet,
} from './profiles.ts';

export type IngestStatus =
  | 'sealed'
  | 'duplicate-scan'
  | 'unmatched'
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
 * Duplicate-SCAN suppression.
 *
 * Two Bridge devices pointed at the same physical QR code should not both admit
 * it. This is keyed on the cleartext body hash — which is legitimate here and
 * ONLY here. It is a different layer from record-level deduplication, which is
 * keyed on record-id precisely so that two scouts producing byte-identical
 * bodies both survive (spec/canonical-cbor.md §3). Confusing the two would
 * silently destroy the double-scouting signal.
 */
export class ScanSuppressor {
  readonly #seen = new Set<string>();

  /** Returns true if this exact payload has already been scanned here. */
  seen(body: Uint8Array): boolean {
    return this.#seen.has(toHex(hash256(body)));
  }

  remember(body: Uint8Array): void {
    this.#seen.add(toHex(hash256(body)));
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

  if (suppressor?.seen(body)) {
    return { status: 'duplicate-scan' };
  }

  const detected = detectProfile(ctx.profiles, text);
  if (!detected) {
    return {
      status: 'unmatched',
      reason:
        'no bridge profile fits this payload. Add one to bridge_profiles.json, or the ' +
        'payload may be ambiguous between two profiles — in which case it is refused rather ' +
        'than guessed at.',
    };
  }

  const { profile, payload } = detected;

  const teamRaw = readField(payload, profile.fields.team)!;
  const matchRaw = readField(payload, profile.fields.match)!;
  const scoutRaw = readField(payload, profile.fields.scout)!;
  const eventRaw = profile.fields.eventKey
    ? readField(payload, profile.fields.eventKey)
    : undefined;

  const eventKey = eventRaw && eventRaw.length >= 4 ? eventRaw : ctx.eventKey;
  if (eventKey !== ctx.eventKey) {
    return {
      status: 'wrong-event',
      profileId: profile.id,
      reason: `payload is for event "${eventKey}" but this Bridge is configured for "${ctx.eventKey}"`,
    };
  }

  let match: number;
  try {
    match =
      profile.matchFormat === 'key'
        ? parseMatchKey(matchRaw).packed
        : packMatch({ level: 'qm', set: 0, number: Number(matchRaw) });
  } catch (err) {
    return {
      status: 'invalid',
      profileId: profile.id,
      reason: `could not read match from "${matchRaw}": ${(err as Error).message}`,
    };
  }

  const team = Number(teamRaw);

  try {
    const record = makeRecord({
      eventKey,
      match,
      team,
      // The scout's own identifier never leaves this device in raw form. It is
      // hashed into a per-event pseudonym at seal time (D-6).
      scout: mintScoutPseudonym(scoutRaw, eventKey, ctx.meshKey),
      schema: profile.schemaId,
      body,
      sealedAt: (ctx.now ?? Date.now)(),
    });

    const envelope = sealRecord(record, ctx.device);
    suppressor?.remember(body);

    return {
      status: 'sealed',
      envelope,
      record,
      profileId: profile.id,
      unverifiedProfile: !profile.verified,
    };
  } catch (err) {
    return {
      status: 'invalid',
      profileId: profile.id,
      reason: (err as Error).message,
    };
  }
}

export interface BatchSummary {
  sealed: number;
  duplicateScan: number;
  unmatched: number;
  invalid: number;
  wrongEvent: number;
  envelopes: Uint8Array[];
  /** Profiles used that have not been confirmed against real app output. */
  unverifiedProfilesUsed: Set<string>;
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
    invalid: 0,
    wrongEvent: 0,
    envelopes: [],
    unverifiedProfilesUsed: new Set(),
    reasons: [],
  };

  for (const text of texts) {
    if (!text.trim()) continue;
    const r = ingestScan(text, ctx, suppressor);
    switch (r.status) {
      case 'sealed':
        s.sealed++;
        s.envelopes.push(r.envelope!);
        if (r.unverifiedProfile) s.unverifiedProfilesUsed.add(r.profileId!);
        break;
      case 'duplicate-scan':
        s.duplicateScan++;
        break;
      case 'unmatched':
        s.unmatched++;
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
