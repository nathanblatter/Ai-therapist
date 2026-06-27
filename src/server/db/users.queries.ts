// Data-access for users: their stored row shape, auth/CRUD (with password
// hashing), and voice/language preferences.
import bcrypt from 'bcrypt';
import { pool } from '../config/db.js';

const SALT_ROUNDS = 10;

export interface UserRow {
  userid: number;
  username: string;
  role: string;
  password?: string;
  preferred_voice?: string | null;
  preferred_language?: string | null;
  mfa_enabled?: boolean;
  mfa_secret?: string | null;
  mfa_backup_codes?: string[] | null;
  mfa_enabled_at?: Date | null;
  created_at?: Date;
  updated_at?: Date;
}

export interface UserPreferencesRow {
  preferred_voice: string | null;
  preferred_language: string | null;
}

/** Read a user's stored voice/language preferences, or null if the user has none. */
export async function getUserPreferences(userId: number | string): Promise<UserPreferencesRow | null> {
  const result = await pool.query<UserPreferencesRow>(
    'SELECT preferred_voice, preferred_language FROM users WHERE userid = $1',
    [userId]
  );
  return result.rows[0] ?? null;
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
}

/** Verify a username/password; returns the user (sans password) or null. */
export async function verifyCredentials(username: string, password: string): Promise<VerifiedUser | null> {
  try {
    const result = await pool.query<UserRow & { password: string }>(
      'SELECT userid, username, password, role, mfa_enabled, mfa_secret, mfa_backup_codes FROM users WHERE username = $1',
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
    };
  } catch (error) {
    console.error('Error verifying credentials:', error);
    throw error;
  }
}

/** Create a user with a hashed password (for registration). */
export async function createUser(username: string, password: string, role: string): Promise<UserRow> {
  try {
    const hashedPassword = await bcrypt.hash(password, SALT_ROUNDS);

    const result = await pool.query<UserRow>(
      'INSERT INTO users (username, password, role) VALUES ($1, $2, $3) RETURNING userid, username, role',
      [username, hashedPassword, role]
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

/** All users (admin user-management view), newest first. */
export async function getAllUsers(): Promise<UserRow[]> {
  try {
    const result = await pool.query<UserRow>(
      'SELECT userid, username, role, preferred_voice, preferred_language, mfa_enabled, mfa_enabled_at, created_at, updated_at FROM users ORDER BY created_at DESC'
    );
    return result.rows;
  } catch (error) {
    console.error('Error fetching users:', error);
    throw error;
  }
}

/** A single user by id, or null. */
export async function getUserById(userid: number | string): Promise<UserRow | null> {
  try {
    const result = await pool.query<UserRow>(
      'SELECT userid, username, role, preferred_voice, preferred_language, created_at, updated_at FROM users WHERE userid = $1 ORDER BY userid asc',
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
