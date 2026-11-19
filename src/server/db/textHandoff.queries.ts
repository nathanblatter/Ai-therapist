// Data-access for the text hand-off after a vendor cut of a voice session
// (services/textHandoff.service, ai-therapist-356).
//
// The hand-off needs three things the tables already hold, so there is no new
// table and no migration:
//   - the LINK between the sessions of one incident (voice call, the typed
//     chat that continued it, a voice call started again from that chat). It
//     is written to intervention_actions as an 'external_api_called' row, the
//     convention already used for "the vendor ended this session" and for
//     paging decisions, with the link under action_details;
//   - the continuation's crisis flag (therapy_sessions + crisis_events);
//   - what was said (messages) and how it was scored (risk_score_history).
//
// Imported directly by the service, not re-exported from db/index.js, so the
// many tests that mock db/index.js with a partial factory keep working (same
// arrangement as db/paging.queries).
import { pool } from '../config/db.js';
import { recordCrisisEvent } from './crisis.queries.js';

/** action_details.event of a hand-off link row. */
export const HANDOFF_EVENT = 'voice_cut_text_handoff';
/** action_details.event of the row written when a voice call is started again
 *  from a hand-off chat session. */
export const VOICE_RETURN_EVENT = 'voice_resumed_from_text';

export interface HandoffSessionRow {
  session_id: string;
  user_id: number | string | null;
  session_type: string | null;
  status: string | null;
  crisis_flagged: boolean | null;
  crisis_severity: string | null;
}

export async function getHandoffSessionRow(sessionId: string): Promise<HandoffSessionRow | null> {
  const result = await pool.query<HandoffSessionRow>(
    `SELECT session_id, user_id, session_type, status, crisis_flagged, crisis_severity
       FROM therapy_sessions WHERE session_id = $1`,
    [sessionId],
  );
  return result.rows[0] ?? null;
}

/**
 * The session this one continues, or null: the `from` of the newest link row
 * written against it (a chat that continued a voice call, or a voice call
 * started again from such a chat).
 */
export async function getPredecessorSessionId(sessionId: string): Promise<string | null> {
  const result = await pool.query<{ from_session: string | null }>(
    `SELECT action_details->>'from' AS from_session
       FROM intervention_actions
      WHERE session_id = $1
        AND action_type = 'external_api_called'
        AND action_details->>'event' = ANY($2::text[])
        AND action_details ? 'from'
      ORDER BY performed_at DESC
      LIMIT 1`,
    [sessionId, [HANDOFF_EVENT, VOICE_RETURN_EVENT]],
  );
  const from = result.rows[0]?.from_session;
  return typeof from === 'string' && from.length > 0 ? from : null;
}

export interface HandoffRecord {
  kind: string | null;
  severity: string | null;
  reason: string | null;
  from: string | null;
}

/** The hand-off a chat session was started by, or null when it is an ordinary
 *  chat session. */
export async function getHandoffRecord(chatSessionId: string): Promise<HandoffRecord | null> {
  const result = await pool.query<{ details: Record<string, unknown> | string | null }>(
    `SELECT action_details AS details
       FROM intervention_actions
      WHERE session_id = $1
        AND action_type = 'external_api_called'
        AND action_details->>'event' = $2
        AND action_details ? 'from'
      ORDER BY performed_at DESC
      LIMIT 1`,
    [chatSessionId, HANDOFF_EVENT],
  );
  const raw = result.rows[0]?.details;
  if (raw === null || raw === undefined) return null;
  let details: Record<string, unknown>;
  try {
    details = typeof raw === 'string' ? (JSON.parse(raw) as Record<string, unknown>) : raw;
  } catch {
    return null;
  }
  const text = (key: string): string | null => (typeof details[key] === 'string' ? (details[key] as string) : null);
  return { kind: text('kind'), severity: text('severity'), reason: text('reason'), from: text('from') };
}

/** Write one link row. Throws on failure; the caller decides what that costs. */
export async function insertHandoffLink(sessionId: string, details: Record<string, unknown>): Promise<void> {
  await pool.query(
    `INSERT INTO intervention_actions (session_id, action_type, action_details, risk_score)
     VALUES ($1, 'external_api_called', $2, $3)`,
    [sessionId, JSON.stringify(details), typeof details['riskScore'] === 'number' ? details['riskScore'] : null],
  );
}

export interface HandoffTurn {
  session_id: string;
  role: string;
  content: string | null;
  created_at: Date;
}

/** Message types that are bookkeeping, not conversation (see
 *  BOOKKEEPING_MESSAGE_TYPES in db/crisis.queries, kept in step by hand). */
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
 * The most recent conversational turns (participant and assistant) across the
 * given sessions, oldest first. `limit` bounds the read; the caller applies
 * the character bound.
 */
