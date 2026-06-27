// Data-access for aggregate statistics and the AI-model system setting. (The
// rich analytics dashboard query lives separately in analytics.queries.ts.)
import { pool } from '../config/db.js';

export interface SessionStatsRow {
  total_sessions: string;
  authenticated_sessions: string;
  active_sessions: string;
  ended_sessions: string;
  avg_duration_minutes: string | null;
}

export interface MessageStatsRow {
  total_messages: string;
  user_messages: string;
  assistant_messages: string;
  sessions_with_messages: string;
}

export interface LanguageStatRow {
  language: string;
  session_count: string;
  percentage: string;
}

export interface VoiceStatRow {
  voice: string;
  session_count: string;
  percentage: string;
}

interface SystemConfigRow {
  config_value: Record<string, unknown> & { model?: string };
}

/** Session counts + average duration across all sessions. */
export async function getSessionStats(): Promise<SessionStatsRow> {
  const result = await pool.query<SessionStatsRow>(
    `SELECT
      COUNT(DISTINCT session_id) as total_sessions,
      COUNT(DISTINCT user_id) FILTER (WHERE user_id IS NOT NULL) as authenticated_sessions,
      COUNT(*) FILTER (WHERE status = 'active') as active_sessions,
      COUNT(*) FILTER (WHERE status = 'ended') as ended_sessions,
      AVG(EXTRACT(EPOCH FROM (ended_at - created_at))/60) FILTER (WHERE ended_at IS NOT NULL) as avg_duration_minutes
     FROM therapy_sessions`
  );
  return result.rows[0];
}

/** Message counts by role and sessions-with-messages. */
export async function getMessageStats(): Promise<MessageStatsRow> {
  const result = await pool.query<MessageStatsRow>(
    `SELECT
      COUNT(*) as total_messages,
      COUNT(*) FILTER (WHERE role = 'user') as user_messages,
      COUNT(*) FILTER (WHERE role = 'assistant') as assistant_messages,
      COUNT(DISTINCT session_id) as sessions_with_messages
     FROM messages`
  );
  return result.rows[0];
}

/** Language usage across sessions, with percentages. */
export async function getLanguageStats(): Promise<LanguageStatRow[]> {
  const result = await pool.query<LanguageStatRow>(
    `SELECT
      sc.language,
      COUNT(*) as session_count,
      ROUND(COUNT(*) * 100.0 / SUM(COUNT(*)) OVER (), 2) as percentage
     FROM session_configurations sc
     JOIN therapy_sessions ts ON sc.session_id = ts.session_id
     WHERE sc.language IS NOT NULL
     GROUP BY sc.language
     ORDER BY session_count DESC`
  );
  return result.rows;
}

/** Voice usage across sessions, with percentages. */
export async function getVoiceStats(): Promise<VoiceStatRow[]> {
  const result = await pool.query<VoiceStatRow>(
    `SELECT
      sc.voice,
      COUNT(*) as session_count,
      ROUND(COUNT(*) * 100.0 / SUM(COUNT(*)) OVER (), 2) as percentage
     FROM session_configurations sc
     JOIN therapy_sessions ts ON sc.session_id = ts.session_id
     WHERE sc.voice IS NOT NULL
     GROUP BY sc.voice
     ORDER BY session_count DESC`
  );
  return result.rows;
}

/** Combined language + voice configuration statistics. */
export async function getConfigStats(): Promise<{ languages: LanguageStatRow[]; voices: VoiceStatRow[] }> {
  const languageStats = await getLanguageStats();
  const voiceStats = await getVoiceStats();
  return { languages: languageStats, voices: voiceStats };
}

/** The configured AI model, defaulting to 'gpt-realtime-mini'. */
export async function getAiModel(): Promise<string> {
  try {
    const result = await pool.query<SystemConfigRow>(
      `SELECT config_value FROM system_config WHERE config_key = 'ai_model'`
    );

    if (result.rows.length > 0) {
      const config = result.rows[0].config_value;
      return config.model || 'gpt-realtime-mini';
    }

    return 'gpt-realtime-mini';
  } catch (error) {
    console.error('Failed to fetch AI model config:', error);
    return 'gpt-realtime-mini';
  }
}
