// Data-access for the admin session browser: active list, filtered/paginated
// list, single-session detail, and redaction status. Session/message mutations
// (end/delete/update) live in db/sessions.queries.ts + db/messages.queries.ts.
import { pool } from '../config/db.js';

export type AdminSessionRow = Record<string, unknown>;

// Therapists see raw content; researchers see the redacted column.
export type MessageContentColumn = 'content' | 'content_redacted';

/** All currently-active sessions with message counts, crisis-first ordering. */
export async function getActiveSessions(): Promise<AdminSessionRow[]> {
  const result = await pool.query(`
    SELECT
      ts.session_id,
      ts.user_id,
      ts.session_name,
      u.username,
      ts.status,
      ts.created_at,
      ts.crisis_flagged,
      ts.crisis_severity,
      ts.crisis_risk_score,
      ts.crisis_flagged_at,
      ts.crisis_flagged_by,
      COUNT(m.message_id) as message_count,
      MAX(m.created_at) as last_activity,
      EXTRACT(EPOCH FROM (CURRENT_TIMESTAMP - ts.created_at)) as duration_seconds
    FROM therapy_sessions ts
    LEFT JOIN users u ON ts.user_id = u.userid
    LEFT JOIN messages m ON ts.session_id = m.session_id
    WHERE ts.status = 'active'
      AND ts.is_demo IS NOT TRUE
    GROUP BY ts.session_id, u.username
    ORDER BY ts.crisis_flagged DESC, ts.created_at DESC
  `);
  return result.rows;
}

// Filters for the session list. The route parses query params into this shape.
export interface SessionListFilters {
  search: string | null;
  startDate: string | null;
  endDate: string | null;
  minMessages: number | null;
  maxMessages: number | null;
  limit: number;
  offset: number;
  voices: string[] | null;
  languages: string[] | null;
  durations: string[] | null;
  sessionTypes: string[] | null;
  statuses: string[] | null;
  endedBy: string[] | null;
  crisisFlagged: boolean | null;
  crisisSeverity: string | null;
}

/** One page of sessions matching the filters, with per-session message stats. */
export async function listSessions(f: SessionListFilters): Promise<AdminSessionRow[]> {
  const result = await pool.query(`
    WITH session_stats AS (
      SELECT
        ts.session_id,
        ts.session_name,
        ts.user_id,
        u.username,
        ts.status,
        ts.session_type,
        ts.created_at AS start_time,
        ts.ended_at AS end_time,
        ts.ended_by,
        ts.crisis_flagged,
        ts.crisis_severity,
        sc.voice,
        sc.language,
        EXTRACT(EPOCH FROM (ts.ended_at - ts.created_at)) AS duration_seconds,
        CASE
          WHEN EXTRACT(EPOCH FROM (ts.ended_at - ts.created_at)) < 300 THEN 'short'
          WHEN EXTRACT(EPOCH FROM (ts.ended_at - ts.created_at)) < 1800 THEN 'medium'
          ELSE 'long'
        END AS duration_category,
        COUNT(m.message_id) AS total_messages,
        COUNT(m.message_id) FILTER (WHERE m.role = 'user') AS user_messages,
        COUNT(m.message_id) FILTER (WHERE m.role = 'assistant') AS assistant_messages,
        COUNT(m.message_id) FILTER (WHERE m.message_type = 'voice') AS voice_messages,
        COUNT(m.message_id) FILTER (WHERE m.message_type = 'chat') AS chat_messages
      FROM therapy_sessions ts
      LEFT JOIN users u ON ts.user_id = u.userid
      LEFT JOIN session_configurations sc ON ts.session_id = sc.session_id
      LEFT JOIN messages m ON ts.session_id = m.session_id
      WHERE
        ts.is_demo IS NOT TRUE
        AND ($1::TEXT IS NULL OR ts.session_id::TEXT ILIKE '%' || $1 || '%' OR ts.session_name ILIKE '%' || $1 || '%' OR u.username ILIKE '%' || $1 || '%')
        AND ($2::TIMESTAMP IS NULL OR ts.created_at >= $2)
        AND ($3::TIMESTAMP IS NULL OR ts.created_at <= $3)
        AND ($8::TEXT[] IS NULL OR sc.voice = ANY($8))
        AND ($9::TEXT[] IS NULL OR sc.language = ANY($9))
        AND ($10::TEXT[] IS NULL OR ts.session_type = ANY($10))
        AND ($11::TEXT[] IS NULL OR ts.status = ANY($11))
        AND ($12::TEXT[] IS NULL OR ts.ended_by = ANY($12))
        AND ($13::BOOLEAN IS NULL OR ts.crisis_flagged = $13)
        AND ($14::TEXT IS NULL OR ts.crisis_severity = $14)
      GROUP BY ts.session_id, u.username, ts.ended_by, ts.session_type, ts.crisis_flagged, ts.crisis_severity, sc.voice, sc.language
    )
    SELECT * FROM session_stats
    WHERE
      ($4::INT IS NULL OR total_messages >= $4)
      AND ($5::INT IS NULL OR total_messages <= $5)
      AND ($15::TEXT[] IS NULL OR duration_category = ANY($15))
    ORDER BY start_time DESC
    LIMIT $6 OFFSET $7
  `, [
    f.search,         // $1
    f.startDate,      // $2
    f.endDate,        // $3
    f.minMessages,    // $4
    f.maxMessages,    // $5
    f.limit,          // $6
    f.offset,         // $7
    f.voices,         // $8
    f.languages,      // $9
    f.sessionTypes,   // $10
    f.statuses,       // $11
    f.endedBy,        // $12
    f.crisisFlagged,  // $13
    f.crisisSeverity, // $14
    f.durations,      // $15
  ]);
  return result.rows;
}

