// Per-session cost/token tracking (ai-therapist-25c). Non-realtime LLM calls
// (insights generation, redaction, crisis risk assessment, chat) log a row in
// session_llm_usage. Realtime voice is token-metered too (telemetry pass 3,
// migration 058): the sideband records response.usage from every response.done
// into realtime_usage, priced with the gpt-realtime rates below; the old
// wall-clock realtime-minutes figure is kept only as a legacy reference.
// Logging is fire-and-forget from the calling service — a failure here must
// never break the underlying feature.
import { pool } from '../config/db.js';

export type LlmUsagePurpose = 'insights' | 'redaction' | 'crisis' | 'eligibility' | 'rerank' | 'chat';

// Rough, hand-maintained $/1M-token rates for the models this app calls
// LLMs with for insights/redaction/crisis (all OpenAI as of writing). This is
// an ESTIMATE for relative cost tracking, not a billing-accurate figure —
// actual OpenAI invoices are the source of truth.
const TOKEN_RATES_PER_MILLION: Record<string, { input: number; output: number }> = {
  'gpt-4o-mini': { input: 0.15, output: 0.6 },
  'gpt-4o': { input: 2.5, output: 10 },
  'gpt-5-mini': { input: 0.25, output: 2 },
  'gpt-5': { input: 1.25, output: 10 },
  'gpt-5.2': { input: 1.25, output: 10 }, // chat pipeline (ai-therapist-118); estimate mirrors gpt-5
};
const DEFAULT_RATE = { input: 0.5, output: 1.5 }; // fallback for unlisted models

// gpt-realtime $/1M-token rates (OpenAI published pricing as of 2026-08).
// Realtime bills text and audio tokens at different rates, with a flat
// discount for cached input (audio + text). Hand-maintained ESTIMATE — edit
// these numbers here if OpenAI's pricing changes; invoices are the source of
// truth.
export const REALTIME_RATES_PER_MILLION = {
  text_in: 4,
  text_out: 16,
  audio_in: 32,
  audio_out: 64,
  cached_in: 0.4, // cached input (audio + text)
};

/** Token counts for one realtime response (from response.done -> response.usage). */
export interface RealtimeUsageTokens {
  inputTokens: number | null;
  outputTokens: number | null;
  inputAudioTokens: number | null;
  outputAudioTokens: number | null;
  cachedTokens: number | null;
}

/** Price one realtime response (or an aggregate of them) in USD. */
export function estimateRealtimeCostUsd(u: RealtimeUsageTokens): number {
  const input = u.inputTokens ?? 0;
  const output = u.outputTokens ?? 0;
  const audioIn = u.inputAudioTokens ?? 0;
  const audioOut = u.outputAudioTokens ?? 0;
  const cached = u.cachedTokens ?? 0;
  // input_tokens/output_tokens are grand totals; the audio counts are subsets.
  // Cached tokens get the flat cached rate; we conservatively subtract them
  // from the TEXT bucket (cached audio would make this a slight overestimate).
  const textIn = Math.max(0, input - audioIn - cached);
  const textOut = Math.max(0, output - audioOut);
  const cost =
    (textIn / 1_000_000) * REALTIME_RATES_PER_MILLION.text_in +
    (audioIn / 1_000_000) * REALTIME_RATES_PER_MILLION.audio_in +
    (cached / 1_000_000) * REALTIME_RATES_PER_MILLION.cached_in +
    (textOut / 1_000_000) * REALTIME_RATES_PER_MILLION.text_out +
    (audioOut / 1_000_000) * REALTIME_RATES_PER_MILLION.audio_out;
  return Math.round(cost * 1_000_000) / 1_000_000;
}

/** Log one realtime response's token usage. Best-effort: swallows its own
 *  errors so a metering failure can never affect a live voice session. */