export async function getIncidentTurns(sessionIds: string[], limit: number): Promise<HandoffTurn[]> {
  if (sessionIds.length === 0) return [];
  const result = await pool.query<HandoffTurn>(
    `SELECT session_id, role, content, created_at
       FROM messages
      WHERE session_id = ANY($1::text[])
        AND role IN ('user', 'assistant')
        AND message_type <> ALL($3::text[])
      ORDER BY created_at DESC, message_id DESC
      LIMIT $2`,
    [sessionIds, limit, BOOKKEEPING_MESSAGE_TYPES],
  );
  return result.rows.reverse();
}

/** Highest band the risk assessor gave a participant turn in this session:
 *  'high', 'medium' or 'none'. Reads the band stored with each score, so no
 *  threshold is copied here. */
export async function getSessionAssessedPeak(sessionId: string): Promise<'none' | 'medium' | 'high'> {
  const result = await pool.query<{ has_high: boolean; has_medium: boolean }>(
    `SELECT COALESCE(BOOL_OR(severity = 'high'), FALSE) AS has_high,
            COALESCE(BOOL_OR(severity = 'medium'), FALSE) AS has_medium
       FROM risk_score_history
      WHERE session_id = $1`,
    [sessionId],
  );
  const row = result.rows[0];
  return row?.has_high === true ? 'high' : row?.has_medium === true ? 'medium' : 'none';
}

export interface RiskCheckStepLite {
  step: string;
  risk_band: string;
}

/** The assistant's run_risk_check steps in this session, oldest first. */
export async function getSessionRiskCheckSteps(sessionId: string): Promise<RiskCheckStepLite[]> {
  const result = await pool.query<RiskCheckStepLite>(
    `SELECT step, risk_band FROM risk_check_steps WHERE session_id = $1 ORDER BY created_at ASC, check_step_id ASC`,
    [sessionId],
  );
  return result.rows;
}

/**
 * Flag a typed-chat session that continues a voice call the vendor ended, at
 * the incident's REAL severity (services/crisisPaging resolveIncidentPeak),
 * so the crisis pipeline treats the chat as the same incident from its first
 * turn: every turn is assessed in context (a "yes" or "ok" is read against the
 * question it answers), the end_session guard holds, and the dashboards show
 * the session where the participant now is.
 *
 * This is a STAMP, not a disclosure, and it is marked as one: the crisis_events
 * row carries the 'recovery_continuation' risk factor, exactly like the stamp
 * on a recovery voice session (markSessionCrisisContinuation). That factor is
 * what keeps the stamp from hiding a real disclosure (ai-therapist-350 review):
 *   - the paging policy does not count it as the participant's risk
 *     (getParticipantFlagEvents excludes it);
 *   - a high turn in a session whose only high flag is the stamp still asks
 *     for a page (pageHighTurnWithoutReflag, highFlagIsContinuationStampOnly),
 *     under the ordinary folding rules.
 * A stamp at medium is passed by the first high turn through the pipeline's
 * own re-flag rule (severity rises), which flags and pages as usual.
 *
 * `riskScore` is the incident's real peak score; null when it is not known,
 * which leaves the stored score empty so the first scored turn flags for real.
 * No adverse-event draft: that belongs to the session the disclosure was made
 * in. Throws on failure.
 */
export async function markTextHandoffContinuation(
  sessionId: string,
  input: { severity: 'high' | 'medium'; riskScore: number | null; continuedFrom: string; reason: string },
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `UPDATE therapy_sessions
          SET crisis_flagged = TRUE,
              crisis_severity = $2::VARCHAR,
              crisis_risk_score = $3,
              crisis_flagged_at = CURRENT_TIMESTAMP,
              crisis_flagged_by = 'system',
              monitoring_frequency = CASE WHEN $2::VARCHAR = 'high' THEN 'critical' ELSE 'high' END
        WHERE session_id = $1`,
      [sessionId, input.severity, input.riskScore],
    );
    await recordCrisisEvent(
      {
        sessionId,
        eventType: 'flagged',
        severity: input.severity,
        riskScore: input.riskScore,
        triggeredBy: 'system',
        // crisis_events.trigger_method is CHECK-constrained (011/068); the
        // continuation is identified by its risk factors and notes instead.
        triggerMethod: 'system',
        messageId: null,
        riskFactors: ['recovery_continuation', 'text_handoff'],
        notes:
          `Typed-chat continuation of voice session ${input.continuedFrom}, which the voice vendor ended ` +
          `(${input.reason === 'expired' ? 'session time limit' : 'content filter'}). Flag carried over from the ` +
          'incident; not a new disclosure.',
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
