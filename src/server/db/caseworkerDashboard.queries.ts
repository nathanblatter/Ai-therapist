// Data-access for the caseworker triage roster (caseworker portal, spec
// section 3). THIS MODULE IS THE SUMMARIES-TIER AUDIT BOUNDARY: it selects
// only from users, therapy_sessions (timestamps + checkin JSONB),
// session_insights.summary, risk_score_history, crisis_events,
// scale_responses, practice_assignments, escalations, message counts, and
// safety plans. The messages table is NEVER joined here — nothing this module
// returns can contain verbatim session content. Keep it that way; the test
// asserts it.
//
// The roster is one lateral-join round trip (caseloads are tens of rows).
// "Needs attention" ranking is computed in TS by the dashboard route/service
// with explainable {code,label,points} reasons.
import { pool } from '../config/db.js';

export interface RosterRow {
  client_id: number;
  username: string;
  assigned_at: string;
  member_role: string;
  last_session_at: string | null;
  ended_session_count: number;
  last_checkin_mood: number | null;
  last_summary: unknown;
  last_summary_session_id: string | null;
  latest_risk_score: number | null;
  latest_risk_severity: string | null;
  latest_risk_at: string | null;
  open_crisis_count: number;
  latest_scales: unknown;
  open_escalation_count: number;
  overdue_practice_count: number;
  has_safety_plan: boolean;
}

/**
 * The member's roster in one round trip: per assigned client, engagement
 * timestamps, the latest AI summary, risk/crisis signals, screener scores,
 * escalations, practice, and safety-plan presence. Transcript-free by
 * construction (see module header).
 */
export async function listCaseworkerRoster(memberId: number): Promise<RosterRow[]> {
  const result = await pool.query<RosterRow>(
    `SELECT
       tc.client_id,
       u.username,
       tc.assigned_at::text AS assigned_at,
       tc.member_role,
       sess.last_session_at,
       COALESCE(sess.ended_session_count, 0)::int AS ended_session_count,
       sess.last_checkin_mood,
       ins.summary AS last_summary,
       ins.session_id AS last_summary_session_id,
       risk.risk_score AS latest_risk_score,
       risk.severity AS latest_risk_severity,
       risk.calculated_at AS latest_risk_at,
       COALESCE(crisis.open_crisis_count, 0)::int AS open_crisis_count,
       scales.latest_scales,
       COALESCE(esc.open_escalation_count, 0)::int AS open_escalation_count,
       COALESCE(practice.overdue_practice_count, 0)::int AS overdue_practice_count,
       COALESCE(sp.has_safety_plan, FALSE) AS has_safety_plan
     FROM therapist_clients tc
     JOIN users u ON u.userid = tc.client_id
     LEFT JOIN LATERAL (
       SELECT MAX(ts.created_at)::text AS last_session_at,
              COUNT(*) FILTER (WHERE ts.status = 'ended') AS ended_session_count,
              (SELECT (ts2.checkin->>'mood')::int FROM therapy_sessions ts2
               WHERE ts2.user_id = tc.client_id AND ts2.checkin IS NOT NULL
               ORDER BY ts2.created_at DESC LIMIT 1) AS last_checkin_mood
       FROM therapy_sessions ts WHERE ts.user_id = tc.client_id
     ) sess ON TRUE
     LEFT JOIN LATERAL (
       SELECT si.summary, si.session_id FROM session_insights si
       WHERE si.user_id = tc.client_id AND si.summary IS NOT NULL
       ORDER BY si.created_at DESC LIMIT 1
     ) ins ON TRUE
     LEFT JOIN LATERAL (
       SELECT rsh.risk_score, rsh.severity, rsh.calculated_at::text AS calculated_at
       FROM risk_score_history rsh
       JOIN therapy_sessions ts ON ts.session_id = rsh.session_id
       WHERE ts.user_id = tc.client_id
       ORDER BY rsh.calculated_at DESC LIMIT 1
     ) risk ON TRUE
     LEFT JOIN LATERAL (
       SELECT COUNT(*) AS open_crisis_count
       FROM therapy_sessions ts
       WHERE ts.user_id = tc.client_id AND ts.crisis_flagged = TRUE
     ) crisis ON TRUE
     LEFT JOIN LATERAL (
       SELECT jsonb_agg(latest) AS latest_scales FROM (
         SELECT DISTINCT ON (sr.scale)
                jsonb_build_object('scale', sr.scale, 'score', sr.score,
                                   'created_at', sr.created_at) AS latest
         FROM scale_responses sr
         JOIN therapy_sessions ts ON ts.session_id = sr.session_id
         WHERE ts.user_id = tc.client_id
         ORDER BY sr.scale, sr.created_at DESC
       ) per_scale
     ) scales ON TRUE
     LEFT JOIN LATERAL (
       SELECT COUNT(*) AS open_escalation_count
       FROM escalations e
       WHERE e.client_id = tc.client_id AND e.status <> 'resolved'
     ) esc ON TRUE
     LEFT JOIN LATERAL (
       SELECT COUNT(*) AS overdue_practice_count
       FROM practice_assignments pa
       WHERE pa.user_id = tc.client_id AND pa.status = 'assigned'
         AND pa.assigned_at < now() - INTERVAL '7 days'
     ) practice ON TRUE
     LEFT JOIN LATERAL (
       SELECT TRUE AS has_safety_plan
       FROM safety_plans p WHERE p.user_id = tc.client_id LIMIT 1
     ) sp ON TRUE
     WHERE tc.therapist_id = $1
     ORDER BY u.username`,
    [memberId]
  );
  return result.rows;
}

