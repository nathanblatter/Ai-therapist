// The AI-model system setting. The aggregate-stats queries that used to live
// here (session/message/language/voice counts) were the superseded original of
// the analytics dashboard; the live query is analytics.queries.ts. Deleted
// 2026-10-22 (ai-therapist-210) so the next audit does not re-find them.
import { pool } from '../config/db.js';
import type { SystemConfigRow } from './config.queries.js';

/** The configured AI model, defaulting to 'gpt-live-1'. */
export async function getAiModel(): Promise<string> {
  try {
    const result = await pool.query<Pick<SystemConfigRow, 'config_value'>>(
      `SELECT config_value FROM system_config WHERE config_key = 'ai_model'`,
    );

    if (result.rows.length > 0) {
      const config = result.rows[0].config_value as { model?: string } | null;
      return config?.model || 'gpt-live-1';
    }

    return 'gpt-live-1';
  } catch (error) {
    console.error('Failed to fetch AI model config:', error);
    return 'gpt-live-1';
  }
}
