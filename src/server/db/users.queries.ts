// Data-access for users: their stored row shape, auth/CRUD (with password
// hashing), and voice/language preferences.
import bcrypt from 'bcrypt';
import { randomBytes } from 'crypto';
import { pool } from '../config/db.js';

const SALT_ROUNDS = 10;

export interface UserRow {
  userid: number;
  username: string;
  role: string;
  organization_id?: number;
  is_sandbox?: boolean;
  password?: string;
  preferred_voice?: string | null;
  preferred_language?: string | null;
  mfa_enabled?: boolean;
  mfa_secret?: string | null;
  mfa_backup_codes?: string[] | null;
  mfa_enabled_at?: Date | null;
  risk_context_share_enabled?: boolean;
  memory_enabled?: boolean;
  study_status?: 'active' | 'paused' | 'withdrawn';
  created_at?: Date;
  updated_at?: Date;
}

export interface UserPreferencesRow {
  preferred_voice: string | null;
  preferred_language: string | null;
  preferred_theme: string | null;
}

/** Read a user's stored voice/language/theme preferences, or null if the user has none. */
export async function getUserPreferences(userId: number | string): Promise<UserPreferencesRow | null> {
  const result = await pool.query<UserPreferencesRow>(
    'SELECT preferred_voice, preferred_language, preferred_theme FROM users WHERE userid = $1',
    [userId]
  );
  return result.rows[0] ?? null;
}

/** Persist just the UI theme preference. */
export async function setUserPreferredTheme(userId: number | string, theme: string): Promise<void> {
  await pool.query(
    'UPDATE users SET preferred_theme = $1 WHERE userid = $2',
    [theme, userId]
  );
}

/** Persist a user's voice/language preferences. */
export async function updateUserPreferences(
  userId: number | string,
  voice: string,
  language: string
): Promise<void> {
  await pool.query(
    'UPDATE users SET preferred_voice = $1, preferred_language = $2 WHERE userid = $3',
    [voice, language, userId]
  );
}

/** A user's stored language preference (null if user/row absent or unset). */
export async function getUserPreferredLanguage(userId: number | string): Promise<string | null> {
  const result = await pool.query<{ preferred_language: string | null }>(
    'SELECT preferred_language FROM users WHERE userid = $1',
    [userId]
  );
  if (result.rows.length === 0) return null;
  return result.rows[0].preferred_language;
}

/** Persist just the language preference (used by the chat-start flow). */
export async function setUserPreferredLanguage(userId: number | string, language: string): Promise<void> {
  await pool.query(
    'UPDATE users SET preferred_language = $1 WHERE userid = $2',
    [language, userId]
  );
}

export interface VerifiedUser {
  userid: number;
  username: string;
  role: string;
  mfa_enabled: boolean;
  mfa_secret: string | null;
  mfa_backup_codes: string[] | null;
  organization_id: number | null;
  is_sandbox: boolean;
}

/** Verify a username/password; returns the user (sans password) or null. */
export async function verifyCredentials(username: string, password: string): Promise<VerifiedUser | null> {
  try {
    const result = await pool.query<UserRow & { password: string }>(
      'SELECT userid, username, password, role, mfa_enabled, mfa_secret, mfa_backup_codes, organization_id, is_sandbox FROM users WHERE username = $1',
      [username]
    );

    if (result.rows.length === 0) {
      return null; // User not found
    }

    const user = result.rows[0];
    const passwordMatch = await bcrypt.compare(password, user.password);

    if (!passwordMatch) {
      return null; // Invalid password
    }

    return {
      userid: user.userid,
      username: user.username,
      role: user.role,
      mfa_enabled: user.mfa_enabled ?? false,
      mfa_secret: user.mfa_secret ?? null,
      mfa_backup_codes: user.mfa_backup_codes ?? null,
      organization_id: user.organization_id ?? null,
      is_sandbox: user.is_sandbox ?? false,
    };
  } catch (error) {
    console.error('Error verifying credentials:', error);
    throw error;
  }
}

/**
 * Provision a fresh, single-use demo account for a magic-link visitor. Each
 * visitor gets their own row so daily-session limits are per-visitor, not
 * shared. The password is a throwaway random value — demo accounts are only
 * ever reached via the signed magic link, never by username/password login.
 */
