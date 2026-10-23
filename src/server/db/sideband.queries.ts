// Data-access for the admin sideband control panel. The sideband feature
// (live mid-session instruction updates over a second OpenAI connection) is
// currently disabled, so these run only when a connection is actually active.
import { pool } from '../config/db.js';
import { ownerOrgScopeSql } from './organizations.queries.js';

export type SidebandSessionRow = Record<string, unknown>;

/** Active sessions with their sideband connection state, newest first. */
export async function getActiveSidebandSessions(orgId?: number | null): Promise<SidebandSessionRow[]> {
  // orgId (ai-therapist-276): org-bound researchers see only sessions whose
  // owner is in their organization, or anonymous sessions when they are the
  // irb-study org (the by-id gate's rule); null/undefined is the unscoped
  // list, which the route then caseload-filters for care-team callers.
  const orgScoped = orgId !== null && orgId !== undefined;
  const orgClause = orgScoped
    ? `
      AND ${ownerOrgScopeSql('$1', 'ts.user_id')}`
    : '';
  const result = await pool.query(`
    SELECT
      ts.session_id,
      ts.openai_call_id,
      ts.sideband_connected,
      ts.sideband_connected_at,
      ts.sideband_disconnected_at,
      ts.sideband_error,
      ts.status,
      ts.user_id
    FROM therapy_sessions ts
    WHERE ts.status = 'active'${orgClause}
    ORDER BY ts.created_at DESC
  `, orgScoped ? [orgId] : []);
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
