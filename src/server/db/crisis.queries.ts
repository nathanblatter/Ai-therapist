// Data-access for crisis-management views and session crisis flags.
import { pool } from '../config/db.js';
import { notUnverifiedSpeechSql } from './unverifiedSpeech.js';
import { ownerOrgScopeSql } from './organizations.queries.js';
import { CRISIS_EVENT_ADJUDICATIONS_SQL } from './crisisAdjudications.queries.js';
import { getIncidentChainSessionIds, INCIDENT_CHAIN_BACKSTOP_MS } from './paging.queries.js';

/** Anything that can run a parameterized query (the pool, or a transaction's
 *  PoolClient so callers can write the event atomically with other rows). */
type Queryable = Pick<typeof pool, 'query'>;

export interface RecordCrisisEventInput {
  /** Omitted fields are left to the column defaults (076: origin defaults to
   *  'session'; thread_message_id/client_user_id default NULL). */
  origin?: 'thread_message';
  threadMessageId?: number;
  clientUserId?: number;
  sessionId?: string | null;
  eventType: string;
  severity?: string | null;
  previousSeverity?: string | null;
  riskScore?: number | null;
  previousRiskScore?: number | null;
  triggeredBy: string;
  triggerMethod: string;
  messageId?: string | number | null;
  /** JSON-stringified into risk_factors when present. */
  riskFactors?: string[];
  notes?: string | null;
}

/**
 * SINGLE WRITER for crisis_events rows. Every fan-out path (session flag /
 * unflag / risk update in crisisDetection.service, thread-message flags in
 * messageSafety.service) inserts through here; only fields the caller passes
 * become columns, so each path writes exactly what it wrote when the inserts
 * were hand-rolled per service. Returns the new event_id.
 */
export async function recordCrisisEvent(input: RecordCrisisEventInput, db: Queryable = pool): Promise<number> {
  const columns: string[] = [];
  const values: unknown[] = [];
  const add = (column: string, value: unknown): void => {
    columns.push(column);
    values.push(value);
  };

  if (input.origin !== undefined) add('origin', input.origin);
  if (input.threadMessageId !== undefined) add('thread_message_id', input.threadMessageId);
  if (input.clientUserId !== undefined) add('client_user_id', input.clientUserId);
  if (input.sessionId !== undefined) add('session_id', input.sessionId);
  add('event_type', input.eventType);
  if (input.severity !== undefined) add('severity', input.severity);
  if (input.previousSeverity !== undefined) add('previous_severity', input.previousSeverity);
  if (input.riskScore !== undefined) add('risk_score', input.riskScore);
  if (input.previousRiskScore !== undefined) add('previous_risk_score', input.previousRiskScore);
  add('triggered_by', input.triggeredBy);
  add('trigger_method', input.triggerMethod);
  if (input.messageId !== undefined) add('message_id', input.messageId);
  if (input.riskFactors !== undefined) add('risk_factors', JSON.stringify(input.riskFactors));
  if (input.notes !== undefined) add('notes', input.notes);

  const placeholders = columns.map((_, i) => `$${i + 1}`).join(', ');
  const result = await db.query<{ event_id: number }>(
    `INSERT INTO crisis_events (${columns.join(', ')})
     VALUES (${placeholders})
     RETURNING event_id`,
    values,
  );
  return result.rows[0].event_id;
}

/** Does a therapy session exist? */
export async function sessionExists(sessionId: string): Promise<boolean> {
  const result = await pool.query('SELECT session_id FROM therapy_sessions WHERE session_id = $1', [sessionId]);
  return result.rows.length > 0;
}

/** A session's crisis-flag state, or null if the session doesn't exist. */
export async function getSessionCrisisFlag(
  sessionId: string,
): Promise<{ session_id: string; crisis_flagged: boolean } | null> {
  const result = await pool.query<{ session_id: string; crisis_flagged: boolean }>(
    'SELECT session_id, crisis_flagged FROM therapy_sessions WHERE session_id = $1',
    [sessionId],
  );
  return result.rows[0] ?? null;
}

