/**
 * Signing and distributing a Season Pack.
 *
 * A pack tells downstream tools what the official scoring fields MEAN. A forged
 * one silently changes what every consumer computes — points per game piece,
 * which fields are additive, where the ranking-point thresholds sit — and the
 * wrongness would surface as a picklist that is subtly bad rather than as an
 * error. So packs are signed.
 *
 * ── The threshold, and why it is not higher ─────────────────────────────────
 * DESIGN.md §0 D-18: **1-of-2 for MINOR and PATCH, 2-of-2 for MAJOR.**
 *
 * The temptation is to require two signatures always. That fails the first time
 * a signer is on a plane, and the deadline it fails is the one the design calls
 * terminal on a single miss: the kickoff sprint, where a pack must ship within
 * 72 hours of a game nobody has seen, in January, staffed by volunteers who are
 * also building a robot.
 *
 * So routine releases need one signature and can ship at 2 a.m. from a hotel.
 * MAJOR releases — a field removed, renamed, or given different semantics, the
 * changes that break every consumer — need two, because those are worth waking
 * someone up for.
 *
 * The release kind is asserted in the signed envelope and must be checked
 * against `classifyChange` in CI. Asserting it is not the same as it being
 * true; the signature binds the assertion, and CI binds it to reality.
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
  timingSafeEqual,
  utf8,
  CborError,
  type CborKey,
  type CborValue,
  type DeviceKeyPair,
} from '@courier/core';
import { PackError, classifyChange, type ChangeKind, type SeasonPack } from './pack.ts';

/** Reserved Courier schema id, so a pack can ride the transport it needs anyway. */
export const SEASON_PACK_SCHEMA_ID = 'courier.seasonpack.v1';
const SIGNING_CONTEXT = 'courier-seasonpack-v1';

const E_PAYLOAD = 1;
const E_RELEASE_KIND = 2;
const E_SIGNATURES = 3;

export type ReleaseKind = Extract<ChangeKind, 'major' | 'minor' | 'patch'>;

export interface PackSignature {
  readonly kid: Uint8Array;
  readonly signature: Uint8Array;
}

export interface SignedPack {
  readonly pack: SeasonPack;
  readonly releaseKind: ReleaseKind;
  readonly signers: readonly Uint8Array[];
  /** BLAKE3 of the signed payload — the pack's content address. */
  readonly digest: Uint8Array;
}

export type PackKeyResolver = (kid: Uint8Array) => Uint8Array | undefined;

/** Signatures required for a release of this kind (D-18). */
export function requiredSignatures(kind: ReleaseKind): number {
  return kind === 'major' ? 2 : 1;
}

/**
 * Canonical bytes actually signed.
 *
 * The release kind is inside the signed material. Otherwise an attacker could
 * take a validly signed MINOR pack and relabel it MAJOR — or, worse, strip a
 * MAJOR down to MINOR so it passes with one signature.
 */
function signingPayload(packJson: string, kind: ReleaseKind): Uint8Array {
  return encode([SIGNING_CONTEXT, kind, packJson]);
}

/**
 * Packs are canonicalised as sorted-key JSON rather than CBOR.
 *
 * Deliberate: a pack is edited by humans in a text editor during a 72-hour
 * sprint, reviewed in a pull request, and consumed by tools in half a dozen
 * languages. JSON is what all of those already handle. The canonical form is
 * only needed so two people producing the same pack produce the same bytes.
 */
export function canonicalPackJson(pack: SeasonPack): string {
  return JSON.stringify(sortKeys(pack));
}

function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v as Record<string, unknown>).sort()) {
      const value = (v as Record<string, unknown>)[k];
      if (value !== undefined) out[k] = sortKeys(value);
    }
    return out;
  }
  return v;
}

