// Shared hashing/comparison primitives for tokens and content hashes.
// Consolidates the sha256-hex implementations that were re-rolled per module
// (consent body hash, invite/sandbox-invite token storage, safety identifier,
// magic-link comparison). Purpose-specific hashes stay put: careNotes'
// canonical-JSON signature and knowledge's md5 content hash are not tokens.
import { createHash, timingSafeEqual } from 'node:crypto';

/** hex sha256 of a UTF-8 string (matches PG encode(sha256(convert_to(...,'UTF8')),'hex')). */
export function sha256Hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

/**
 * The sha256 hex stored for raw-token lookups (invites, sandbox invites,
 * safety identifiers): only the digest ever touches the database. Looking a
 * digest up by SQL equality (rather than tokensMatch) is fine here — an
 * attacker cannot work backward from partial digest matches to a valid raw
 * token, so digest-equality in SQL is not a practical timing side channel.
 * For directly comparing two secrets in process, use tokensMatch.
 */
export function hashToken(rawToken: string): string {
  return sha256Hex(rawToken);
}

/**
 * Constant-time secret comparison that also tolerates differing lengths
 * (hashing both sides to a fixed 32 bytes first, so timingSafeEqual never
 * throws). Use for any direct comparison against a configured secret.
 */
export function tokensMatch(provided: string, expected: string): boolean {
  const a = createHash('sha256').update(provided).digest();
  const b = createHash('sha256').update(expected).digest();
  return timingSafeEqual(a, b);
}
