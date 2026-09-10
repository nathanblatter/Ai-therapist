// OpenAI safety identifiers for server-side calls (ai-therapist-168).
// OpenAI scopes abuse enforcement to a stable, non-PII per-user identifier
// instead of the whole API key. token.routes already sends one when minting
// realtime client secrets (hash of `user:<id>`, or of a random participant
// cookie for anonymous browsers). This helper produces the SAME identifier
// for logged-in users from service code that only knows the session id, so
// the text APIs (chat, crisis assessment) and the sideband connection carry
// an identifier consistent with the realtime session's.
//
// Anonymous sessions: the participant cookie is browser-side only, so from a
// bare session id the best stable value is a session-scoped hash. That still
// isolates enforcement to one session rather than the org.
import { pool } from '../config/db.js';
import { hashToken } from './crypto.js';

const cache = new Map<string, string>();

/**
 * True when OpenAI has blocked this participant's safety identifier
 * (ai-therapist-186). Per OpenAI's docs the block is permanent and they
 * "cannot currently unblock an individual identifier", so a false positive
 * ends one participant's access with no self-serve recovery. Detecting it
 * lets the app show a supportive screen with crisis resources and the
 * research team's contact details instead of "check your connection".
 */
export function isIdentifierBlockedError(err: unknown, responseText?: string): boolean {
  const haystack = [
    err instanceof Error ? err.message : typeof err === 'string' ? err : '',
    responseText ?? '',
  ].join(' ').toLowerCase();
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

  let seed = `anon-session:${sessionId}`;
  try {
    const result = await pool.query(
      `SELECT user_id FROM therapy_sessions WHERE session_id = $1`,
      [sessionId]
    );
    const userId = result.rows[0]?.user_id;
    if (userId) seed = `user:${userId}`;
  } catch {
    // Identifier is best-effort; the session-scoped fallback stands.
  }

  const identifier = hashToken(seed);
  if (cache.size > 1000) {
    for (const key of cache.keys()) {
      if (cache.size <= 500) break;
      cache.delete(key);
    }
  }
  cache.set(sessionId, identifier);
  return identifier;
}
