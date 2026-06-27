// Data-access for session rate-limit views (per-user status + admin roster).
import { pool } from '../config/db.js';

export interface SessionsTodayRow {
  session_count: string;
  last_session_at: Date | null;
}

/** How many sessions one user has started since `todayStart`, and the latest. */
export async function getSessionsToday(userId: unknown, todayStart: Date): Promise<SessionsTodayRow> {
  const result = await pool.query<SessionsTodayRow>(`
    SELECT COUNT(*) as session_count, MAX(created_at) as last_session_at
    FROM therapy_sessions
    WHERE user_id = $1 AND created_at >= $2
  `, [userId, todayStart]);
  return result.rows[0];
}

export interface RateLimitedUserRow {
  userid: number;
  username: string;
  role: string;
  sessions_today: string;
  last_session_at: Date | null;
}

/** Participants who have hit or exceeded `maxSessionsPerDay` since `todayStart`. */
export async function getRateLimitedParticipants(
  todayStart: Date,
  maxSessionsPerDay: number
): Promise<RateLimitedUserRow[]> {
  const result = await pool.query<RateLimitedUserRow>(`
    SELECT
      u.userid,
      u.username,
      u.role,
      COUNT(ts.session_id) AS sessions_today,
      MAX(ts.created_at) AS last_session_at
    FROM users u
    LEFT JOIN therapy_sessions ts ON u.userid = ts.user_id
      AND ts.created_at >= $1
    WHERE u.role = 'participant'
    GROUP BY u.userid, u.username, u.role
    HAVING COUNT(ts.session_id) >= $2
    ORDER BY last_session_at DESC
  `, [todayStart, maxSessionsPerDay]);
  return result.rows;
}