export async function createDemoUser(): Promise<{ userid: number; username: string; role: string }> {
  const suffix = randomBytes(4).toString('hex');
  const username = `demo_${suffix}`;
  const throwawayPassword = randomBytes(24).toString('hex');
  const hashedPassword = await bcrypt.hash(throwawayPassword, SALT_ROUNDS);

  const result = await pool.query<UserRow>(
    `INSERT INTO users (username, password, role, organization_id)
     VALUES ($1, $2, 'demo',
             (SELECT org_id FROM organizations WHERE slug = 'irb-study'))
     RETURNING userid, username, role`,
    [username, hashedPassword]
  );
  return result.rows[0];
}

/** Thrown by createUser when a caseworker account would land in a research
 *  organization (IRB invariant: the study has no caseworker role; caseworker
 *  accounts exist only in clinical/practice and sandbox orgs). */
export class ResearchOrgCaseworkerError extends Error {
  constructor(message = 'Caseworker accounts cannot be created in a research organization') {
    super(message);
    this.name = 'ResearchOrgCaseworkerError';
  }
}

export interface CreateUserOptions {
  /** Organization the account belongs to; defaults to the irb-study org
   *  (069 backfill semantics — pre-portal behavior is unchanged). */
  orgId?: number | null;
  /** Denormalized organizations.kind='sandbox' flag; set at creation, never
   *  toggled (077). */
  isSandbox?: boolean;
}

/** Create a user with a hashed password (for registration). */
export async function createUser(
  username: string,
  password: string,
  role: string,
  options: CreateUserOptions = {}
): Promise<UserRow> {
  // IRB invariant (fail closed): never mint a caseworker inside a research
  // org. The org is resolved exactly as the INSERT below resolves it, so the
  // check and the write cannot disagree; an unresolvable org also rejects.
  if (role === 'caseworker') {
    const orgKind = await pool.query<{ kind: string }>(
      `SELECT kind FROM organizations
       WHERE org_id = COALESCE($1, (SELECT org_id FROM organizations WHERE slug = 'irb-study'))`,
      [options.orgId ?? null]
    );
    const kind = orgKind.rows[0]?.kind;
    if (kind === undefined || kind === 'research') {
      throw new ResearchOrgCaseworkerError();
    }
  }

  try {
    const hashedPassword = await bcrypt.hash(password, SALT_ROUNDS);

    const result = await pool.query<UserRow>(
      `INSERT INTO users (username, password, role, organization_id, is_sandbox)
       VALUES ($1, $2, $3,
               COALESCE($4, (SELECT org_id FROM organizations WHERE slug = 'irb-study')),
               $5)
       RETURNING userid, username, role, organization_id, is_sandbox`,
      [username, hashedPassword, role, options.orgId ?? null, options.isSandbox ?? false]
    );

    return result.rows[0];
  } catch (error: unknown) {
    const pgErr = error as { code?: string };
    if (pgErr.code === '23505') { // Unique constraint violation
      throw new Error('Username already exists');
    }
    console.error('Error creating user:', error);
    throw error;
  }
}

/** All users (admin user-management view), newest first.
 *  scopeTherapistId (caseload RBAC, ai-therapist-119): when set, return only
 *  participants in that member's caseload plus the caller's own row (the
 *  scope IS the member's userid, matched via tc.therapist_id = scope);
 *  null/undefined = caseload-unscoped (researchers), today's SQL exactly.
 *  orgId (caseworker portal C13): when set, additionally restrict to that
 *  organization — at cutover every user is in irb-study, so researcher
 *  results are byte-identical. */
export async function getAllUsers(
  scopeTherapistId?: number | null,
  orgId?: number | null
): Promise<UserRow[]> {
  try {
    const scoped = scopeTherapistId !== null && scopeTherapistId !== undefined;
    const orgScoped = orgId !== null && orgId !== undefined;
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (scoped) {
      params.push(scopeTherapistId);
      clauses.push(
        `(userid = $${params.length} OR EXISTS (SELECT 1 FROM therapist_clients tc WHERE tc.therapist_id = $${params.length} AND tc.client_id = userid))`
      );
    }
    if (orgScoped) {
      params.push(orgId);
      clauses.push(`organization_id = $${params.length}`);
    }
    const scopeClause = clauses.length > 0 ? ` WHERE ${clauses.join(' AND ')}` : '';
    const result = await pool.query<UserRow>(
      `SELECT userid, username, role, preferred_voice, preferred_language, mfa_enabled, mfa_enabled_at, risk_context_share_enabled, memory_enabled, created_at, updated_at FROM users${scopeClause} ORDER BY created_at DESC`,
      params
    );
    return result.rows;
  } catch (error) {
    console.error('Error fetching users:', error);
    throw error;
  }
}

