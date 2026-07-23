// Data-access for the admin research-data export. Each export type has its own
// query; the route decides which to call and how to serialise (JSON/CSV).
//
// Two values are interpolated into SQL rather than bound: the content column
// (role-derived, whitelisted to two literals) and the aggregation date format
// (whitelisted to three literals). Neither is raw user input.
import { pool } from '../config/db.js';

export type ExportRow = Record<string, unknown>;

// Therapists may export raw content; everyone else gets the redacted column.
export type ExportContentColumn = 'content' | 'content_redacted';

export interface ExportFilters {
  sessionId: string | null;
  startDate: string | null;
  endDate: string | null;
  crisisOnly: boolean;
}

/** Per-session metadata, no message content. */
export async function getMetadataExport(f: ExportFilters): Promise<ExportRow[]> {
  const result = await pool.query(`
    SELECT
      ts.session_id,
      ts.session_name,
      u.username,
      ts.session_type,
      ts.created_at as session_start,
      ts.ended_at as session_end,
      EXTRACT(EPOCH FROM (ts.ended_at - ts.created_at))/60 as duration_minutes,
      ts.crisis_flagged,
      ts.crisis_severity,
      ts.crisis_risk_score,
      COUNT(m.message_id) as message_count
    FROM therapy_sessions ts
    LEFT JOIN users u ON ts.user_id = u.userid
    LEFT JOIN messages m ON ts.session_id = m.session_id
    WHERE
      ts.is_demo IS NOT TRUE
      AND ($1::VARCHAR IS NULL OR ts.session_id = $1)
      AND ($2::TIMESTAMP IS NULL OR ts.created_at >= $2)
      AND ($3::TIMESTAMP IS NULL OR ts.created_at <= $3)
      AND ($4::BOOLEAN IS FALSE OR ts.crisis_flagged = TRUE)
    GROUP BY ts.session_id, ts.session_name, u.username, ts.session_type, ts.created_at, ts.ended_at, ts.crisis_flagged, ts.crisis_severity, ts.crisis_risk_score
    ORDER BY ts.created_at DESC
  `, [f.sessionId, f.startDate, f.endDate, f.crisisOnly]);
  return result.rows;
}

/** Messages with per-user research IDs in place of identities. */
export async function getAnonymizedExport(f: ExportFilters, contentColumn: ExportContentColumn): Promise<ExportRow[]> {
  const result = await pool.query(`
    SELECT
      m.message_id as id,
      m.session_id,
      ts.session_name,
      'RID_' || LPAD(ROW_NUMBER() OVER (ORDER BY u.userid)::TEXT, 3, '0') as research_id,
      m.role,
      m.message_type,
      m.${contentColumn} as message,
      m.metadata as extras,
      m.created_at
    FROM messages m
    INNER JOIN therapy_sessions ts ON m.session_id = ts.session_id
    LEFT JOIN users u ON ts.user_id = u.userid
    WHERE
      ts.is_demo IS NOT TRUE
      AND ($1::VARCHAR IS NULL OR m.session_id = $1)
      AND ($2::TIMESTAMP IS NULL OR ts.created_at >= $2)
      AND ($3::TIMESTAMP IS NULL OR ts.created_at <= $3)
      AND ($4::BOOLEAN IS FALSE OR ts.crisis_flagged = TRUE)
    ORDER BY m.created_at ASC
  `, [f.sessionId, f.startDate, f.endDate, f.crisisOnly]);
  return result.rows;
}

/** Aggregated session statistics bucketed by day/week/month. */
export async function getAggregatedExport(
  f: ExportFilters,
  aggregationPeriod: string
): Promise<ExportRow[]> {
  const dateFormat = aggregationPeriod === 'day' ? 'YYYY-MM-DD'
    : aggregationPeriod === 'week' ? 'IYYY-IW'
      : 'YYYY-MM';
  const result = await pool.query(`
    SELECT
      TO_CHAR(ts.created_at, '${dateFormat}') as period,
      COUNT(DISTINCT ts.session_id) as total_sessions,
      COUNT(DISTINCT ts.user_id) as unique_users,
      AVG(EXTRACT(EPOCH FROM (ts.ended_at - ts.created_at))/60) as avg_duration_minutes,
      SUM(CASE WHEN ts.crisis_flagged THEN 1 ELSE 0 END) as crisis_flagged_count,
      AVG(ts.crisis_risk_score) as avg_risk_score,
      COUNT(DISTINCT CASE WHEN ts.session_type = 'realtime' THEN ts.session_id END) as realtime_sessions,
      COUNT(DISTINCT CASE WHEN ts.session_type = 'chat' THEN ts.session_id END) as chat_sessions
    FROM therapy_sessions ts
    WHERE
      ts.is_demo IS NOT TRUE
      AND ($1::TIMESTAMP IS NULL OR ts.created_at >= $1)
      AND ($2::TIMESTAMP IS NULL OR ts.created_at <= $2)
      AND ($3::BOOLEAN IS FALSE OR ts.crisis_flagged = TRUE)
    GROUP BY TO_CHAR(ts.created_at, '${dateFormat}')
    ORDER BY period
  `, [f.startDate, f.endDate, f.crisisOnly]);
  return result.rows;
}

/** Full message export. A single session skips the session/user joins. */
export async function getFullExport(f: ExportFilters, contentColumn: ExportContentColumn): Promise<ExportRow[]> {
  if (f.sessionId) {
    const result = await pool.query(`
      SELECT
        m.message_id as id,
        m.session_id,
        m.role,
        m.message_type,
        m.${contentColumn} as message,
        m.metadata as extras,
        m.created_at
      FROM messages m
      WHERE m.session_id = $1
      ORDER BY m.created_at ASC
    `, [f.sessionId]);
    return result.rows;
  }

  const result = await pool.query(`
    SELECT
      m.message_id as id,
      m.session_id,
      ts.session_name,
      u.username,
      m.role,
      m.message_type,
      m.${contentColumn} as message,
      m.metadata as extras,
      m.created_at
    FROM messages m
    INNER JOIN therapy_sessions ts ON m.session_id = ts.session_id
    LEFT JOIN users u ON ts.user_id = u.userid
    WHERE
      ts.is_demo IS NOT TRUE
      AND ($1::TIMESTAMP IS NULL OR ts.created_at >= $1)
      AND ($2::TIMESTAMP IS NULL OR ts.created_at <= $2)
      AND ($3::BOOLEAN IS FALSE OR ts.crisis_flagged = TRUE)
    ORDER BY m.created_at ASC
  `, [f.startDate, f.endDate, f.crisisOnly]);
  return result.rows;
}
