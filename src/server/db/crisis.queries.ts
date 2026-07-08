// Data-access for crisis-management views and session crisis flags.
import { pool } from '../config/db.js';

/** Does a therapy session exist? */
export async function sessionExists(sessionId: string): Promise<boolean> {
  const result = await pool.query('SELECT session_id FROM therapy_sessions WHERE session_id = $1', [sessionId]);
  return result.rows.length > 0;
}

/** A session's crisis-flag state, or null if the session doesn't exist. */
export async function getSessionCrisisFlag(
  sessionId: string
): Promise<{ session_id: string; crisis_flagged: boolean } | null> {
  const result = await pool.query<{ session_id: string; crisis_flagged: boolean }>(
    'SELECT session_id, crisis_flagged FROM therapy_sessions WHERE session_id = $1',
    [sessionId]
  );
  return result.rows[0] ?? null;
}

export interface RecentSessionMessage {
  role: string;
  content: string | null;
  content_redacted: string | null;
  [key: string]: unknown;
}

/** The most recent messages in a session, chronological order (oldest first). */
export async function getRecentSessionMessages(sessionId: string, limit = 10): Promise<RecentSessionMessage[]> {
  const result = await pool.query<RecentSessionMessage>(
    `SELECT * FROM messages
     WHERE session_id = $1
     ORDER BY created_at DESC
     LIMIT $2`,
    [sessionId, limit]
  );
  return result.rows.reverse();
}

export interface SessionCrisisState {
  crisis_flagged: boolean;
  crisis_severity: string | null;
  crisis_risk_score: number | null;
}

/** Current crisis flag/severity/score for a session, or null if absent. */
export async function getSessionCrisisState(sessionId: string): Promise<SessionCrisisState | null> {
  const result = await pool.query<SessionCrisisState>(
    `SELECT crisis_flagged, crisis_severity, crisis_risk_score
     FROM therapy_sessions
     WHERE session_id = $1`,
    [sessionId]
  );
  return result.rows[0] ?? null;
}

export interface AllCrisisData {
  clinicalReviews: Record<string, unknown>[];
  crisisEvents: Record<string, unknown>[];
  humanHandoffs: Record<string, unknown>[];
  interventionActions: Record<string, unknown>[];
  riskScoreHistory: Record<string, unknown>[];
}

/** Comprehensive crisis dashboard data (5 tables joined to session names). */
export async function getAllCrisisData(): Promise<AllCrisisData> {
  const [clinicalReviews, crisisEvents, humanHandoffs, interventionActions, riskScoreHistory] = await Promise.all([
    pool.query(`
      SELECT cr.*, ts.session_name
      FROM clinical_reviews cr
      LEFT JOIN therapy_sessions ts ON cr.session_id = ts.session_id
      ORDER BY cr.requested_at DESC
      LIMIT 500
    `),
    pool.query(`
      SELECT ce.*, ts.session_name
      FROM crisis_events ce
      LEFT JOIN therapy_sessions ts ON ce.session_id = ts.session_id
      ORDER BY ce.created_at DESC
      LIMIT 500
    `),
    pool.query(`
      SELECT hh.*, ts.session_name
      FROM human_handoffs hh
      LEFT JOIN therapy_sessions ts ON hh.session_id = ts.session_id
      ORDER BY hh.initiated_at DESC
      LIMIT 500
    `),
    pool.query(`
      SELECT ia.*, ts.session_name
      FROM intervention_actions ia
      LEFT JOIN therapy_sessions ts ON ia.session_id = ts.session_id
      ORDER BY ia.performed_at DESC
      LIMIT 500
    `),
    pool.query(`
      SELECT rsh.*, ts.session_name
      FROM risk_score_history rsh
      LEFT JOIN therapy_sessions ts ON rsh.session_id = ts.session_id
      ORDER BY rsh.calculated_at DESC
      LIMIT 1000
    `),
  ]);

  return {
    clinicalReviews: clinicalReviews.rows,
    crisisEvents: crisisEvents.rows,
    humanHandoffs: humanHandoffs.rows,
    interventionActions: interventionActions.rows,
    riskScoreHistory: riskScoreHistory.rows,
  };
}

/** All crisis events (with session name + username), newest first. */
export async function getAllCrisisEvents(): Promise<Record<string, unknown>[]> {
  const result = await pool.query(`
    SELECT ce.*, ts.session_name, u.username
    FROM crisis_events ce
    LEFT JOIN therapy_sessions ts ON ce.session_id = ts.session_id
    LEFT JOIN users u ON ts.user_id = u.userid
    ORDER BY ce.created_at DESC
    LIMIT 100
  `);
  return result.rows;
}
