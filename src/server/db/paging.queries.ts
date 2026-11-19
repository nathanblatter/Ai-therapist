// Data-access for the on-call paging policy (services/crisisPaging.service).
//
// The policy needs state ACROSS sessions (a recovery session gets a new
// session id), and it reads that state from tables that already exist:
//   - intervention_actions: one row per paging decision. A page is a
//     'crisis_sms_alert' row; a decision NOT to send (folded into an earlier
//     page, sandbox, no participant risk signal) is an 'external_api_called'
//     row, the convention the sandbox suppression already used. Both carry
//     the decision under action_details.paging.
//   - crisis_events: what the participant's risk actually was.
// No new table and no migration.
//
// Deliberately imported directly by the service, not re-exported from
// db/index.js: the many tests that mock db/index.js with a partial factory
// then keep working, and these queries fall through to the mocked pool.
import { pool } from '../config/db.js';

export interface PagingRecordRow {
  action_id: number;
  session_id: string;
  action_type: string;
  action_details: unknown;
  performed_at: Date;
}

/** The participant who owns a session: users.userid, or null for an anonymous
 *  session (or a session row that does not exist yet). */
export async function getPagingParticipantUserId(sessionId: string): Promise<number | null> {
  const result = await pool.query<{ user_id: number | string | null }>(
    'SELECT user_id FROM therapy_sessions WHERE session_id = $1',
    [sessionId],
  );
  const raw = result.rows[0]?.user_id;
  if (raw === null || raw === undefined) return null;
  const id = Number(raw);
  return Number.isFinite(id) ? id : null;
}

/**
 * Paging decisions recorded since `since` for this session and, when the
 * participant is known, for every other session of the same participant.
 * Newest first. Rows without a paging payload (other 'external_api_called'
 * events) are filtered out in SQL.
 */
export async function getRecentPagingRecords(
  sessionId: string,
  userId: number | null,
  since: Date,
): Promise<PagingRecordRow[]> {
  const result = await pool.query<PagingRecordRow>(
    `SELECT ia.action_id, ia.session_id, ia.action_type, ia.action_details, ia.performed_at
       FROM intervention_actions ia
       JOIN therapy_sessions ts ON ts.session_id = ia.session_id
      WHERE ia.performed_at >= $3
        AND ia.action_type IN ('crisis_sms_alert', 'external_api_called')
        AND ia.action_details ? 'paging'
        AND (ia.session_id = $1 OR ($2::int IS NOT NULL AND ts.user_id = $2::int))
      ORDER BY ia.performed_at DESC
      LIMIT 100`,
    [sessionId, userId, since],
  );
  return result.rows.map((row) => ({ ...row, action_id: Number(row.action_id) }));
}

export interface ParticipantFlagRow {
  session_id: string;
  severity: string | null;
  risk_score: number | null;
  /** Who the flag or the scored turn was about: 'third_party' or
   *  'harm_to_others' when the detector labelled it so, otherwise null (the
   *  participant's own risk, and every row written before the label existed). */
  subject?: string | null;
}

/** crisis_events.risk_factors labels (crisisDetection THIRD_PARTY_FACTOR / HARM_TO_OTHERS_FACTOR). */
const THIRD_PARTY_FACTOR_JSON = '["third party at risk (reported by participant)"]';
const HARM_TO_OTHERS_FACTOR_JSON = '["risk to others (thoughts of harming another person)"]';

/**
 * Crisis flags that came from what the participant said (or from a person or
 * the model flagging them): every 'flagged' event on this session, plus those
 * on the same participant's other sessions since `since`.
 *
 * The 'recovery_continuation' mark is excluded on purpose. A recovery session
 * is stamped high the moment it starts, whatever the session it continues was
 * (markSessionCrisisContinuation), so that stamp says "this follows a vendor
 * cut", not "this participant is at high risk".
 */
export async function getParticipantFlagEvents(
  sessionId: string,
  userId: number | null,
  since: Date,
): Promise<ParticipantFlagRow[]> {
  const result = await pool.query<ParticipantFlagRow>(
    `SELECT ce.session_id, ce.severity, ce.risk_score,
            CASE WHEN ce.risk_factors @> '${THIRD_PARTY_FACTOR_JSON}'::jsonb THEN 'third_party'
                 WHEN ce.risk_factors @> '${HARM_TO_OTHERS_FACTOR_JSON}'::jsonb THEN 'harm_to_others'
                 ELSE NULL END AS subject
       FROM crisis_events ce
       JOIN therapy_sessions ts ON ts.session_id = ce.session_id
      WHERE ce.event_type = 'flagged'
        AND NOT COALESCE(ce.risk_factors @> '["recovery_continuation"]'::jsonb, FALSE)
        AND (ce.session_id = $1
             OR ($2::int IS NOT NULL AND ts.user_id = $2::int AND ce.created_at >= $3))`,
    [sessionId, userId, since],
  );
  return result.rows;
}