export interface RecentSessionMessage {
  role: string;
  content: string | null;
  content_redacted: string | null;
  [key: string]: unknown;
}

/**
 * Message types that are BOOKKEEPING, not conversation. Every tool invocation
 * writes two of these rows (tool_call + tool_response), so a turn that used a
 * worksheet, a scale and a journaling prompt used to push six or more of them
 * into the crisis window and evict the participant's actual words
 * (ai-therapist-223). Every writer stamps them role 'system', but the list is
 * explicit so a future writer that logs one under 'user'/'assistant' still
 * cannot crowd the window.
 */
const BOOKKEEPING_MESSAGE_TYPES = [
  'tool_call',
  'tool_response',
  'function_call',
  'notable_moment',
  'system',
  'session_start',
  'session_end',
  'admin_action',
  'admin_visible',
  'admin_invisible',
];

/**
 * The most recent CONVERSATIONAL messages in a session, chronological order
 * (oldest first) — participant and assistant turns only.
 *
 * `limit` counts conversational rows, not raw rows: this is the context window
 * the crisis assessor, the minor-disclosure confirmation and the adverse-event
 * excerpt all read, and every one of them drops non-conversational rows on the
 * way in. Filtering in SQL means the window holds `limit` real turns instead of
 * however many survived the tool plumbing (ai-therapist-223) — which mattered
 * most in exactly the sessions where the model was working hardest.
 *
 * Participant-authored worksheet rows (thought_record, values_sort,
 * fear_ladder) are written with role 'user' and stay in the window; the
 * server-side tool_event_* echoes of them are role 'system' and do not.
 *
 * A voice turn marked unverified speech (ai-therapist-412: a transcript the
 * vendor produced from a muted microphone) is left out: nobody said it, so it
 * must not be read as context for what the participant says next.
 */
export async function getRecentSessionMessages(sessionId: string, limit = 10): Promise<RecentSessionMessage[]> {
  const result = await pool.query<RecentSessionMessage>(
    `SELECT * FROM messages
     WHERE session_id = $1
       AND role IN ('user', 'assistant')
       AND message_type <> ALL($3::text[])
       AND ${notUnverifiedSpeechSql()}
     ORDER BY created_at DESC
     LIMIT $2`,
    [sessionId, limit, BOOKKEEPING_MESSAGE_TYPES],
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
    [sessionId],
  );
  return result.rows[0] ?? null;
}

/**
 * Who each automatic HIGH flag of a session was about, oldest first: the
 * `subject` the crisis pipeline wrote on its 'auto_flag' row ('third_party',
 * 'harm_to_others'), or null for the participant's own risk. Empty when the
 * session has no automatic high flag (a manual flag or a recovery stamp writes
 * no such row).
 */
export async function getSessionHighFlagSubjects(sessionId: string): Promise<Array<string | null>> {
  const result = await pool.query<{ subject: string | null }>(
    `SELECT action_details->>'subject' AS subject
       FROM intervention_actions
      WHERE session_id = $1
        AND action_type = 'auto_flag'
        AND action_details->>'severity' = 'high'
      ORDER BY performed_at, action_id`,
    [sessionId],
  );
  return result.rows.map((row) => row.subject ?? null);
}

/**
 * What this session's automatic high flags have already said was happening:
 * the `escalation` recorded on each 'auto_flag' row ('plan_or_time' or
 * 'attempt'), with the subject it concerned (null: the participant). Lets the
 * pipeline write ONE flag event the first time a session reaches each stage,
 * instead of none (the score rule) or one per turn.
 */