export async function insertRealtimeUsage(
  sessionId: string,
  responseId: string | null,
  tokens: RealtimeUsageTokens
): Promise<void> {
  try {
    await pool.query(
      `INSERT INTO realtime_usage
         (session_id, response_id, input_tokens, output_tokens, input_audio_tokens, output_audio_tokens, cached_tokens)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        sessionId, responseId,
        tokens.inputTokens, tokens.outputTokens,
        tokens.inputAudioTokens, tokens.outputAudioTokens,
        tokens.cachedTokens,
      ]
    );
  } catch (err) {
    console.error('[costTracking] Failed to record realtime usage (non-fatal):', err);
  }
}

export function estimateCostUsd(model: string | null, tokensIn: number | null, tokensOut: number | null): number {
  const rate = (model && TOKEN_RATES_PER_MILLION[model]) || DEFAULT_RATE;
  const inCost = ((tokensIn ?? 0) / 1_000_000) * rate.input;
  const outCost = ((tokensOut ?? 0) / 1_000_000) * rate.output;
  return Math.round((inCost + outCost) * 1_000_000) / 1_000_000;
}

/** Log one LLM call against a session. Best-effort: swallows its own errors
 *  so a logging failure can never break insights/redaction/crisis flows. */
export async function recordLlmUsage(
  sessionId: string | null,
  purpose: LlmUsagePurpose,
  model: string | null,
  tokensIn: number | null,
  tokensOut: number | null
): Promise<void> {
  try {
    await pool.query(
      `INSERT INTO session_llm_usage (session_id, purpose, model, tokens_in, tokens_out)
       VALUES ($1, $2, $3, $4, $5)`,
      [sessionId, purpose, model, tokensIn, tokensOut]
    );
  } catch (err) {
    console.error('[costTracking] Failed to record LLM usage (non-fatal):', err);
  }
}

export interface SessionCostSummary {
  session_id: string;
  realtime_minutes: number | null;
  calls_by_purpose: Record<LlmUsagePurpose, number>;
  tokens_in: number;
  tokens_out: number;
  estimated_cost_usd: number;
  realtime_responses: number;
  realtime_cost_usd: number;
}

/** Per-session cost/usage rollup for the admin Session Detail panel. */
export async function getSessionCostSummary(sessionId: string): Promise<SessionCostSummary> {
  const [durationResult, usageResult, realtimeResult] = await Promise.all([
    pool.query<{ minutes: number | null }>(
      `SELECT EXTRACT(EPOCH FROM (COALESCE(ended_at, CURRENT_TIMESTAMP) - created_at)) / 60 AS minutes
       FROM therapy_sessions WHERE session_id = $1`,
      [sessionId]
    ),
    pool.query<{ purpose: LlmUsagePurpose; model: string | null; tokens_in: number | null; tokens_out: number | null }>(
      'SELECT purpose, model, tokens_in, tokens_out FROM session_llm_usage WHERE session_id = $1',
      [sessionId]
    ),
    pool.query<{
      responses: string; input_tokens: string; output_tokens: string;
      input_audio_tokens: string; output_audio_tokens: string; cached_tokens: string;
    }>(
      `SELECT COUNT(*) AS responses,
              COALESCE(SUM(input_tokens), 0) AS input_tokens,
              COALESCE(SUM(output_tokens), 0) AS output_tokens,
              COALESCE(SUM(input_audio_tokens), 0) AS input_audio_tokens,
              COALESCE(SUM(output_audio_tokens), 0) AS output_audio_tokens,
              COALESCE(SUM(cached_tokens), 0) AS cached_tokens
       FROM realtime_usage WHERE session_id = $1`,
      [sessionId]
    ),
  ]);

  const callsByPurpose: Record<LlmUsagePurpose, number> = { insights: 0, redaction: 0, crisis: 0, eligibility: 0, rerank: 0, chat: 0 };
  let tokensIn = 0;
  let tokensOut = 0;
  let estimatedCost = 0;
  for (const row of usageResult.rows) {
    callsByPurpose[row.purpose] = (callsByPurpose[row.purpose] ?? 0) + 1;
    tokensIn += row.tokens_in ?? 0;
    tokensOut += row.tokens_out ?? 0;
    estimatedCost += estimateCostUsd(row.model, row.tokens_in, row.tokens_out);
  }

  const rt = realtimeResult.rows[0];
  const realtimeCost = rt
    ? estimateRealtimeCostUsd({
        inputTokens: parseInt(rt.input_tokens, 10),
        outputTokens: parseInt(rt.output_tokens, 10),
        inputAudioTokens: parseInt(rt.input_audio_tokens, 10),
        outputAudioTokens: parseInt(rt.output_audio_tokens, 10),
        cachedTokens: parseInt(rt.cached_tokens, 10),
      })
    : 0;

  const rawMinutes = durationResult.rows[0]?.minutes;
  return {
    session_id: sessionId,
    realtime_minutes: rawMinutes != null ? Math.round(Number(rawMinutes) * 10) / 10 : null,
    calls_by_purpose: callsByPurpose,
    tokens_in: tokensIn,
    tokens_out: tokensOut,
    estimated_cost_usd: Math.round(estimatedCost * 10000) / 10000,
    realtime_responses: rt ? parseInt(rt.responses, 10) : 0,
    realtime_cost_usd: Math.round(realtimeCost * 10000) / 10000,
  };
}

export interface DailySpendRow {
  date: string;
  calls: number;
  tokens_in: number;
  tokens_out: number;
  estimated_cost_usd: number;
  realtime_cost_usd: number;
}

/** Daily estimated LLM spend (non-realtime + metered realtime) for the admin
 *  analytics view. */
export async function getDailySpend(days = 30): Promise<DailySpendRow[]> {
  const safeDays = days;
  const [result, realtimeResult] = await Promise.all([
    pool.query<{
      date: string; purpose: LlmUsagePurpose; model: string | null;
      calls: string; tokens_in: string; tokens_out: string;
    }>(
      // Cast DATE(created_at) to text: pg returns a bare DATE as a JS Date object,
      // which breaks the Map dedup below (Date keys never match) and the string
      // sort at the end (b.date.localeCompare is not a function). Returning the
      // date as an ISO 'YYYY-MM-DD' string fixes both.
      `SELECT DATE(created_at)::text AS date, purpose, model,
              COUNT(*) AS calls,
              COALESCE(SUM(tokens_in), 0) AS tokens_in,
              COALESCE(SUM(tokens_out), 0) AS tokens_out
       FROM session_llm_usage
       WHERE created_at >= CURRENT_DATE - ($1 || ' days')::INTERVAL
       GROUP BY DATE(created_at), purpose, model
       ORDER BY date DESC`,
      [safeDays]
    ),
    pool.query<{
      date: string; input_tokens: string; output_tokens: string;
      input_audio_tokens: string; output_audio_tokens: string; cached_tokens: string;
    }>(
      `SELECT DATE(created_at)::text AS date,
              COALESCE(SUM(input_tokens), 0) AS input_tokens,
              COALESCE(SUM(output_tokens), 0) AS output_tokens,
              COALESCE(SUM(input_audio_tokens), 0) AS input_audio_tokens,
              COALESCE(SUM(output_audio_tokens), 0) AS output_audio_tokens,
              COALESCE(SUM(cached_tokens), 0) AS cached_tokens
       FROM realtime_usage
       WHERE created_at >= CURRENT_DATE - ($1 || ' days')::INTERVAL
       GROUP BY DATE(created_at)`,
      [safeDays]
    ),
  ]);

  const byDate = new Map<string, DailySpendRow>();
  const dayFor = (date: string): DailySpendRow => {
    const existing = byDate.get(date) ??
      { date, calls: 0, tokens_in: 0, tokens_out: 0, estimated_cost_usd: 0, realtime_cost_usd: 0 };
    byDate.set(date, existing);
    return existing;
  };
  for (const row of result.rows) {
    const existing = dayFor(row.date);
    existing.calls += parseInt(row.calls, 10);
    existing.tokens_in += parseInt(row.tokens_in, 10);
    existing.tokens_out += parseInt(row.tokens_out, 10);
    existing.estimated_cost_usd += estimateCostUsd(row.model, parseInt(row.tokens_in, 10), parseInt(row.tokens_out, 10));
  }
  for (const row of realtimeResult.rows) {
    dayFor(row.date).realtime_cost_usd += estimateRealtimeCostUsd({
      inputTokens: parseInt(row.input_tokens, 10),
      outputTokens: parseInt(row.output_tokens, 10),
      inputAudioTokens: parseInt(row.input_audio_tokens, 10),
      outputAudioTokens: parseInt(row.output_audio_tokens, 10),
      cachedTokens: parseInt(row.cached_tokens, 10),
    });
  }
  return Array.from(byDate.values())
    .map(r => ({
      ...r,
      estimated_cost_usd: Math.round(r.estimated_cost_usd * 10000) / 10000,
      realtime_cost_usd: Math.round(r.realtime_cost_usd * 10000) / 10000,
    }))
    .sort((a, b) => b.date.localeCompare(a.date));
}

export interface CostTotals {
  total_calls: number;
  total_tokens_in: number;
  total_tokens_out: number;
  total_estimated_cost_usd: number;
  /** Legacy wall-clock estimate — kept for reference alongside metered spend. */
  total_realtime_minutes: number;
  total_realtime_responses: number;
  total_realtime_cost_usd: number;
}

/** All-time totals for the admin analytics headline stats. */
export async function getCostTotals(): Promise<CostTotals> {
  const [usageResult, durationResult, realtimeResult] = await Promise.all([
    pool.query<{ purpose: LlmUsagePurpose; model: string | null; calls: string; tokens_in: string; tokens_out: string }>(
      `SELECT purpose, model, COUNT(*) AS calls,
              COALESCE(SUM(tokens_in), 0) AS tokens_in,
              COALESCE(SUM(tokens_out), 0) AS tokens_out
       FROM session_llm_usage
       GROUP BY purpose, model`
    ),
    pool.query<{ total_minutes: number | null }>(
      `SELECT SUM(EXTRACT(EPOCH FROM (ended_at - created_at)) / 60) AS total_minutes
       FROM therapy_sessions WHERE ended_at IS NOT NULL AND is_demo IS NOT TRUE`
    ),
    pool.query<{
      responses: string; input_tokens: string; output_tokens: string;
      input_audio_tokens: string; output_audio_tokens: string; cached_tokens: string;
    }>(
      `SELECT COUNT(*) AS responses,
              COALESCE(SUM(input_tokens), 0) AS input_tokens,
              COALESCE(SUM(output_tokens), 0) AS output_tokens,
              COALESCE(SUM(input_audio_tokens), 0) AS input_audio_tokens,
              COALESCE(SUM(output_audio_tokens), 0) AS output_audio_tokens,
              COALESCE(SUM(cached_tokens), 0) AS cached_tokens
       FROM realtime_usage`
    ),
  ]);

  let totalCalls = 0, tokensIn = 0, tokensOut = 0, estimatedCost = 0;
  for (const row of usageResult.rows) {
    totalCalls += parseInt(row.calls, 10);
    tokensIn += parseInt(row.tokens_in, 10);
    tokensOut += parseInt(row.tokens_out, 10);
    estimatedCost += estimateCostUsd(row.model, parseInt(row.tokens_in, 10), parseInt(row.tokens_out, 10));
  }

  const rt = realtimeResult.rows[0];
  const realtimeCost = rt
    ? estimateRealtimeCostUsd({
        inputTokens: parseInt(rt.input_tokens, 10),
        outputTokens: parseInt(rt.output_tokens, 10),
        inputAudioTokens: parseInt(rt.input_audio_tokens, 10),
        outputAudioTokens: parseInt(rt.output_audio_tokens, 10),
        cachedTokens: parseInt(rt.cached_tokens, 10),
      })
    : 0;

  return {
    total_calls: totalCalls,
    total_tokens_in: tokensIn,
    total_tokens_out: tokensOut,
    total_estimated_cost_usd: Math.round(estimatedCost * 10000) / 10000,
    total_realtime_minutes: Math.round(Number(durationResult.rows[0]?.total_minutes ?? 0) * 10) / 10,
    total_realtime_responses: rt ? parseInt(rt.responses, 10) : 0,
    total_realtime_cost_usd: Math.round(realtimeCost * 10000) / 10000,
  };
}