export function signPack(
  pack: SeasonPack,
  releaseKind: ReleaseKind,
  signers: readonly DeviceKeyPair[],
): Uint8Array {
  const needed = requiredSignatures(releaseKind);
  if (signers.length < needed) {
    throw new PackError(
      `a ${releaseKind.toUpperCase()} release needs ${needed} signature(s), got ${signers.length}. ` +
        (releaseKind === 'major'
          ? 'MAJOR releases break every consumer, which is worth waking a second steward for.'
          : ''),
    );
  }

  const seen = new Set<string>();
  for (const s of signers) {
    const hex = toHex(s.kid);
    if (seen.has(hex)) {
      throw new PackError(`key ${hex} signed twice — that is one signature, not two`);
    }
    seen.add(hex);
  }

  const json = canonicalPackJson(pack);
  const payload = signingPayload(json, releaseKind);

  return encode(
    new Map<CborKey, CborValue>([
      [E_PAYLOAD, json],
      [E_RELEASE_KIND, releaseKind],
      [
        E_SIGNATURES,
        signers.map((s) => [s.kid, sign(payload, s.secretKey)] as CborValue),
      ],
    ]),
  );
}

export function openSignedPack(bytes: Uint8Array, resolveKey: PackKeyResolver): SignedPack {
  let m;
  try {
    m = expectMap(decode(bytes), 'signed pack');
  } catch (err) {
    if (err instanceof CborError) throw new PackError(`malformed signed pack: ${err.message}`);
    throw err;
  }

  const json = expectText(m.get(E_PAYLOAD), 'pack payload');
  const kindRaw = expectText(m.get(E_RELEASE_KIND), 'release kind');
  if (kindRaw !== 'major' && kindRaw !== 'minor' && kindRaw !== 'patch') {
    throw new PackError(`unknown release kind "${kindRaw}"`);
  }
  const releaseKind = kindRaw;

  const payload = signingPayload(json, releaseKind);
  const accepted: Uint8Array[] = [];
  const seen = new Set<string>();

  for (const entry of expectArray(m.get(E_SIGNATURES), 'signatures')) {
    const a = expectArray(entry, 'signature');
    const kid = expectBytes(a[0], 'signer kid', 8);
    const signature = expectBytes(a[1], 'signature', 64);

    const hex = toHex(kid);
    // Two signatures from one key are one signature. Counting them twice would
    // let a single compromised steward publish a MAJOR release alone.
    if (seen.has(hex)) continue;

    const publicKey = resolveKey(kid);
    if (!publicKey) continue;
    if (!timingSafeEqual(deriveKeyId(publicKey), kid)) continue;
    if (!verify(signature, payload, publicKey)) continue;

    seen.add(hex);
    accepted.push(kid);
  }

  const needed = requiredSignatures(releaseKind);
  if (accepted.length < needed) {
    throw new PackError(
      `${releaseKind.toUpperCase()} release carries ${accepted.length} valid signature(s) from ` +
        `known stewards, needs ${needed}`,
    );
  }

  let pack: SeasonPack;
  try {
    pack = JSON.parse(json) as SeasonPack;
  } catch {
    throw new PackError('signed payload is not valid JSON');
  }
  // The signature covers the exact bytes, so a pack whose canonical form
  // differs from what was signed must be rejected rather than renormalised.
  if (canonicalPackJson(pack) !== json) {
    throw new PackError('pack payload is not in canonical form');
  }

  return { pack, releaseKind, signers: accepted, digest: hash256(utf8(json)) };
}

/**
 * CI gate: the asserted release kind must match what the diff actually is.
 *
 * Signing binds the assertion; this binds the assertion to reality. Without it
 * a steward could label a breaking change MINOR and ship it with one signature
 * — which is precisely the failure the threshold exists to prevent.
 */
export function checkReleaseKind(
  previous: SeasonPack,
  next: SeasonPack,
  asserted: ReleaseKind,
): void {
  const actual = classifyChange(previous, next);
  if (actual === 'none') {
    throw new PackError('nothing changed between these packs — there is no release to sign');
  }
  if (actual !== asserted) {
    throw new PackError(
      `this diff is a ${actual.toUpperCase()} change but the release asserts ` +
        `${asserted.toUpperCase()}. ` +
        (actual === 'major'
          ? 'A MAJOR change needs two signatures; relabelling it does not make it safe.'
          : 'Fix the assertion.'),
    );
  }
}