/**
 * What the risk assessor actually scored for the participant's own turns:
 * the highest medium and the highest high score in risk_score_history, on
 * this session and on the same participant's other sessions since `since`.
 *
 * Needed beside the flag events because a turn can score high WITHOUT a flag
 * event being written. The pipeline re-flags an already-flagged session only
 * when severity rises or the score exceeds the stored one by more than 10,
 * and a recovery session is stamped high from its first second (at the
 * inherited score, or 100 when there is none). A real disclosure in a
 * recovery session therefore leaves no 'flagged' event of its own; without
 * this read, the cut of that session would be classified "no risk".
 * `severity` is the band stored when the turn was scored, so this does not
 * carry a copy of the thresholds.
 */
export async function getParticipantAssessedRisk(
  sessionId: string,
  userId: number | null,
  since: Date,
): Promise<ParticipantFlagRow[]> {
  const result = await pool.query<{
    severity: string | null;
    risk_score: number | string | null;
    subject: string | null;
  }>(
    `SELECT h.severity, MAX(h.risk_score) AS risk_score,
            CASE WHEN h.score_factors->>'third_party' = 'true' THEN 'third_party'
                 WHEN h.score_factors->>'harm_to_others' = 'true' THEN 'harm_to_others'
                 ELSE NULL END AS subject
       FROM risk_score_history h
       JOIN therapy_sessions ts ON ts.session_id = h.session_id
      WHERE h.severity IN ('medium', 'high')
        AND (h.session_id = $1
             OR ($2::int IS NOT NULL AND ts.user_id = $2::int AND h.calculated_at >= $3))
      GROUP BY h.severity, 3`,
    [sessionId, userId, since],
  );
  return result.rows.map((row) => ({
    session_id: sessionId,
    severity: row.severity,
    risk_score: row.risk_score === null ? null : Number(row.risk_score),
    subject: row.subject ?? null,
  }));
}

/**
 * Is this session's high flag nothing but the automatic recovery-continuation
 * stamp? True when the stamp's event exists and no other 'flagged' event at
 * high severity does: nobody has yet been paged about anything the
 * participant said in this session.
 */
export async function highFlagIsContinuationStampOnly(sessionId: string): Promise<boolean> {
  const result = await pool.query<{ stamped: boolean; real_high: boolean }>(
    `SELECT EXISTS (SELECT 1 FROM crisis_events ce
                     WHERE ce.session_id = $1 AND ce.event_type = 'flagged'
                       AND ce.risk_factors @> '["recovery_continuation"]'::jsonb) AS stamped,
            EXISTS (SELECT 1 FROM crisis_events ce
                     WHERE ce.session_id = $1 AND ce.event_type = 'flagged' AND ce.severity = 'high'
                       AND NOT COALESCE(ce.risk_factors @> '["recovery_continuation"]'::jsonb, FALSE)) AS real_high`,
    [sessionId],
  );
  const row = result.rows[0];
  return row?.stamped === true && row.real_high !== true;
}

/**
 * Has this participant said anything, in any session (the recovery session
 * and the typed-chat fallback are new session ids), since `since`? Every
 * participant turn is persisted before it is scored, so a row here means the
 * risk pipeline is looking at them again.
 */
export async function participantSpokeSince(userId: number, since: Date): Promise<boolean> {
  const result = await pool.query(
    `SELECT 1
       FROM messages m
       JOIN therapy_sessions ts ON ts.session_id = m.session_id
      WHERE ts.user_id = $1::int
        AND m.role = 'user'
        AND m.created_at > $2
      LIMIT 1`,
    [userId, since],
  );
  return result.rows.length > 0;
}

/** Write one paging decision against a session; returns its action_id. */
export async function insertPagingRecord(
  sessionId: string,
  actionType: 'crisis_sms_alert' | 'external_api_called',
  details: Record<string, unknown>,
  riskScore: number | null,
): Promise<number | null> {
  const result = await pool.query<{ action_id: number | string }>(
    `INSERT INTO intervention_actions (session_id, action_type, action_details, risk_score)
     VALUES ($1, $2, $3, $4)
     RETURNING action_id`,
    [sessionId, actionType, JSON.stringify(details), riskScore],
  );
  const id = Number(result.rows[0]?.action_id);
  return Number.isFinite(id) ? id : null;
}