export async function getSessionFlagEscalations(
  sessionId: string,
): Promise<Array<{ escalation: string; subject: string | null }>> {
  const result = await pool.query<{ escalation: string; subject: string | null }>(
    `SELECT action_details->>'escalation' AS escalation, action_details->>'subject' AS subject
       FROM intervention_actions
      WHERE session_id = $1
        AND action_type = 'auto_flag'
        AND action_details->>'severity' = 'high'
        AND action_details->>'escalation' IS NOT NULL`,
    [sessionId],
  );
  return result.rows;
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
 * an anonymous session is irb-study custody, visible to that org only
 * (ai-therapist-276). For crisis_events the org check resolves
 * the owning user via COALESCE(ts.user_id, ce.client_user_id) so
 * thread-origin events (076: session_id NULL, client_user_id set) are
 * org-restricted too instead of leaking cross-org as "anonymous".
 * Demo/harness sessions are excluded UNLESS owned by a sandbox account (s7:
 * sandbox dashboards must show the seeded arc; real staff never reach sandbox
 * sessions because caseload/org scoping already excludes them). */
export async function getAllCrisisData(
  scopeTherapistId?: number | null,
  orgId?: number | null,
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
        AND ${ownerOrgScopeSql(`$${params.length}`, 'ts.user_id')}`;
    crisisScopeClause += `
        AND ${ownerOrgScopeSql(`$${params.length}`, 'COALESCE(ts.user_id, ce.client_user_id)')}`;
  }
  const [crisisEvents, interventionActions, riskScoreHistory] = await Promise.all([
    pool.query(
      `
      SELECT ce.*, ts.session_name, ts.user_id, u.username, ${CRISIS_EVENT_ADJUDICATIONS_SQL}
      FROM crisis_events ce
      LEFT JOIN therapy_sessions ts ON ce.session_id = ts.session_id
      LEFT JOIN users u ON u.userid = ts.user_id
      WHERE (ts.is_demo IS NOT TRUE OR EXISTS (SELECT 1 FROM users su WHERE su.userid = ts.user_id AND su.is_sandbox IS TRUE))${crisisScopeClause}
      ORDER BY ce.created_at DESC
      LIMIT 500
    `,
      params,
    ),
    pool.query(
      `
      SELECT ia.*, ts.session_name
      FROM intervention_actions ia
      LEFT JOIN therapy_sessions ts ON ia.session_id = ts.session_id
      WHERE (ts.is_demo IS NOT TRUE OR EXISTS (SELECT 1 FROM users su WHERE su.userid = ts.user_id AND su.is_sandbox IS TRUE))${sessionScopeClause}
      ORDER BY ia.performed_at DESC
      LIMIT 500
    `,
      params,
    ),
    pool.query(
      `
      SELECT rsh.*, ts.session_name
      FROM risk_score_history rsh
      LEFT JOIN therapy_sessions ts ON rsh.session_id = ts.session_id
      WHERE (ts.is_demo IS NOT TRUE OR EXISTS (SELECT 1 FROM users su WHERE su.userid = ts.user_id AND su.is_sandbox IS TRUE))${sessionScopeClause}
      ORDER BY rsh.calculated_at DESC
      LIMIT 1000
    `,
      params,
    ),
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
    [userId],
  );
  return result.rows[0]?.risk_context_share_enabled ?? false;
}

export async function setUserRiskContextEnabled(userId: number, enabled: boolean): Promise<void> {
  await pool.query(
    'UPDATE users SET risk_context_share_enabled = $2, updated_at = CURRENT_TIMESTAMP WHERE userid = $1',
    [userId, enabled],
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
  limit = 3,
): Promise<PriorCrisisFlag[]> {
  const result = await pool.query<PriorCrisisFlag>(
    `SELECT session_id, crisis_severity AS severity, crisis_flagged_at AS flagged_at,
            crisis_unflagged_at AS unflagged_at, crisis_unflagged_by AS unflagged_by
     FROM therapy_sessions
     WHERE user_id = $1 AND crisis_flagged_at IS NOT NULL
       AND ($2::text IS NULL OR session_id != $2)
     ORDER BY crisis_flagged_at DESC
     LIMIT $3`,
    [userId, excludeSessionId, limit],
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
 *  sessions are irb-study custody (ai-therapist-276). Thread-origin events (076: session_id NULL) are
 *  org-scoped via ce.client_user_id — COALESCE(ts.user_id, ce.client_user_id)
 *  — so they never leak cross-org as "anonymous". Demo sessions are excluded
 *  unless sandbox-owned (s7 — see getAllCrisisData). */
export async function getAllCrisisEvents(
  scopeTherapistId?: number | null,
  orgId?: number | null,
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
      AND ${ownerOrgScopeSql(`$${params.length}`, 'COALESCE(ts.user_id, ce.client_user_id)')}`;
  }
  const result = await pool.query(
    `
    SELECT ce.*, ts.session_name, u.username, ${CRISIS_EVENT_ADJUDICATIONS_SQL}
    FROM crisis_events ce
    LEFT JOIN therapy_sessions ts ON ce.session_id = ts.session_id
    LEFT JOIN users u ON ts.user_id = u.userid
    WHERE (ts.is_demo IS NOT TRUE OR EXISTS (SELECT 1 FROM users su WHERE su.userid = ts.user_id AND su.is_sandbox IS TRUE))${scopeClause}
    ORDER BY ce.created_at DESC
    LIMIT 100
  `,
    params,
  );
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
    [eventId],
  );
  return result.rows[0] ?? null;
}

