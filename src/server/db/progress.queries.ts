// Participant-facing progress home (ai-therapist-121): the SELF-scoped slice
// of what the system knows about a participant, shown between sessions.
// Deliberately narrower than getUserProfileBundle — no memories, case profile,
// clinician notes, or crisis history (clinical framing stays admin-side).
// Composed here so the /api/me/* routes stay SQL-free.
import { pool } from '../config/db.js';
import { countUserEndedSessions } from './insights.queries.js';
import {
  getUserScaleHistory,
  getUserMoodTrajectory,
  getUserLatestSafetyPlan,
  type ScaleScorePoint,
  type MoodPoint,
} from './returningContext.queries.js';
import type { WorksheetSection } from './worksheets.queries.js';

/** When the participant's most recent ended session finished, or null if none. */
export async function getUserLastSessionAt(userId: number): Promise<Date | null> {
  const result = await pool.query<{ last_session_at: Date | null }>(
    `SELECT MAX(COALESCE(ended_at, created_at)) AS last_session_at
     FROM therapy_sessions
     WHERE user_id = $1 AND status = 'ended'`,
    [userId]
  );
  return result.rows[0]?.last_session_at ?? null;
}

export interface WeeklySessionCount {
  /** Monday of the week (UTC date truncation). */
  week_start: Date;
  sessions: number;
}

/** Ended sessions per week for the last `weeks` weeks (oldest first), with
 *  zero-filled weeks so the client can render continuity without gap logic. */
export async function getUserWeeklySessionCounts(userId: number, weeks = 8): Promise<WeeklySessionCount[]> {
  const result = await pool.query<{ week_start: Date; sessions: string }>(
    `SELECT w.week_start,
            COUNT(ts.session_id) AS sessions
     FROM generate_series(
            date_trunc('week', CURRENT_TIMESTAMP) - ($2::int - 1) * INTERVAL '1 week',
            date_trunc('week', CURRENT_TIMESTAMP),
            INTERVAL '1 week'
          ) AS w(week_start)
     LEFT JOIN therapy_sessions ts
       ON ts.user_id = $1
      AND ts.status = 'ended'
      AND date_trunc('week', COALESCE(ts.ended_at, ts.created_at)) = w.week_start
     GROUP BY w.week_start
     ORDER BY w.week_start ASC`,
    [userId, weeks]
  );
  return result.rows.map(row => ({ week_start: row.week_start, sessions: parseInt(row.sessions, 10) }));
}

export interface OwnProgress {
  session_count: number;
  last_session_at: Date | null;
  /** PHQ-2/GAD-2 responses, most recent first within each scale. */
  scale_history: ScaleScorePoint[];
  /** Check-in / log_mood points, newest first. */
  mood_trajectory: MoodPoint[];
  /** Sessions per week over the last 8 weeks, oldest first, zero-filled. */
  weekly_sessions: WeeklySessionCount[];
  has_safety_plan: boolean;
}

/** Everything the participant progress home needs, fetched in parallel.
 *  Self-scoped by design: callers must pass the SESSION user's id. */
export async function getOwnProgress(userId: number): Promise<OwnProgress> {
  const [sessionCount, lastSessionAt, scaleHistory, moodTrajectory, weeklySessions, safetyPlan] =
    await Promise.all([
      countUserEndedSessions(userId),
      getUserLastSessionAt(userId),
      getUserScaleHistory(userId, 12),
      getUserMoodTrajectory(userId, 30),
      getUserWeeklySessionCounts(userId, 8),
      getUserLatestSafetyPlan(userId),
    ]);
  return {
    session_count: sessionCount,
    last_session_at: lastSessionAt,
    scale_history: scaleHistory,
    mood_trajectory: moodTrajectory,
    weekly_sessions: weeklySessions,
    has_safety_plan: safetyPlan !== null,
  };
}

export interface UserWorksheetInstance {
  instance_id: number;
  title: string;
  template_title: string | null;
  intro: string | null;
  sections: WorksheetSection[];
  responses: Record<string, string> | null;
  status: 'draft' | 'completed';
  created_at: Date;
  completed_at: Date | null;
}

/** All worksheet instances across a user's sessions, newest first. Scoped via
 *  the session -> user join; never trusts a client-supplied session id. */
export async function listUserWorksheetInstances(userId: number, limit = 50): Promise<UserWorksheetInstance[]> {
  const result = await pool.query<UserWorksheetInstance>(
    `SELECT wi.instance_id, wi.title, wi.template_title, wi.intro, wi.sections,
            wi.responses, wi.status, wi.created_at, wi.completed_at
     FROM worksheet_instances wi
     JOIN therapy_sessions ts ON ts.session_id = wi.session_id
     WHERE ts.user_id = $1
     ORDER BY wi.created_at DESC
     LIMIT $2`,
    [userId, limit]
  );
  return result.rows;
}
