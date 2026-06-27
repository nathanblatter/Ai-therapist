// Data-access for user-owned preferences (voice + language).
import { pool } from '../config/db.js';

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
