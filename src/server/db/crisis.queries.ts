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
 * compatibility with the admin client.
 * scopeTherapistId (caseload RBAC): when set, restrict every list to sessions
 * of that care-team member's assigned clients; null/undefined = unscoped,
 * today's SQL. orgId (caseworker portal C13): researcher org restriction;
 * anonymous sessions stay visible. For crisis_events the org check resolves
 * the owning user via COALESCE(ts.user_id, ce.client_user_id) so
 * thread-origin events (076: session_id NULL, client_user_id set) are
 * org-restricted too instead of leaking cross-org as "anonymous".
 * Demo/harness sessions are excluded UNLESS owned by a sandbox account (s7:
 * sandbox dashboards must show the seeded arc; real staff never reach sandbox
 * sessions because caseload/org scoping already excludes them). */
export async function getAllCrisisData(
  scopeTherapistId?: number | null,
  orgId?: number | null
): Promise<AllCrisisData> {
  const scoped = scopeTherapistId !== null && scopeTherapistId !== undefined;
  const params: unknown[] = scoped ? [scopeTherapistId] : [];
  let sessionScopeClause = scoped
    ? `
        AND EXISTS (SELECT 1 FROM therapist_clients tc WHERE tc.therapist_id = $1 AND tc.client_id = ts.user_id)`
    : '';
  let crisisScopeClause = sessionScopeClause;
  if (orgId !== null && orgId !== undefined) {
    params.push(orgId);
    sessionScopeClause += `
        AND (ts.user_id IS NULL OR EXISTS (SELECT 1 FROM users ou WHERE ou.userid = ts.user_id AND ou.organization_id = $${params.length}))`;
    crisisScopeClause += `
        AND (COALESCE(ts.user_id, ce.client_user_id) IS NULL OR EXISTS (SELECT 1 FROM users ou WHERE ou.userid = COALESCE(ts.user_id, ce.client_user_id) AND ou.organization_id = $${params.length}))`;
  }
  const [crisisEvents, interventionActions, riskScoreHistory] = await Promise.all([
    pool.query(`
      SELECT ce.*, ts.session_name, ts.user_id, u.username
      FROM crisis_events ce
      LEFT JOIN therapy_sessions ts ON ce.session_id = ts.session_id
      LEFT JOIN users u ON u.userid = ts.user_id
      WHERE (ts.is_demo IS NOT TRUE OR EXISTS (SELECT 1 FROM users su WHERE su.userid = ts.user_id AND su.is_sandbox IS TRUE))${crisisScopeClause}
      ORDER BY ce.created_at DESC
      LIMIT 500
    `, params),
    pool.query(`
      SELECT ia.*, ts.session_name
      FROM intervention_actions ia
      LEFT JOIN therapy_sessions ts ON ia.session_id = ts.session_id
      WHERE (ts.is_demo IS NOT TRUE OR EXISTS (SELECT 1 FROM users su WHERE su.userid = ts.user_id AND su.is_sandbox IS TRUE))${sessionScopeClause}
      ORDER BY ia.performed_at DESC
      LIMIT 500
    `, params),
    pool.query(`
      SELECT rsh.*, ts.session_name
      FROM risk_score_history rsh
      LEFT JOIN therapy_sessions ts ON rsh.session_id = ts.session_id
      WHERE (ts.is_demo IS NOT TRUE OR EXISTS (SELECT 1 FROM users su WHERE su.userid = ts.user_id AND su.is_sandbox IS TRUE))${sessionScopeClause}
      ORDER BY rsh.calculated_at DESC
      LIMIT 1000
    `, params),
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
  is_demo: boolean;
}

/** Core session fields the adverse-event draft assembler snapshots
 *  (ai-therapist-95). Null if the session doesn't exist. */
export async function getSessionAeSnapshot(sessionId: string): Promise<SessionAeSnapshot | null> {
  const result = await pool.query<SessionAeSnapshot>(
    `SELECT session_id, user_id, crisis_severity, crisis_risk_score, crisis_flagged_at,
            COALESCE(is_demo, false) AS is_demo
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

/** Whether a session already has an intervention action of the given type.
 *  Used as an idempotence guard for the minor-eligibility safeguard
 *  (ai-therapist-106) so a re-disclosure in a re-fetched transcript never
 *  double-ends / double-drafts. */
export async function hasInterventionAction(sessionId: string, actionType: string): Promise<boolean> {
  const result = await pool.query(
    `SELECT 1 FROM intervention_actions WHERE session_id = $1 AND action_type = $2 LIMIT 1`,
    [sessionId, actionType],
  );
  return result.rows.length > 0;
}

/** All crisis events (with session name + username), newest first.
 *  scopeTherapistId (caseload RBAC): when set, restrict to the care-team
 *  member's assigned clients; null/undefined = unscoped, today's SQL.
 *  orgId (caseworker portal C13): researcher org restriction; anonymous
 *  sessions stay visible. Thread-origin events (076: session_id NULL) are
 *  org-scoped via ce.client_user_id — COALESCE(ts.user_id, ce.client_user_id)
 *  — so they never leak cross-org as "anonymous". Demo sessions are excluded
 *  unless sandbox-owned (s7 — see getAllCrisisData). */
export async function getAllCrisisEvents(
  scopeTherapistId?: number | null,
  orgId?: number | null
): Promise<Record<string, unknown>[]> {
  const scoped = scopeTherapistId !== null && scopeTherapistId !== undefined;
  const params: unknown[] = scoped ? [scopeTherapistId] : [];
  let scopeClause = scoped
    ? `
      AND EXISTS (SELECT 1 FROM therapist_clients tc WHERE tc.therapist_id = $1 AND tc.client_id = ts.user_id)`
    : '';
  if (orgId !== null && orgId !== undefined) {
    params.push(orgId);
    scopeClause += `
      AND (COALESCE(ts.user_id, ce.client_user_id) IS NULL OR EXISTS (SELECT 1 FROM users ou WHERE ou.userid = COALESCE(ts.user_id, ce.client_user_id) AND ou.organization_id = $${params.length}))`;
  }
  const result = await pool.query(`
    SELECT ce.*, ts.session_name, u.username
    FROM crisis_events ce
    LEFT JOIN therapy_sessions ts ON ce.session_id = ts.session_id
    LEFT JOIN users u ON ts.user_id = u.userid
    WHERE (ts.is_demo IS NOT TRUE OR EXISTS (SELECT 1 FROM users su WHERE su.userid = ts.user_id AND su.is_sandbox IS TRUE))${scopeClause}
    ORDER BY ce.created_at DESC
    LIMIT 100
  `, params);
  return result.rows;
}

export interface CrisisEventClientInfo {
  event_id: number;
  session_id: string | null;
  client_user_id: number | null;
  session_user_id: number | null;
}

/** The client a crisis event belongs to: client_user_id for message-origin
 *  events (076), the owning session's user for session-origin events. Backs
 *  the escalation-create link check (an escalation's crisis_event_id must
 *  belong to its client). Null if the event doesn't exist. */
export async function getCrisisEventClientInfo(eventId: number): Promise<CrisisEventClientInfo | null> {
  const result = await pool.query<CrisisEventClientInfo>(
    `SELECT ce.event_id, ce.session_id, ce.client_user_id,
            ts.user_id AS session_user_id
     FROM crisis_events ce
     LEFT JOIN therapy_sessions ts ON ts.session_id = ce.session_id
     WHERE ce.event_id = $1`,
    [eventId]
  );
  return result.rows[0] ?? null;
}

/** All currently crisis-flagged sessions (the active-crisis view), highest
 *  risk first. The active-crisis route historically read this list from
 *  services/crisisDetection.service.ts#getActiveCrisisSessions; this scoped
 *  variant lives here so caseload RBAC (ai-therapist-119) can filter it.
 *  scopeTherapistId: when set, restrict to the therapist's assigned clients;
 *  null/undefined = unscoped (researchers), matching the service's SQL. */
export async function getActiveCrisisSessions(scopeTherapistId?: number | null): Promise<Record<string, unknown>[]> {
  const scoped = scopeTherapistId !== null && scopeTherapistId !== undefined;
  const scopeClause = scoped
    ? `
       AND EXISTS (SELECT 1 FROM therapist_clients tc WHERE tc.therapist_id = $1 AND tc.client_id = ts.user_id)`
    : '';
  const result = await pool.query(
    `SELECT
       ts.session_id,
       ts.user_id,
       ts.crisis_severity,
       ts.crisis_risk_score,
       ts.crisis_flagged_at,
       ts.crisis_flagged_by,
       u.username
     FROM therapy_sessions ts
     LEFT JOIN users u ON ts.user_id = u.userid
     WHERE ts.crisis_flagged = TRUE${scopeClause}
     ORDER BY ts.crisis_risk_score DESC, ts.crisis_flagged_at DESC`,
    scoped ? [scopeTherapistId] : []
  );
  return result.rows;
}