// ---------- Post-session safety context (ai-therapist-256) ----------
// Everything safety-relevant that happened inside one session, gathered for
// the post-session summarizer so a generated summary can never read as a
// calm "coping with loneliness" session when a crisis actually fired.

export interface SafetyContextCrisisEvent {
  event_type: string;
  severity: string | null;
  created_at: Date;
}

export interface SafetyContextEscalation {
  /** 'escalation' = a caseworker-portal escalation row; 'tool' = the model
   *  calling escalate_to_human during the session. */
  source: 'escalation' | 'tool';
  reason: string;
  urgency: string | null;
  status: string | null;
  created_at: Date;
}

export interface SafetyContextResourceCard {
  tool_name: string;
  resource_type: string | null;
  created_at: Date;
}

export interface SafetyContextAdverseEvent {
  report_id: number;
  severity: string;
  category: string;
  status: string;
  summary: string;
  created_at: Date;
}

export interface SessionSafetyContext {
  crisisEvents: SafetyContextCrisisEvent[];
  escalations: SafetyContextEscalation[];
  resourceCards: SafetyContextResourceCard[];
  adverseEvents: SafetyContextAdverseEvent[];
}

/** Tool calls that put crisis/safety material on the participant's screen. */
const RESOURCE_CARD_TOOLS = ['show_resource_card', 'get_crisis_resources', 'create_safety_plan'];

/** True when anything in the context warrants a safety line in the summary. */
export function hasSafetyContext(ctx: SessionSafetyContext): boolean {
  return (
    ctx.crisisEvents.length > 0 ||
    ctx.escalations.length > 0 ||
    ctx.resourceCards.length > 0 ||
    ctx.adverseEvents.length > 0
  );
}

/** Crisis events, escalations, safety/resource tool calls and adverse-event
 *  drafts for one session, chronological. Read-only; feeds the post-session
 *  summarizer (services/sessionInsights.service.ts). */