/** All therapist account ids in an organization. Backs the emergency
 *  escalation fan-out (docs/caseworker-portal.md 072: urgency='emergency'
 *  with no assignee notifies all org therapists). */
export async function getOrgTherapistIds(orgId: number): Promise<number[]> {
  const result = await pool.query<{ userid: number }>(
    `SELECT userid FROM users
     WHERE role = 'therapist' AND organization_id = $1
     ORDER BY userid`,
    [orgId]
  );
  return result.rows.map((row) => row.userid);
}

/** All researcher account ids (org-unscoped, like the researcher
 *  'admin-broadcast' socket room). Backs the participant_withdrawal
 *  work-item fan-out: research participants typically have no assignee and
 *  no care team, so without a study-team recipient set nobody is told a
 *  participant withdrew. */
export async function getResearcherIds(): Promise<number[]> {
  const result = await pool.query<{ userid: number }>(
    `SELECT userid FROM users
     WHERE role = 'researcher'
     ORDER BY userid`
  );
  return result.rows.map((row) => row.userid);
}

/** Denormalized users.is_sandbox for one account (false when absent). */
export async function isSandboxAccount(userId: number): Promise<boolean> {
  const result = await pool.query<{ is_sandbox: boolean }>(
    'SELECT is_sandbox FROM users WHERE userid = $1',
    [userId]
  );
  return result.rows[0]?.is_sandbox ?? false;
}

/**
 * Is a therapy session owned by a sandbox account? Anonymous sessions are
 * never sandbox. Hot-path guard for crisis paging / AE-draft / email
 * suppression (docs/caseworker-portal.md section 7).
 */
export async function isSandboxAccountSession(sessionId: string): Promise<boolean> {
  const result = await pool.query<{ is_sandbox: boolean }>(
    `SELECT u.is_sandbox
     FROM therapy_sessions ts
     JOIN users u ON u.userid = ts.user_id
     WHERE ts.session_id = $1`,
    [sessionId]
  );
  return result.rows[0]?.is_sandbox ?? false;
}

/** A single user by id, or null. */
export async function getUserById(userid: number | string): Promise<UserRow | null> {
  try {
    const result = await pool.query<UserRow>(
      'SELECT userid, username, role, organization_id, is_sandbox, preferred_voice, preferred_language, mfa_enabled, risk_context_share_enabled, memory_enabled, study_status, created_at, updated_at FROM users WHERE userid = $1 ORDER BY userid asc',
      [userid]
    );

    if (result.rows.length === 0) {
      return null;
    }

    return result.rows[0];
  } catch (error) {
    console.error('Error fetching user:', error);
    throw error;
  }
}

/** Update a user's username/role/password (password is re-hashed). */
export async function updateUser(userid: number | string, updates: Record<string, string>): Promise<UserRow> {
  try {
    const allowedFields = ['username', 'role', 'password'];
    const updateFields: string[] = [];
    const values: unknown[] = [];
    let paramIndex = 1;

    for (const [key, value] of Object.entries(updates)) {
      if (allowedFields.includes(key) && value !== undefined) {
        if (key === 'password') {
          const hashedPassword = await bcrypt.hash(value, SALT_ROUNDS);
          updateFields.push(`password = $${paramIndex}`);
          values.push(hashedPassword);
        } else {
          updateFields.push(`${key} = $${paramIndex}`);
          values.push(value);
        }
        paramIndex++;
      }
    }

    if (updateFields.length === 0) {
      throw new Error('No valid fields to update');
    }

    updateFields.push(`updated_at = CURRENT_TIMESTAMP`);
    values.push(userid);

    const query = `
      UPDATE users
      SET ${updateFields.join(', ')}
      WHERE userid = $${paramIndex}
      RETURNING userid, username, role, created_at, updated_at
    `;

    const result = await pool.query<UserRow>(query, values);

    if (result.rows.length === 0) {
      throw new Error('User not found');
    }

    return result.rows[0];
  } catch (error: unknown) {
    const pgErr = error as { code?: string };
    if (pgErr.code === '23505') { // Unique constraint violation
      throw new Error('Username already exists');
    }
    console.error('Error updating user:', error);
    throw error;
  }
}

/** Delete a user by id; returns the deleted row. */
export async function deleteUser(userid: number | string): Promise<UserRow> {
  try {
    const result = await pool.query<UserRow>(
      'DELETE FROM users WHERE userid = $1 RETURNING userid, username',
      [userid]
    );

    if (result.rows.length === 0) {
      throw new Error('User not found');
    }

    return result.rows[0];
  } catch (error) {
    console.error('Error deleting user:', error);
    throw error;
  }
}
