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
// No new table and no migration. The one piece of state that is UPDATED rather
// than appended is the silence check of a vendor cut that was not paged
// (action_details.paging.silenceCheck on the cut's own row): pending, then
// claimed by exactly one app instance, then done. See the end of this file.
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
}

/**
 * How far back a recovery chain is followed. A chain is as long as the
 * incident, which can be hours (each link may run to the vendor's session
 * ceiling); this only stops a walk from reaching into an earlier day.
 */
export const INCIDENT_CHAIN_BACKSTOP_MS = 12 * 60 * 60 * 1000;

/**
 * The recovery chain this session belongs to: the session itself and, while
 * the session being looked at carries the automatic 'recovery_continuation'
 * stamp, the same participant's session immediately before it. A recovery
 * session is started by the app the moment its predecessor is cut and is
 * stamped then (markSessionCrisisContinuation), so "stamped" means "continues
 * the participant's previous session"; no column links the two.
 *
 * "Previous" prefers the session whose vendor termination was recorded just
 * before this one started (a paging row of kind vendor_cut / vendor_ceiling
 * from 15 minutes before to 1 minute after its start; the row can land a few
 * seconds after the recovery begins). Only without such a row is it the
 * session started last. Start order alone mislinks a participant with a
 * second session open (a typed chat on another device started between the
 * cut session and its recovery): the walk stopped at that session, and a
 * real high flag more than INCIDENT_LOOKBACK_MS old dropped out of the peak.
 *
 * An incident is this chain, however long it has been running: a participant
 * flagged high whose recovery session is cut 2 h 20 min later is still the
 * same incident. `backstop` bounds the walk in time (a link that started
 * before it is not followed further back) and the depth is capped, so a
 * pathological history cannot make this slow or pull in last week.
 * Always contains `sessionId`, including for a row that does not exist yet.
 *
 * EXPLICIT LINKS FIRST (ai-therapist-356 follow-up). Since the text hand-off,
 * the app writes the link itself: a typed chat that continues a cut voice
 * call, and a voice call started again from such a chat, each carry an
 * intervention_actions row (action_details.event 'voice_cut_text_handoff' or
 * 'voice_resumed_from_text') naming the session they continue under `from`
 * (db/textHandoff.queries). Where such a row exists it IS the predecessor,
 * whatever the stamp or the start order say: it is the only record written at
 * the moment the two sessions were joined, it also covers an anonymous
 * participant (same user, or both without one), and it covers a voice call
 * started again from a chat, which carries no stamp. The stamp-and-start-order
 * walk above remains only for a session with no link row (the recovery voice
 * sessions of a deployment with typed chat switched off, sessions from before
 * the hand-off, a link row whose write failed). This function is the one
 * source of truth for "the sessions of this incident": the paging policy
 * (resolveIncidentPeak) and the hand-off's wording and seeding
 * (textHandoff.service) both read it. Ordered from `sessionId` backwards.
 */
