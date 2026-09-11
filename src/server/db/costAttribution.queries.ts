// Product-level cost attribution (ai-therapist-181 dashboard).
//
// OpenAI's costs API is authoritative for DOLLARS but only knows models, not
// what we used them for — and several of our subsystems share a model
// (crisis/insights/rerank all run gpt-4o-mini; chat and the admin assistant
// both run gpt-5.2). These queries supply the missing half: how many tokens
// each PURPOSE burned on each model, so the dashboard can apportion a model's
// real dollars across the product functions that spent them.
//
// The apportionment is an ESTIMATE and the UI must say so. It is honest about
// its own blind spot: redaction currently records calls with NULL token counts
// (see redaction.service.ts), so its share is inferred from call count rather
// than tokens until that is fixed.
import { pool } from '../config/db.js';

export interface PurposeUsageRow {
  purpose: string;
  model: string | null;
  calls: number;
  tokensIn: number;
  tokensOut: number;
  /** True when every row for this purpose/model had NULL token counts. */
  tokensMissing: boolean;
}

/** Token + call usage grouped by purpose and model over the window. */
export async function getUsageByPurpose(days: number): Promise<PurposeUsageRow[]> {
  const result = await pool.query(
    `SELECT purpose,
            model,
            COUNT(*)::int                       AS calls,
            COALESCE(SUM(tokens_in), 0)::int    AS tokens_in,
            COALESCE(SUM(tokens_out), 0)::int   AS tokens_out,
            BOOL_AND(tokens_in IS NULL)         AS tokens_missing
     FROM session_llm_usage
     WHERE created_at >= NOW() - make_interval(days => $1)
     GROUP BY purpose, model
     ORDER BY calls DESC`,
    [days]
  );
  return result.rows.map(r => ({
    purpose: r.purpose,
    model: r.model,
    calls: r.calls,
    tokensIn: r.tokens_in,
    tokensOut: r.tokens_out,
    tokensMissing: r.tokens_missing === true,
  }));
}

export interface RealtimeUsageTotals {
  responses: number;
  inputTokens: number;
  outputTokens: number;
  inputAudioTokens: number;
  outputAudioTokens: number;
  cachedTokens: number;
}

/** Realtime (voice) token totals over the window. */
export async function getRealtimeUsageTotals(days: number): Promise<RealtimeUsageTotals> {
  const result = await pool.query(
    `SELECT COUNT(*)::int                              AS responses,
            COALESCE(SUM(input_tokens), 0)::int        AS input_tokens,
            COALESCE(SUM(output_tokens), 0)::int       AS output_tokens,
            COALESCE(SUM(input_audio_tokens), 0)::int  AS input_audio_tokens,
            COALESCE(SUM(output_audio_tokens), 0)::int AS output_audio_tokens,
            COALESCE(SUM(cached_tokens), 0)::int       AS cached_tokens
     FROM realtime_usage
     WHERE created_at >= NOW() - make_interval(days => $1)`,
    [days]
  );
  const r = result.rows[0] ?? {};
  return {
    responses: r.responses ?? 0,
    inputTokens: r.input_tokens ?? 0,
    outputTokens: r.output_tokens ?? 0,
    inputAudioTokens: r.input_audio_tokens ?? 0,
    outputAudioTokens: r.output_audio_tokens ?? 0,
    cachedTokens: r.cached_tokens ?? 0,
  };
}

export interface SessionVolume {
  sessions: number;
  endedSessions: number;
  realtimeSessions: number;
  chatSessions: number;
  activeDays: number;
  /** Distinct participants with at least one session in the window. */
  participants: number;
}

/** Session volume over the window — the denominator for unit economics. */
export async function getSessionVolume(days: number): Promise<SessionVolume> {
  const result = await pool.query(
    `SELECT COUNT(*)::int                                                       AS sessions,
            COUNT(*) FILTER (WHERE status = 'ended')::int                       AS ended_sessions,
            COUNT(*) FILTER (WHERE session_type = 'realtime')::int              AS realtime_sessions,
            COUNT(*) FILTER (WHERE session_type = 'chat')::int                  AS chat_sessions,
            COUNT(DISTINCT DATE(created_at))::int                               AS active_days,
            COUNT(DISTINCT user_id) FILTER (WHERE user_id IS NOT NULL)::int     AS participants
     FROM therapy_sessions
     WHERE created_at >= NOW() - make_interval(days => $1)`,
    [days]
  );
  const r = result.rows[0] ?? {};
  return {
    sessions: r.sessions ?? 0,
    endedSessions: r.ended_sessions ?? 0,
    realtimeSessions: r.realtime_sessions ?? 0,
    chatSessions: r.chat_sessions ?? 0,
    activeDays: r.active_days ?? 0,
    participants: r.participants ?? 0,
  };
}
