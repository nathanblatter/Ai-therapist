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
