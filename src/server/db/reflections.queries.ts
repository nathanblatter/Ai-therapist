// Participant reflections (ai-therapist-204): the SELF-scoped read behind
// GET /api/me/reflections. Composed here so the route stays SQL-free.
//
// Two rules shape the SQL:
//
//  1. Ownership. Rows are selected FROM therapy_sessions WHERE user_id = $1
//     and the insights join additionally requires si.user_id = ts.user_id, so
//     an insights row can only ever be read through a session that belongs to
//     the caller AND that the insights row itself is stamped with. There is no
//     session-id parameter: a caller cannot name a row.
//
//  2. Column allow-list. Only the two participant-safe summary fields are
//     selected (summary->'topics', summary->'techniques_discussed'). The SOAP
//     note, affect curve, clinician notes, the summary headline /
//     mood_trajectory / follow_up / safety line and every crisis column stay
//     in the database. The one derived value that does leave is the boolean
//     `text_withheld`, which the projection consumes and never forwards.
import { pool } from '../config/db.js';
import { countUserEndedSessions } from './insights.queries.js';
import { getUserMoodTrajectory, type MoodPoint } from './returningContext.queries.js';
import { getUserLastSessionAt, getUserWeeklySessionCounts, type WeeklySessionCount } from './progress.queries.js';

/** Tool calls that put crisis/safety material on the participant's screen or
 *  hand the conversation to a human. Mirrors RESOURCE_CARD_TOOLS +
 *  escalate_to_human in crisis.queries.ts (getSessionSafetyContext). */
const SAFETY_TOOL_NAMES = ['show_resource_card', 'get_crisis_resources', 'create_safety_plan', 'escalate_to_human'];

export interface OwnReflectionSessionRow {
  session_date: Date;
  /** Raw JSONB from session_insights.summary->'topics' (untrusted shape). */
  topics: unknown;
  /** Raw JSONB from session_insights.summary->'techniques_discussed'. */
  techniques: unknown;
  checkin_topic: string | null;
  checkin_goal: string | null;
  worksheets_completed: number;
  /** True when anything safety-relevant is recorded against the session. The
   *  projection drops the reflective text for such a session and does not
   *  forward this flag. */
  text_withheld: boolean;
}

/**
 * The caller's ended sessions, newest first, with only participant-safe
 * columns. `text_withheld` is true when the session has ANY of: a crisis flag
 * or severity on the session row, a crisis_events row, a risk-check step, an
 * escalation, a safety/crisis tool call, an adverse-event report, or a
 * non-empty safety line in its summary. That is the same set of signals that
 * makes the summarizer write a safety-aware (clinician-facing) summary, plus
 * the session-row flag and risk-check steps.
 */
export async function listOwnReflectionSessions(userId: number, limit = 20): Promise<OwnReflectionSessionRow[]> {
  const result = await pool.query<
    Omit<OwnReflectionSessionRow, 'worksheets_completed'> & { worksheets_completed: string }
  >(
    `SELECT COALESCE(ts.ended_at, ts.created_at) AS session_date,
            si.summary->'topics' AS topics,
            si.summary->'techniques_discussed' AS techniques,
            ts.checkin->>'topic' AS checkin_topic,
            ts.checkin->>'goal' AS checkin_goal,
            (SELECT COUNT(*) FROM worksheet_instances wi
              WHERE wi.session_id = ts.session_id AND wi.status = 'completed') AS worksheets_completed,
            (
              COALESCE(ts.crisis_flagged, FALSE)
              OR ts.crisis_severity IS NOT NULL
              OR EXISTS (SELECT 1 FROM session_insights sx
                          WHERE sx.session_id = ts.session_id
                            AND COALESCE(BTRIM(sx.summary->>'safety'), '') <> '')
              OR EXISTS (SELECT 1 FROM crisis_events ce WHERE ce.session_id = ts.session_id)
              OR EXISTS (SELECT 1 FROM risk_check_steps rc WHERE rc.session_id = ts.session_id)
              OR EXISTS (SELECT 1 FROM escalations e WHERE e.session_id = ts.session_id)
              OR EXISTS (SELECT 1 FROM tool_invocations ti
                          WHERE ti.session_id = ts.session_id AND ti.tool_name = ANY($3::text[]))
              OR EXISTS (SELECT 1 FROM adverse_event_reports ae
                          WHERE ae.session_id = ts.session_id OR ae.session_ref = ts.session_id)
            ) AS text_withheld
     FROM therapy_sessions ts
     LEFT JOIN session_insights si
       ON si.session_id = ts.session_id AND si.user_id = ts.user_id
     WHERE ts.user_id = $1 AND ts.status = 'ended'
     ORDER BY COALESCE(ts.ended_at, ts.created_at) DESC
     LIMIT $2`,
    [userId, limit, SAFETY_TOOL_NAMES],
  );
  return result.rows.map((row) => ({ ...row, worksheets_completed: parseInt(row.worksheets_completed, 10) || 0 }));
}

export interface OwnWorksheetCounts {
  completed: number;
  in_progress: number;
}

/** How many worksheets the caller has finished / still has in draft. */
export async function countOwnWorksheets(userId: number): Promise<OwnWorksheetCounts> {
  const result = await pool.query<{ completed: string; in_progress: string }>(
    `SELECT COUNT(*) FILTER (WHERE wi.status = 'completed') AS completed,
            COUNT(*) FILTER (WHERE wi.status = 'draft') AS in_progress
     FROM worksheet_instances wi
     JOIN therapy_sessions ts ON ts.session_id = wi.session_id
     WHERE ts.user_id = $1`,
    [userId],
  );
  return {
    completed: parseInt(result.rows[0]?.completed ?? '0', 10),
    in_progress: parseInt(result.rows[0]?.in_progress ?? '0', 10),
  };
}

/** Everything the reflections projection reads, before the allow-list. */
export interface OwnReflectionSource {
  sessions: OwnReflectionSessionRow[];
  mood: MoodPoint[];
  worksheets: OwnWorksheetCounts;
  session_count: number;
  last_session_at: Date | null;
  weekly_sessions: WeeklySessionCount[];
}

/** Self-scoped by design: callers must pass the SESSION user's id. */
export async function getOwnReflectionSource(userId: number): Promise<OwnReflectionSource> {
  const [sessions, mood, worksheets, sessionCount, lastSessionAt, weeklySessions] = await Promise.all([
    listOwnReflectionSessions(userId, 20),
    getUserMoodTrajectory(userId, 30),
    countOwnWorksheets(userId),
    countUserEndedSessions(userId),
    getUserLastSessionAt(userId),
    getUserWeeklySessionCounts(userId, 8),
  ]);
  return {
    sessions,
    mood,
    worksheets,
    session_count: sessionCount,
    last_session_at: lastSessionAt,
    weekly_sessions: weeklySessions,
  };
}
