// Data-access for the express-session store table (user_sessions).
import { pool } from '../config/db.js';

export interface UserSessionRow {
  sid: string;
  sess: unknown;
  expire: Date;
}

/** All persisted sessions, newest expiry first. */
export async function getActiveUserSessions(): Promise<UserSessionRow[]> {
  const result = await pool.query<UserSessionRow>(
    'SELECT sid, sess, expire FROM user_sessions ORDER BY expire DESC'
  );
  return result.rows;
}

/** Delete a session by id; returns the deleted sid, or null if none matched. */
export async function deleteUserSession(sid: string): Promise<string | null> {
  const result = await pool.query<{ sid: string }>(
    'DELETE FROM user_sessions WHERE sid = $1 RETURNING sid',
    [sid]
  );
  return result.rows[0]?.sid ?? null;
}