/** Total sessions matching the list filters (ignores pagination/message/duration). */
export async function countSessions(f: SessionListFilters): Promise<number> {
  const result = await pool.query<{ total: string }>(`
    SELECT COUNT(DISTINCT ts.session_id) as total
    FROM therapy_sessions ts
    LEFT JOIN users u ON ts.user_id = u.userid
    LEFT JOIN session_configurations sc ON ts.session_id = sc.session_id
    WHERE
      ts.is_demo IS NOT TRUE
      AND ($1::TEXT IS NULL OR ts.session_id::TEXT ILIKE '%' || $1 || '%' OR ts.session_name ILIKE '%' || $1 || '%' OR u.username ILIKE '%' || $1 || '%')
      AND ($2::TIMESTAMP IS NULL OR ts.created_at >= $2)
      AND ($3::TIMESTAMP IS NULL OR ts.created_at <= $3)
      AND ($4::TEXT[] IS NULL OR sc.voice = ANY($4))
      AND ($5::TEXT[] IS NULL OR sc.language = ANY($5))
      AND ($6::TEXT[] IS NULL OR ts.session_type = ANY($6))
      AND ($7::TEXT[] IS NULL OR ts.status = ANY($7))
      AND ($8::TEXT[] IS NULL OR ts.ended_by = ANY($8))
      AND ($9::BOOLEAN IS NULL OR ts.crisis_flagged = $9)
      AND ($10::TEXT IS NULL OR ts.crisis_severity = $10)
  `, [
    f.search,
    f.startDate,
    f.endDate,
    f.voices,
    f.languages,
    f.sessionTypes,
    f.statuses,
    f.endedBy,
    f.crisisFlagged,
    f.crisisSeverity,
  ]);
  return parseInt(result.rows[0].total);
}

/** Session row joined with username, or null if not found. */
export async function getSessionWithUser(sessionId: string): Promise<AdminSessionRow | null> {
  const result = await pool.query(`
    SELECT
      ts.*,
      u.username
    FROM therapy_sessions ts
    LEFT JOIN users u ON ts.user_id = u.userid
    WHERE ts.session_id = $1
  `, [sessionId]);
  return result.rows[0] ?? null;
}

/** A session's messages in order, exposing the role-appropriate content column. */
export async function getAdminSessionMessages(sessionId: string, contentColumn: MessageContentColumn): Promise<AdminSessionRow[]> {
  const result = await pool.query(`
    SELECT
      message_id,
      session_id,
      role,
      message_type,
      ${contentColumn} as message,
      metadata as extras,
      created_at
    FROM messages
    WHERE session_id = $1
    ORDER BY created_at ASC
  `, [sessionId]);
  return result.rows;
}

/** Count of not-yet-redacted messages in a session (0 == redaction complete). */
export async function getRedactionStatus(sessionId: string): Promise<number> {
  const result = await pool.query<{ pending_count: string }>(
    `SELECT COUNT(*) as pending_count
     FROM messages
     WHERE session_id = $1 AND content_redacted IS NULL`,
    [sessionId]
  );
  return parseInt(result.rows[0].pending_count);
}

export type RedactionStatusLabel = 'complete' | 'partial' | 'pending' | 'no_content';

export interface RedactionStatusBreakdown {
  total: number;
  redacted: number;
  pending: number;
  status: RedactionStatusLabel;
}

/**
 * Full redaction breakdown for a session (ai-therapist-22): how many
 * redactable messages it has, how many are already redacted, and a summary
 * label for the admin sessions UI.
 *   - no_content: nothing to redact (e.g. session with no user/assistant turns)
 *   - complete:   every redactable message has content_redacted set
 *   - pending:    none redacted yet (e.g. redaction hasn't run / just ended)
 *   - partial:    some but not all — the gap this feature exists to surface
 */
export async function getRedactionStatusBreakdown(sessionId: string): Promise<RedactionStatusBreakdown> {
  const result = await pool.query<{ total: string; redacted: string }>(
    `SELECT
       COUNT(*) FILTER (WHERE role IN ('user', 'assistant') AND content IS NOT NULL) AS total,
       COUNT(*) FILTER (WHERE role IN ('user', 'assistant') AND content IS NOT NULL AND content_redacted IS NOT NULL) AS redacted
     FROM messages
     WHERE session_id = $1`,
    [sessionId]
  );
  const total = parseInt(result.rows[0]?.total ?? '0');
  const redacted = parseInt(result.rows[0]?.redacted ?? '0');
  const pending = total - redacted;

  let status: RedactionStatusLabel;
  if (total === 0) status = 'no_content';
  else if (pending === 0) status = 'complete';
  else if (redacted === 0) status = 'pending';
  else status = 'partial';

  return { total, redacted, pending, status };
}
