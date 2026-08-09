/**
 * @courier/pairing — how a device joins a team's mesh, and who it trusts after.
 *
 * Two QR codes and a spoken six-digit code. No radio, no network, no server.
 */

export {
  createJoinRequest,
  parseJoinRequest,
  grantJoin,
  acceptGrant,
  shortAuthString,
  sasMatches,
  describeRequest,
  PairingError,
  PAIRING_VERSION,
  SAS_DIGITS,
  type JoinRequest,
  type PendingJoin,
  type MeshCredentials,
  type GrantResult,
  type AcceptResult,
} from './ceremony.ts';

export { KeyRegistry, RegistryError, type RegisteredKey } from './registry.ts';