export async function getIncidentChainSessionIds(sessionId: string, backstop: Date): Promise<string[]> {
  const result = await pool.query<{ session_id: string }>(
    `WITH RECURSIVE chain AS (
       SELECT ts.session_id, ts.user_id, ts.created_at, 0 AS depth
         FROM therapy_sessions ts
        WHERE ts.session_id = $1
       UNION ALL
       SELECT prev.session_id, prev.user_id, prev.created_at, c.depth + 1
         FROM chain c
         CROSS JOIN LATERAL (
           SELECT cand.session_id, cand.user_id, cand.created_at
             FROM (
               -- 1. The link row the hand-off wrote (newest first).
               (SELECT p.session_id, p.user_id, p.created_at, 0 AS pref
                  FROM intervention_actions ia
                  JOIN therapy_sessions p ON p.session_id = ia.action_details->>'from'
                 WHERE ia.session_id = c.session_id
                   AND ia.action_type = 'external_api_called'
                   AND ia.action_details->>'event' IN ('voice_cut_text_handoff', 'voice_resumed_from_text')
                   AND p.session_id <> c.session_id
                   AND p.created_at <= c.created_at
                   AND p.user_id IS NOT DISTINCT FROM c.user_id
                 ORDER BY ia.performed_at DESC
                 LIMIT 1)
               UNION ALL
               -- 2. No link row: a stamped session continues the participant's
               --    session cut just before it, else the one started last.
               (SELECT p.session_id, p.user_id, p.created_at, 1 AS pref
                  FROM therapy_sessions p
                 WHERE c.user_id IS NOT NULL
                   AND p.user_id = c.user_id
                   AND p.session_id <> c.session_id
                   AND p.created_at < c.created_at
                   AND EXISTS (SELECT 1 FROM crisis_events ce
                                WHERE ce.session_id = c.session_id
                                  AND ce.event_type = 'flagged'
                                  AND ce.risk_factors @> '["recovery_continuation"]'::jsonb)
                 ORDER BY EXISTS (SELECT 1 FROM intervention_actions ia
                                   WHERE ia.session_id = p.session_id
                                     AND ia.action_details #>> '{paging,kind}' IN ('vendor_cut', 'vendor_ceiling')
                                     AND ia.performed_at >= c.created_at - interval '15 minutes'
                                     AND ia.performed_at <= c.created_at + interval '1 minute') DESC,
                          p.created_at DESC
                 LIMIT 1)
             ) cand
            ORDER BY cand.pref
            LIMIT 1
         ) prev
        WHERE c.depth < 25
          AND c.created_at >= $2
     )
     SELECT session_id FROM chain ORDER BY depth`,
    [sessionId, backstop],
  );
  // Ordered, without repeats (a loop of link rows cannot repeat a session).
  const ids = [...new Set(result.rows.map((row) => row.session_id))];
  return ids.includes(sessionId) ? ids : [sessionId, ...ids];
}

/**
 * Crisis events that say what the participant's risk was, from what they said
 * or from a person or the model judging it: every such event on the sessions
 * of the incident (`sessionIds`, see getIncidentChainSessionIds), plus those
 * on the same participant's other sessions since `since`.
 *
 * Counted: 'flagged' (auto, manual, the model's escalate tool), and the two
 * event types a member of staff writes when they revise a session's risk by
 * hand, 'risk_score_updated' and 'severity_changed'. A researcher who raised
 * a session to high has said the participant is at high risk; a vendor cut
 * afterwards must not be reported as "no risk signal". A revision DOWNWARD
 * changes nothing here, because the caller takes the peak: the earlier,
 * higher event is still in the incident.
 *
 * The 'recovery_continuation' mark is excluded on purpose. A recovery session
 * is stamped high the moment it starts, whatever the session it continues was
 * (markSessionCrisisContinuation), so that stamp says "this follows a vendor
 * cut", not "this participant is at high risk".
 */
export async function getParticipantFlagEvents(
  sessionIds: string[],
  userId: number | null,
  since: Date,
): Promise<ParticipantFlagRow[]> {
  const result = await pool.query<ParticipantFlagRow>(
    `SELECT ce.session_id, ce.severity, ce.risk_score
       FROM crisis_events ce
       JOIN therapy_sessions ts ON ts.session_id = ce.session_id
      WHERE ce.event_type IN ('flagged', 'risk_score_updated', 'severity_changed')
        AND NOT COALESCE(ce.risk_factors @> '["recovery_continuation"]'::jsonb, FALSE)
        AND (ce.session_id = ANY($1::text[])
             OR ($2::int IS NOT NULL AND ts.user_id = $2::int AND ce.created_at >= $3))`,
    [sessionIds, userId, since],
  );
  return result.rows;
}

/**
 * What the risk assessor actually scored for the participant's own turns:
 * the highest medium and the highest high score in risk_score_history, on
 * the sessions of the incident and on the same participant's other sessions
 * since `since`.
 *
 * Needed beside the flag events because a turn can score high WITHOUT a flag
 * event being written: the pipeline re-flags an already-flagged session only
 * when severity rises or the score exceeds the stored one by more than 10.
 * `severity` is the band stored when the turn was scored, so this does not
 * carry a copy of the thresholds.
 */
