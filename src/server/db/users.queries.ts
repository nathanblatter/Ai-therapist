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
