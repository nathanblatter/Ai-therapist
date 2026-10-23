// Data-access for the express-session store table (user_sessions).
//
// Organization scoping (ai-therapist-272): `sess` is the express-session JSON
// (jsonb), so the owning user is `sess->>'userId'`; both reads below join it
// to users and keep only rows in the caller's organization. A session with
// no userId (anonymous participant, or a pre-login browser) has no owner org
// and is IRB-study custody: visible only when the caller's org is the
// irb-study org. A userId whose user row is gone matches no org (fail closed).
import { pool } from '../config/db.js';
import { IRB_STUDY_ORG_ID_SQL } from './organizations.queries.js';

export interface UserSessionRow {
  sid: string;
  sess: unknown;
  expire: Date;
}

/** Org-scope predicate over `user_sessions s` joined to `users u`; $N = caller org. */
function orgScopeSql(orgParam: string): string {
  return `(u.organization_id = ${orgParam}
      OR (s.sess->>'userId' IS NULL AND ${orgParam} = ${IRB_STUDY_ORG_ID_SQL}))`;
}

/** Join to the session's owner; non-numeric userId values match no user. */
const OWNER_JOIN = `LEFT JOIN users u
    ON s.sess->>'userId' ~ '^[0-9]+$' AND u.userid = (s.sess->>'userId')::int`;

/** Persisted sessions in the caller's organization, newest expiry first. */
export async function getActiveUserSessions(orgId: number): Promise<UserSessionRow[]> {
  const result = await pool.query<UserSessionRow>(
    `SELECT s.sid, s.sess, s.expire
     FROM user_sessions s
     ${OWNER_JOIN}
     WHERE ${orgScopeSql('$1')}
     ORDER BY s.expire DESC`,
    [orgId]
  );
  return result.rows;
}

/**
 * Delete a session by id when it is in the caller's organization; returns
 * the deleted sid, or null if none matched (missing OR out of scope — the
 * caller reports both as 404).
 */
export async function deleteUserSession(sid: string, orgId: number): Promise<string | null> {
  const result = await pool.query<{ sid: string }>(
    `DELETE FROM user_sessions
     WHERE sid = $1
       AND sid IN (
         SELECT s.sid FROM user_sessions s
         ${OWNER_JOIN}
         WHERE s.sid = $1 AND ${orgScopeSql('$2')}
       )
     RETURNING sid`,
    [sid, orgId]
  );
  return result.rows[0]?.sid ?? null;
}