export async function getParticipantAssessedRisk(
  sessionIds: string[],
  userId: number | null,
  since: Date,
): Promise<ParticipantFlagRow[]> {
  const result = await pool.query<{ severity: string | null; risk_score: number | string | null }>(
    `SELECT h.severity, MAX(h.risk_score) AS risk_score
       FROM risk_score_history h
       JOIN therapy_sessions ts ON ts.session_id = h.session_id
      WHERE h.severity IN ('medium', 'high')
        AND (h.session_id = ANY($1::text[])
             OR ($2::int IS NOT NULL AND ts.user_id = $2::int AND h.calculated_at >= $3))
      GROUP BY h.severity`,
    [sessionIds, userId, since],
  );
  return result.rows.map((row) => ({
    session_id: sessionIds[0] ?? '',
    severity: row.severity,
    risk_score: row.risk_score === null ? null : Number(row.risk_score),
  }));
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

// ---- the silence check of an unpaged vendor cut (ai-therapist-362) ---------
//
// A vendor cut with no participant risk signal writes a 'no_page' row that
// promises a check a few minutes later. The promise lives on that row, under
// action_details.paging.silenceCheck:
//   { state: 'pending' }                         written with the row
//   { state: 'running', claimedAt, claimedBy }   one instance has taken it
//   { state: 'done', outcome, ... }              it ran; it never runs again
//   { state: 'expired', ... }                    nobody ran it in time, or
//                                                its page was never delivered
// so any app instance, including one that started after the cut, can find
// what is owed and run it, and two instances cannot both run the same check.
// A check whose page was NOT delivered goes back to 'pending' with `attempts`
// counted (releaseSilenceCheck), so the next sweep tries again: the page is
// still owed. Claim and finish keep the fields already on the check.

export interface UnfinishedSilenceCheckRow {
  action_id: number;
  session_id: string;
  /** Age of the row by the DATABASE clock, so a skewed app clock cannot make
   *  a check run early or look expired. */
  age_ms: number;
  /** Earlier runs whose page was not delivered (0 for a check never run). */
  attempts: number;
}

const SILENCE_CHECK_OPEN_SQL = `(ia.action_details #>> '{paging,silenceCheck,state}' = 'pending'
             OR (ia.action_details #>> '{paging,silenceCheck,state}' = 'running'
                 AND (ia.action_details #>> '{paging,silenceCheck,claimedAt}')::timestamptz
                     < now() - make_interval(secs => $2::double precision)))`;

/**
 * 'no_page' vendor-cut rows whose silence check has not finished: pending, or
 * claimed more than `staleClaimSeconds` ago by an instance that never
 * reported back (it died mid-check). Oldest first, no older than
 * `lookbackSeconds`.
 *
 * Harness and demo sessions (therapy_sessions.is_demo) are left out: an eval
 * child shares this database with a live server, and a server must never
 * page a person about a synthetic session whose child has exited. Their
 * check still runs in the process that recorded the cut.
 */
export async function getUnfinishedSilenceChecks(
  lookbackSeconds: number,
  staleClaimSeconds: number,
): Promise<UnfinishedSilenceCheckRow[]> {
  const result = await pool.query<{
    action_id: number | string;
    session_id: string;
    age_ms: number | string;
    attempts: number | string | null;
  }>(
    `SELECT ia.action_id, ia.session_id,
            EXTRACT(EPOCH FROM (now() - ia.performed_at)) * 1000 AS age_ms,
            COALESCE((ia.action_details #>> '{paging,silenceCheck,attempts}')::int, 0) AS attempts
       FROM intervention_actions ia
       JOIN therapy_sessions ts ON ts.session_id = ia.session_id
      WHERE ia.action_type = 'external_api_called'
        AND ia.performed_at >= now() - make_interval(secs => $1::double precision)
        AND ia.action_details #>> '{paging,decision}' = 'no_page'
        AND ts.is_demo IS NOT TRUE
        AND ${SILENCE_CHECK_OPEN_SQL}
      ORDER BY ia.performed_at ASC
      LIMIT 200`,
    [lookbackSeconds, staleClaimSeconds],
  );
  return result.rows.map((row) => ({
    action_id: Number(row.action_id),
    session_id: row.session_id,
    age_ms: Number(row.age_ms),
    attempts: Number(row.attempts ?? 0),
  }));
}

/**
 * Take a silence check, atomically: one UPDATE that only matches while the
 * check is pending (or its claim is stale). Postgres re-evaluates the WHERE
 * after a concurrent writer commits, so of two instances (or the in-process
 * timer and the sweep) exactly one gets the row back. Returns the session and
 * the time the cut was recorded when the claim was won; null when someone
 * else has it, it has finished, or the row carries no silence check.
 */
export async function claimSilenceCheck(
  actionId: number,
  claimedBy: string,
  staleClaimSeconds: number,
): Promise<{ sessionId: string; cutAt: Date; attempts: number; isDemo: boolean } | null> {
  const result = await pool.query<{
    session_id: string;
    performed_at: Date;
    attempts: number | string | null;
    is_demo: boolean | null;
  }>(
    `UPDATE intervention_actions ia
        SET action_details = jsonb_set(
              ia.action_details,
              '{paging,silenceCheck}',
              COALESCE(ia.action_details #> '{paging,silenceCheck}', '{}'::jsonb)
                || jsonb_build_object('state', 'running', 'claimedAt', now(), 'claimedBy', $3::text))
      WHERE ia.action_id = $1
        AND ia.action_details #>> '{paging,decision}' = 'no_page'
        AND ${SILENCE_CHECK_OPEN_SQL}
      RETURNING ia.session_id, ia.performed_at,
                COALESCE((ia.action_details #>> '{paging,silenceCheck,attempts}')::int, 0) AS attempts,
                (SELECT ts.is_demo FROM therapy_sessions ts WHERE ts.session_id = ia.session_id) AS is_demo`,
    [actionId, staleClaimSeconds, claimedBy],
  );
  const row = result.rows[0];
  return row
    ? {
        sessionId: row.session_id,
        cutAt: new Date(row.performed_at),
        attempts: Number(row.attempts ?? 0),
        isDemo: row.is_demo === true,
      }
    : null;
}

/**
 * Hand a claimed check back as still owed: it ran, but its page was not
 * delivered. `result` (attempts, last outcome, the page row) is kept on the
 * check, and the next sweep claims it again. Returns whether this call did it.
 */
export async function releaseSilenceCheck(actionId: number, result: Record<string, unknown>): Promise<boolean> {
  const updated = await pool.query(
    `UPDATE intervention_actions ia
        SET action_details = jsonb_set(
              ia.action_details,
              '{paging,silenceCheck}',
              (ia.action_details #> '{paging,silenceCheck}') - 'claimedAt' - 'claimedBy'
                || $2::jsonb || jsonb_build_object('state', 'pending'))
      WHERE ia.action_id = $1
        AND ia.action_details #>> '{paging,silenceCheck,state}' = 'running'`,
    [actionId, JSON.stringify(result)],
  );
  return (updated.rowCount ?? 0) > 0;
}

/**
 * Record how a silence check ended ('done': it ran; 'expired': it was found
 * too late to be worth a page). Terminal: a finished check is never selected
 * or claimed again. `result` is stored beside the state. Returns whether this
 * call was the one that finished it.
 */
export async function finishSilenceCheck(
  actionId: number,
  state: 'done' | 'expired',
  result: Record<string, unknown>,
): Promise<boolean> {
  const updated = await pool.query(
    `UPDATE intervention_actions ia
        SET action_details = jsonb_set(
              ia.action_details,
              '{paging,silenceCheck}',
              COALESCE(ia.action_details #> '{paging,silenceCheck}', '{}'::jsonb)
                || $2::jsonb || jsonb_build_object('state', $3::text, 'finishedAt', now()))
      WHERE ia.action_id = $1
        AND ia.action_details #>> '{paging,silenceCheck,state}' IN ('pending', 'running')`,
    [actionId, JSON.stringify(result), state],
  );
  return (updated.rowCount ?? 0) > 0;
}
