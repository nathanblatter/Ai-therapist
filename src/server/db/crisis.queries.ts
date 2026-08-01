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

/** Comprehensive crisis dashboard data (3 live tables joined to session names).
 * clinical_reviews and human_handoffs were dropped in migrations 035 (sunset,
 * ai-therapist-23); their keys remain as empty arrays for API-shape
 * compatibility with the admin client. */
export async function getAllCrisisData(): Promise<AllCrisisData> {
  const [crisisEvents, interventionActions, riskScoreHistory] = await Promise.all([
    pool.query(`
      SELECT ce.*, ts.session_name
      FROM crisis_events ce
      LEFT JOIN therapy_sessions ts ON ce.session_id = ts.session_id
      WHERE ts.is_demo IS NOT TRUE
      ORDER BY ce.created_at DESC
      LIMIT 500
    `),
    pool.query(`
      SELECT ia.*, ts.session_name
      FROM intervention_actions ia
      LEFT JOIN therapy_sessions ts ON ia.session_id = ts.session_id
      WHERE ts.is_demo IS NOT TRUE
      ORDER BY ia.performed_at DESC
      LIMIT 500
    `),
    pool.query(`
      SELECT rsh.*, ts.session_name
      FROM risk_score_history rsh
      LEFT JOIN therapy_sessions ts ON rsh.session_id = ts.session_id
      WHERE ts.is_demo IS NOT TRUE
      ORDER BY rsh.calculated_at DESC
      LIMIT 1000
    `),
  ]);

  return {
    clinicalReviews: [],
    crisisEvents: crisisEvents.rows,
    humanHandoffs: [],
    interventionActions: interventionActions.rows,
    riskScoreHistory: riskScoreHistory.rows,
  };
}

// ---------- Risk history context (ai-therapist-52) ----------
// Whether a user's prior-crisis history may be injected into their future
// sessions. Sensitive wording — default OFF; a therapist opts a participant
// in from the admin session view (routes/admin/insights.routes.ts).

export async function getUserRiskContextEnabled(userId: number): Promise<boolean> {
  const result = await pool.query<{ risk_context_share_enabled: boolean }>(
    'SELECT risk_context_share_enabled FROM users WHERE userid = $1',
    [userId]
  );
  return result.rows[0]?.risk_context_share_enabled ?? false;
}

export async function setUserRiskContextEnabled(userId: number, enabled: boolean): Promise<void> {
  await pool.query(
    'UPDATE users SET risk_context_share_enabled = $2, updated_at = CURRENT_TIMESTAMP WHERE userid = $1',
    [userId, enabled]
  );
}

export interface PriorCrisisFlag {
  session_id: string;
  severity: string | null;
  flagged_at: Date;
  unflagged_at: Date | null;
  unflagged_by: string | null;
}

/** Past sessions where this user was crisis-flagged, most recent first (excludes the current session). */
export async function getUserPriorCrisisFlags(
  userId: number,
  excludeSessionId: string | null,
  limit = 3
): Promise<PriorCrisisFlag[]> {
  const result = await pool.query<PriorCrisisFlag>(
    `SELECT session_id, crisis_severity AS severity, crisis_flagged_at AS flagged_at,
            crisis_unflagged_at AS unflagged_at, crisis_unflagged_by AS unflagged_by
     FROM therapy_sessions
     WHERE user_id = $1 AND crisis_flagged_at IS NOT NULL
       AND ($2::text IS NULL OR session_id != $2)
     ORDER BY crisis_flagged_at DESC
     LIMIT $3`,
    [userId, excludeSessionId, limit]
  );
  return result.rows;
}

export interface SessionAeSnapshot {
  session_id: string;
  user_id: number | null;
  crisis_severity: string | null;
  crisis_risk_score: number | null;
  crisis_flagged_at: Date | null;
}

/** Core session fields the adverse-event draft assembler snapshots
 *  (ai-therapist-95). Null if the session doesn't exist. */
export async function getSessionAeSnapshot(sessionId: string): Promise<SessionAeSnapshot | null> {
  const result = await pool.query<SessionAeSnapshot>(
    `SELECT session_id, user_id, crisis_severity, crisis_risk_score, crisis_flagged_at
     FROM therapy_sessions WHERE session_id = $1`,
    [sessionId],
  );
  return result.rows[0] ?? null;
}

export interface SessionInterventionAction {
  action_id: number;
  action_type: string;
  performed_at: Date;
  performed_by: string | null;
  risk_score: number | null;
}

/** Intervention actions logged for a session, chronological — used by the
 *  adverse-event draft assembler (ai-therapist-95). */
export async function getSessionInterventionActions(sessionId: string): Promise<SessionInterventionAction[]> {
  const result = await pool.query<SessionInterventionAction>(
    `SELECT action_id, action_type, performed_at, performed_by, risk_score
     FROM intervention_actions
     WHERE session_id = $1
     ORDER BY performed_at ASC`,
    [sessionId],
  );
  return result.rows;
}

/** All crisis events (with session name + username), newest first. */
export async function getAllCrisisEvents(): Promise<Record<string, unknown>[]> {
  const result = await pool.query(`
    SELECT ce.*, ts.session_name, u.username
    FROM crisis_events ce
    LEFT JOIN therapy_sessions ts ON ce.session_id = ts.session_id
    LEFT JOIN users u ON ts.user_id = u.userid
    WHERE ts.is_demo IS NOT TRUE
    ORDER BY ce.created_at DESC
    LIMIT 100
  `);
  return result.rows;
}
