// Data-access for the admin sideband control panel. The sideband feature
// (live mid-session instruction updates over a second OpenAI connection) is
// currently disabled, so these run only when a connection is actually active.
import { pool } from '../config/db.js';

export type SidebandSessionRow = Record<string, unknown>;

/** Active sessions with their sideband connection state, newest first. */
export async function getActiveSidebandSessions(): Promise<SidebandSessionRow[]> {
  const result = await pool.query(`
    SELECT
      session_id,
      openai_call_id,
      sideband_connected,
      sideband_connected_at,
      sideband_disconnected_at,
      sideband_error,
      status,
      user_id
    FROM therapy_sessions
    WHERE status = 'active'
    ORDER BY created_at DESC
  `);
  return result.rows;
}

/** Sideband connection rows for the given session ids (admin socket view). */
export async function getSidebandConnectionsByIds(sessionIds: string[]): Promise<SidebandSessionRow[]> {
  const result = await pool.query(`
    SELECT
      session_id,
      openai_call_id,
      sideband_connected,
      sideband_connected_at,
      status,
      user_id
    FROM therapy_sessions
    WHERE session_id = ANY($1)
    ORDER BY sideband_connected_at DESC
  `, [sessionIds]);
  return result.rows;
}

/** Record an admin sideband action (instruction update / disconnect) as a system message. */
export async function logSidebandAction(
  sessionId: string,
  message: string,
  metadata: Record<string, unknown>
): Promise<void> {
  await pool.query(`
    INSERT INTO messages (session_id, role, message_type, content, content_redacted, metadata, created_at)
    VALUES ($1, 'system', 'admin_action', $2, NULL, $3, CURRENT_TIMESTAMP)
  `, [sessionId, message, JSON.stringify(metadata)]);
}
