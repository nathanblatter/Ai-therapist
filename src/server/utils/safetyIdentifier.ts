// OpenAI safety identifiers (ai-therapist-168, salted since ai-therapist-306).
// OpenAI scopes abuse enforcement to a stable, non-PII per-user identifier
// instead of the whole API key. This module is the ONLY place an identifier is
// derived; every request that carries one gets it from here:
//
//   - the GPT-Live session mint (liveSession.routes, OpenAI-Safety-Identifier
//     header): safetyIdentifierForUser, or safetyIdentifierForParticipantCookie
//     for an anonymous browser;
//   - the chat reply, the crisis assessor, the voice sideband connection and
//     its mid-session summary: safetyIdentifierForSession, which resolves the
//     session's user and so produces the SAME identifier the voice mint sent.
//
// Derivation: HMAC-SHA256 keyed with OPENAI_SAFETY_IDENTIFIER_SALT, a secret
// set once per environment. Without it the identifier was a plain sha256 of
// `user:<id>`, so user 7 on stage, user 7 on prod and user 7 in any test
// database sent OpenAI the same identifier (a block is permanent, so one
// environment could cut off a participant in another), and anyone with a user
// id could compute it. With the salt the value differs per environment and
// cannot be computed or reversed without the secret, and it stays the same
// for a user for as long as the salt does.
//
// Unset salt (tests, local dev, or an environment not yet migrated): the old
// unsalted derivation, unchanged, plus one startup warning in production
// (warnIfSafetyIdentifierUnsalted). Nothing here throws.
//
// Changing the salt (including setting it for the first time) changes every
// participant's identifier, which resets whatever abuse history OpenAI holds
// against the old ones. Set it once, before Phase 2 enrolment, never mid-study.
//
// Anonymous sessions: the participant cookie is browser-side only, so from a
// bare session id the best stable value is a session-scoped hash. That still
// isolates enforcement to one session rather than the org.
import { createHmac } from 'node:crypto';
import { pool } from '../config/db.js';
import { hashToken } from './crypto.js';
import { createLogger } from './logger.js';

const log = createLogger('safetyIdentifier');

/** The per-environment secret the identifier is keyed with. */
export const SAFETY_IDENTIFIER_SALT_ENV = 'OPENAI_SAFETY_IDENTIFIER_SALT';

function currentSalt(): string {
  return (process.env[SAFETY_IDENTIFIER_SALT_ENV] ?? '').trim();
}

/**
 * The single derivation. `seed` names what is identified (`user:<id>`,
 * `participant:<cookie>`, `anon-session:<id>`); the salt makes the result
 * specific to this environment. Returns 64 hex characters either way.
 */
export function deriveSafetyIdentifier(seed: string): string {
  const salt = currentSalt();
  if (!salt) return hashToken(seed);
  return createHmac('sha256', salt).update(seed, 'utf8').digest('hex');
}

/** Identifier for a signed-in participant (or staff) account. */
export function safetyIdentifierForUser(userId: number | string): string {
  return deriveSafetyIdentifier(`user:${userId}`);
}

/** Identifier for an anonymous browser, keyed on its random participant cookie. */
export function safetyIdentifierForParticipantCookie(participantId: string): string {
  return deriveSafetyIdentifier(`participant:${participantId}`);
}

/** Session id -> identifier (safetyIdentifierForSession), bounded. */
const cache = new Map<string, string>();
let warnedUnsalted = false;

/**
 * Startup check: in production, say once that the salt is missing. Returns
 * true when it warned. Never throws; the app runs either way.
 */
export function warnIfSafetyIdentifierUnsalted(env: NodeJS.ProcessEnv = process.env): boolean {
  if (warnedUnsalted || env.NODE_ENV !== 'production') return false;
  if ((env[SAFETY_IDENTIFIER_SALT_ENV] ?? '').trim()) return false;
  warnedUnsalted = true;
  log.warn(
    `${SAFETY_IDENTIFIER_SALT_ENV} is not set: OpenAI safety identifiers are an unsalted sha256 of the user id, ` +
      'shared by every environment that has a user with the same id and computable from the id ' +
      '(ai-therapist-306). Set it once per environment, before Phase 2 enrolment (setting or changing it resets ' +
      "OpenAI's abuse history for every participant).",
  );
  return true;
}

/** Test hook. */
export function _resetSafetyIdentifierStateForTests(): void {
  warnedUnsalted = false;
  cache.clear();
}

/**
 * True when OpenAI has blocked this participant's safety identifier
 * (ai-therapist-186). Per OpenAI's docs the block is permanent and they
 * "cannot currently unblock an individual identifier", so a false positive
 * ends one participant's access with no self-serve recovery. Detecting it
 * lets the app show a supportive screen with crisis resources and the
 * research team's contact details instead of "check your connection".
 */
export function isIdentifierBlockedError(err: unknown, responseText?: string): boolean {
  const haystack = [err instanceof Error ? err.message : typeof err === 'string' ? err : '', responseText ?? '']
    .join(' ')
    .toLowerCase();
  if (!haystack) return false;
  return (
    haystack.includes('identifier_blocked') ||
    haystack.includes('identifier is blocked') ||
    (haystack.includes('safety_identifier') && haystack.includes('block')) ||
    (haystack.includes('safety identifier') && haystack.includes('block'))
  );
}

/** Stable hashed safety identifier for a session's participant. */
export async function safetyIdentifierForSession(sessionId: string): Promise<string> {
  const cached = cache.get(sessionId);
  if (cached) return cached;

  let userId: number | string | null = null;
  try {
    const result = await pool.query(`SELECT user_id FROM therapy_sessions WHERE session_id = $1`, [sessionId]);
    userId = result.rows[0]?.user_id ?? null;
  } catch {
    // Identifier is best-effort; the session-scoped fallback stands.
  }

  const identifier = userId ? safetyIdentifierForUser(userId) : deriveSafetyIdentifier(`anon-session:${sessionId}`);
  if (cache.size > 1000) {
    for (const key of cache.keys()) {
      if (cache.size <= 500) break;
      cache.delete(key);
    }
  }
  cache.set(sessionId, identifier);
  return identifier;
}