export async function getSessionSafetyContext(sessionId: string): Promise<SessionSafetyContext> {
  const [crisisEvents, escalations, toolCalls, adverseEvents] = await Promise.all([
    pool.query<SafetyContextCrisisEvent>(
      `SELECT event_type, severity, created_at
       FROM crisis_events WHERE session_id = $1
       ORDER BY created_at ASC LIMIT 25`,
      [sessionId],
    ),
    pool.query<Omit<SafetyContextEscalation, 'source'>>(
      `SELECT reason, urgency, status, created_at
       FROM escalations WHERE session_id = $1
       ORDER BY created_at ASC LIMIT 10`,
      [sessionId],
    ),
    pool.query<{ tool_name: string; arguments: Record<string, unknown> | null; created_at: Date }>(
      `SELECT tool_name, arguments, created_at
       FROM tool_invocations
       WHERE session_id = $1 AND tool_name = ANY($2::text[])
       ORDER BY created_at ASC LIMIT 25`,
      [sessionId, [...RESOURCE_CARD_TOOLS, 'escalate_to_human']],
    ),
    pool.query<SafetyContextAdverseEvent>(
      `SELECT report_id, severity, category, status, summary, created_at
       FROM adverse_event_reports WHERE session_id = $1
       ORDER BY created_at ASC LIMIT 10`,
      [sessionId],
    ),
  ]);

  const toolEscalations: SafetyContextEscalation[] = toolCalls.rows
    .filter((r) => r.tool_name === 'escalate_to_human')
    .map((r) => ({
      source: 'tool' as const,
      reason: typeof r.arguments?.reason === 'string' ? r.arguments.reason : 'escalate_to_human called',
      urgency: typeof r.arguments?.urgency === 'string' ? r.arguments.urgency : null,
      status: null,
      created_at: r.created_at,
    }));

  return {
    crisisEvents: crisisEvents.rows,
    escalations: [...escalations.rows.map((r) => ({ ...r, source: 'escalation' as const })), ...toolEscalations].sort(
      (a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime(),
    ),
    resourceCards: toolCalls.rows
      .filter((r) => RESOURCE_CARD_TOOLS.includes(r.tool_name))
      .map((r) => ({
        tool_name: r.tool_name,
        resource_type: typeof r.arguments?.resource_type === 'string' ? r.arguments.resource_type : null,
        created_at: r.created_at,
      })),
    adverseEvents: adverseEvents.rows,
  };
}

/**
 * Flag a crisis RECOVERY session as a continuation of the crisis that cut its
 * predecessor (ai-therapist-281). The new row inherits the user's most recent
 * flagged score (100 when none is known) so every server-side crisis path on
 * the continuation — the vendor-ceiling recovery, the on-call wording, the
 * end_session guard — sees a high flag from the first turn. Records a
 * crisis_events row for the audit trail; deliberately does NOT draft a second
 * adverse event (flagSessionCrisis would), the AE belongs to the original.
 */
export async function markSessionCrisisContinuation(sessionId: string): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const updated = await client.query<{ crisis_risk_score: number | null }>(
      `UPDATE therapy_sessions ts
       SET crisis_flagged = TRUE,
           crisis_severity = 'high',
           crisis_risk_score = COALESCE(
             (SELECT p.crisis_risk_score FROM therapy_sessions p
               WHERE p.user_id = ts.user_id AND p.crisis_flagged = TRUE AND p.session_id <> ts.session_id
               ORDER BY p.crisis_flagged_at DESC NULLS LAST LIMIT 1),
             100),
           crisis_flagged_at = CURRENT_TIMESTAMP,
           crisis_flagged_by = 'system',
           monitoring_frequency = 'critical'
       WHERE ts.session_id = $1
       RETURNING crisis_risk_score`,
      [sessionId],
    );
    await recordCrisisEvent(
      {
        sessionId,
        eventType: 'flagged',
        severity: 'high',
        riskScore: updated.rows[0]?.crisis_risk_score ?? 100,
        triggeredBy: 'system',
        // crisis_events.trigger_method is CHECK-constrained (011/068); the
        // continuation is identified by its risk factor and notes instead.
        triggerMethod: 'system',
        messageId: null,
        riskFactors: ['recovery_continuation'],
        notes:
          'Continuation of a crisis-flagged voice session that the platform cut (content filter or vendor ceiling).',
      },
      client,
    );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export interface RecoveryDisclosureResult {
  /** True when THIS call wrote the event: until now the session's only high
   *  flag was the automatic continuation stamp. False when the session has a
   *  real high flag already (or is not a stamped recovery session at all). */
  recorded: boolean;
  eventId: number | null;
  /** The score the stamp had put on the session row (inherited, or 100). */
  stampedScore: number | null;
}

/**
 * The participant's first HIGH turn in a recovery session whose high flag is
 * only the continuation stamp (ai-therapist-363).
 *
 * The stamp is written at the inherited score, or 100, so the pipeline's
 * re-flag rule can never fire in such a session and, before this, a real
 * disclosure there left no 'flagged' event: the on-call was paged, and the
 * record showed nothing but the automatic stamp. This writes the missing
 * record, once per session, in one transaction:
 *   - a crisis_events 'flagged' row at high severity with the score the
 *     assessor actually gave the turn, its factors, and the message it came
 *     from (previous_risk_score keeps the stamp's placeholder score);
 *   - the session row's crisis_risk_score and crisis_flagged_at, which the
 *     stamp had set to a placeholder, now say what was assessed and when. The
 *     re-flag rule therefore works normally for the rest of the session.
 *
 * The session row is locked first, so two high turns arriving together
 * cannot both find "stamp only": the second sees the first one's event and
 * returns recorded=false. A session with a real high flag is left alone,
 * which is what keeps this from duplicating an ordinary flag.
 *
 * Deliberately does not draft the adverse event: whether the incident already
 * has one is the caller's question (incidentHasCrisisAdverseEvent).
 */
export async function recordRecoveryDisclosure(input: {
  sessionId: string;
  riskScore: number;
  messageId: string | number | null;
  factors: string[];
}): Promise<RecoveryDisclosureResult> {
  const none: RecoveryDisclosureResult = { recorded: false, eventId: null, stampedScore: null };
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const session = await client.query<{ crisis_risk_score: number | null }>(
      'SELECT crisis_risk_score FROM therapy_sessions WHERE session_id = $1 FOR UPDATE',
      [input.sessionId],
    );
    if (session.rows.length === 0) {
      await client.query('ROLLBACK');
      return none;
    }
    const flags = await client.query<{ stamped: boolean; real_high: boolean }>(
      `SELECT EXISTS (SELECT 1 FROM crisis_events ce
                       WHERE ce.session_id = $1 AND ce.event_type = 'flagged'
                         AND ce.risk_factors @> '["recovery_continuation"]'::jsonb) AS stamped,
              EXISTS (SELECT 1 FROM crisis_events ce
                       WHERE ce.session_id = $1 AND ce.event_type = 'flagged' AND ce.severity = 'high'
                         AND NOT COALESCE(ce.risk_factors @> '["recovery_continuation"]'::jsonb, FALSE)) AS real_high`,
      [input.sessionId],
    );
    if (flags.rows[0]?.stamped !== true || flags.rows[0]?.real_high === true) {
      await client.query('ROLLBACK');
      return none;
    }
    const stampedScore = session.rows[0].crisis_risk_score ?? null;
    await client.query(
      `UPDATE therapy_sessions
          SET crisis_flagged = TRUE,
              crisis_severity = 'high',
              crisis_risk_score = $2,
              crisis_flagged_at = CURRENT_TIMESTAMP,
              crisis_flagged_by = 'system',
              monitoring_frequency = 'critical'
        WHERE session_id = $1`,
      [input.sessionId, input.riskScore],
    );
    const factors = input.factors.filter((factor) => factor !== 'recovery_continuation');
    const eventId = await recordCrisisEvent(
      {
        sessionId: input.sessionId,
        eventType: 'flagged',
        severity: 'high',
        previousSeverity: 'high',
        riskScore: input.riskScore,
        previousRiskScore: stampedScore,
        triggeredBy: 'system',
        triggerMethod: 'auto',
        messageId: input.messageId,
        // The stamp's marker must never appear here: its absence is what
        // makes this row "a real high flag" to every reader.
        riskFactors: factors,
        notes:
          `Participant disclosure in a recovery session. Risk score: ${input.riskScore} - Factors: ` +
          `${factors.join(', ')}. Until this turn the session's high flag was only the automatic ` +
          `continuation stamp (placeholder score ${stampedScore ?? 'n/a'}).`,
      },
      client,
    );
    await client.query('COMMIT');
    return { recorded: true, eventId, stampedScore };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Does the incident this session belongs to (its recovery chain, see
 * getIncidentChainSessionIds) already have an adverse-event report drafted
 * from a crisis flag? One incident, one report: it belongs to the session
 * where the participant was first flagged high.
 */
export async function incidentHasCrisisAdverseEvent(sessionId: string): Promise<boolean> {
  const chain = await getIncidentChainSessionIds(sessionId, new Date(Date.now() - INCIDENT_CHAIN_BACKSTOP_MS));
  const result = await pool.query(
    `SELECT 1 FROM adverse_event_reports
      WHERE session_id = ANY($1::text[]) AND trigger_source = 'auto_crisis_flag'
      LIMIT 1`,
    [chain],
  );
  return result.rows.length > 0;
}