export interface RosterClientDetail {
  recent_summaries: Array<{
    session_id: string;
    ended_at: string | null;
    summary: unknown;
  }>;
  scale_history: Array<{ scale: string; score: number; created_at: string }>;
  risk_history: Array<{
    risk_score: number;
    severity: string | null;
    calculated_at: string;
  }>;
  mood_history: Array<{ mood: number | null; created_at: string }>;
  safety_plan: unknown;
}

/**
 * Summary-tier drill-down for one roster client. Same audit boundary as the
 * roster: AI summaries, screeners, risk scores (no score_factors — the LLM
 * reasoning can quote messages), check-in moods, latest safety plan. No
 * transcripts, no SOAP notes.
 */
export async function getRosterClientDetail(clientId: number): Promise<RosterClientDetail> {
  const [summaries, scaleHistory, riskHistory, moodHistory, safetyPlan] = await Promise.all([
    pool.query(
      `SELECT si.session_id, ts.ended_at::text AS ended_at, si.summary
       FROM session_insights si
       JOIN therapy_sessions ts ON ts.session_id = si.session_id
       WHERE si.user_id = $1 AND si.summary IS NOT NULL
       ORDER BY si.created_at DESC
       LIMIT 5`,
      [clientId]
    ),
    pool.query(
      `SELECT sr.scale, sr.score, sr.created_at::text AS created_at
       FROM scale_responses sr
       JOIN therapy_sessions ts ON ts.session_id = sr.session_id
       WHERE ts.user_id = $1
       ORDER BY sr.created_at DESC
       LIMIT 40`,
      [clientId]
    ),
    pool.query(
      `SELECT rsh.risk_score, rsh.severity, rsh.calculated_at::text AS calculated_at
       FROM risk_score_history rsh
       JOIN therapy_sessions ts ON ts.session_id = rsh.session_id
       WHERE ts.user_id = $1
       ORDER BY rsh.calculated_at DESC
       LIMIT 50`,
      [clientId]
    ),
    pool.query(
      `SELECT (checkin->>'mood')::int AS mood, created_at::text AS created_at
       FROM therapy_sessions
       WHERE user_id = $1 AND checkin IS NOT NULL
       ORDER BY created_at DESC
       LIMIT 30`,
      [clientId]
    ),
    pool.query(
      `SELECT plan FROM safety_plans WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [clientId]
    ),
  ]);
  return {
    recent_summaries: summaries.rows,
    scale_history: scaleHistory.rows,
    risk_history: riskHistory.rows,
    mood_history: moodHistory.rows,
    safety_plan: safetyPlan.rows[0]?.plan ?? null,
  };
}
