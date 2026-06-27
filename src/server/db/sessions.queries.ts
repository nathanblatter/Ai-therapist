// Data-access for the public session flow (chat + realtime). Session/message
// mutations live in models/dbQueries.ts; this holds the small read-side checks
// the public routes use for ownership/status validation.
import { pool } from '../config/db.js';

export interface SessionAccessInfo {
  status: string;
  user_id: number | string | null;
  session_type: string;
}

/** Status / owner / type for a session, or null if it doesn't exist. */
export async function getSessionAccessInfo(sessionId: string): Promise<SessionAccessInfo | null> {
  const result = await pool.query<SessionAccessInfo>(
    'SELECT status, user_id, session_type FROM therapy_sessions WHERE session_id = $1',
    [sessionId]
  );
  return result.rows[0] ?? null;
}

/** Attach the OpenAI realtime call id to a session (used by register-call). */
export async function setSessionCallId(sessionId: string, callId: string): Promise<void> {
  await pool.query(
    'UPDATE therapy_sessions SET openai_call_id = $1 WHERE session_id = $2',
    [callId, sessionId]
  );
}
