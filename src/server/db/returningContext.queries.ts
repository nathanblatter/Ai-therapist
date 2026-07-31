// Cross-session signals fed back to a returning, consented participant's next
// session (ai-therapist-48/67/69/72): screener (PHQ-2/GAD-2) trend, mood
// trajectory (check-in vs log_mood), the existence/warning-signs of a safety
// plan, and the last shared thought record's balanced thought. Reads existing
// tables only — no new schema. Consumed by utils/promptContext.ts and the
// review_practice / compare_screener_trend / retrieve_safety_plan tools.
import { pool } from '../config/db.js';
import type { SafetyPlan } from './tools.queries.js';

export interface ScaleScorePoint {
  scale: string;
  score: number;
  created_at: Date;
  session_id: string;
}

/** Last two responses per scale for a user, most recent first, across all their sessions. */
export async function getUserScaleHistory(userId: number, perScale = 2): Promise<ScaleScorePoint[]> {
  const result = await pool.query<ScaleScorePoint & { rn: string }>(
    `SELECT scale, score, created_at, session_id, rn FROM (
       SELECT sr.scale, sr.score, sr.created_at, sr.session_id,
              ROW_NUMBER() OVER (PARTITION BY sr.scale ORDER BY sr.created_at DESC) AS rn
       FROM scale_responses sr
       JOIN therapy_sessions ts ON ts.session_id = sr.session_id
       WHERE ts.user_id = $1
     ) ranked
     WHERE rn <= $2
     ORDER BY scale, created_at DESC`,
    [userId, perScale]
  );
  return result.rows.map(({ rn: _rn, ...row }) => row);
}

/** Most recent response for one scale belonging to a user, optionally excluding one session (the current one). */
export async function getUserLatestScaleScore(
  userId: number,
  scale: string,
  excludeSessionId?: string
): Promise<{ score: number; created_at: Date; session_id: string } | null> {
  const result = await pool.query<{ score: number; created_at: Date; session_id: string }>(
    `SELECT sr.score, sr.created_at, sr.session_id
     FROM scale_responses sr
     JOIN therapy_sessions ts ON ts.session_id = sr.session_id
     WHERE ts.user_id = $1 AND sr.scale = $2 AND ($3::text IS NULL OR sr.session_id != $3)
     ORDER BY sr.created_at DESC
     LIMIT 1`,
    [userId, scale, excludeSessionId ?? null]
  );
  return result.rows[0] ?? null;
}

export interface MoodPoint {
  date: Date;
  source: 'checkin' | 'log_mood';
  mood: number;
}

/** Recent mood signals from pre-session check-ins and the log_mood tool, newest first. */
export async function getUserMoodTrajectory(userId: number, limit = 6): Promise<MoodPoint[]> {
  const result = await pool.query<{ date: Date; source: 'checkin' | 'log_mood'; mood: number }>(
    `(
       SELECT ts.created_at AS date, 'checkin' AS source, (ts.checkin->>'mood')::int AS mood
       FROM therapy_sessions ts
       WHERE ts.user_id = $1 AND ts.checkin ? 'mood'
     )
     UNION ALL
     (
       SELECT ti.created_at AS date, 'log_mood' AS source, (ti.arguments->>'score')::int AS mood
       FROM tool_invocations ti
       JOIN therapy_sessions ts ON ts.session_id = ti.session_id
       WHERE ts.user_id = $1 AND ti.tool_name = 'log_mood' AND ti.success
     )
     ORDER BY date DESC
     LIMIT $2`,
    [userId, limit]
  );
  return result.rows;
}

/** The participant's most recent safety plan across all sessions (any consented user). */
export async function getUserLatestSafetyPlan(
  userId: number
): Promise<{ plan: SafetyPlan; created_at: Date; session_id: string | null } | null> {
  const result = await pool.query<{ plan: SafetyPlan; created_at: Date; session_id: string | null }>(
    'SELECT plan, created_at, session_id FROM safety_plans WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1',
    [userId]
  );
  return result.rows[0] ?? null;
}

export interface ThoughtRecordEntry {
  situation?: string;
  thought?: string;
  feeling?: string;
  evidence_for?: string;
  evidence_against?: string;
  balanced_thought?: string;
}

/** The participant's most recently completed thought record (any of their sessions). */
export async function getUserLatestThoughtRecord(
  userId: number
): Promise<{ record: ThoughtRecordEntry; created_at: Date } | null> {
  const result = await pool.query<{ metadata: ThoughtRecordEntry; created_at: Date }>(
    `SELECT m.metadata, m.created_at
     FROM messages m
     JOIN therapy_sessions ts ON ts.session_id = m.session_id
     WHERE ts.user_id = $1 AND m.message_type = 'thought_record'
     ORDER BY m.created_at DESC
     LIMIT 1`,
    [userId]
  );
  const row = result.rows[0];
  return row ? { record: row.metadata ?? {}, created_at: row.created_at } : null;
}
