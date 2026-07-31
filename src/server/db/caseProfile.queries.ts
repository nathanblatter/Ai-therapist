// Rolling per-user clinical case profile (ai-therapist-47). One row per user,
// UPDATED (merged, not appended) after each ended session by
// services/sessionInsights.service.ts. Consumed by utils/promptContext.ts.
import { pool } from '../config/db.js';

export interface CopingEntry {
  technique: string;
  helpfulness: 'helped' | 'mixed' | 'did_not_help';
}

export interface CaseProfile {
  presenting_concerns?: string[];
  recurring_themes?: string[];
  stressors?: string[];
  support_system?: string[];
  /** Ranked with what actually helped first. */
  coping_repertoire?: CopingEntry[];
  values?: string[];
  screener_trend?: string;
}

export interface UserCaseProfileRow {
  user_id: number;
  profile: CaseProfile;
  updated_at: Date;
}

export async function getUserCaseProfile(userId: number): Promise<UserCaseProfileRow | null> {
  const result = await pool.query<UserCaseProfileRow>(
    'SELECT user_id, profile, updated_at FROM user_case_profiles WHERE user_id = $1',
    [userId]
  );
  return result.rows[0] ?? null;
}

/** Overwrites with the full merged profile the insights model produced. */
export async function upsertUserCaseProfile(userId: number, profile: CaseProfile): Promise<void> {
  await pool.query(
    `INSERT INTO user_case_profiles (user_id, profile, updated_at)
     VALUES ($1, $2, CURRENT_TIMESTAMP)
     ON CONFLICT (user_id) DO UPDATE
       SET profile = EXCLUDED.profile, updated_at = CURRENT_TIMESTAMP`,
    [userId, JSON.stringify(profile)]
  );
}
