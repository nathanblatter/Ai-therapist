// Per-session cost/token tracking (ai-therapist-25c). Non-realtime LLM calls
// (insights generation, redaction, crisis risk assessment) log a row here;
// realtime voice minutes are derived from therapy_sessions timestamps instead
// of token-metered, since the Realtime API bills per audio-minute, not per
// text token. Logging is fire-and-forget from the calling service — a failure
// here must never break the underlying feature.
import { pool } from '../config/db.js';

export type LlmUsagePurpose = 'insights' | 'redaction' | 'crisis' | 'eligibility' | 'rerank';

// Rough, hand-maintained $/1M-token rates for the models this app calls
// LLMs with for insights/redaction/crisis (all OpenAI as of writing). This is
// an ESTIMATE for relative cost tracking, not a billing-accurate figure —
// actual OpenAI invoices are the source of truth.
const TOKEN_RATES_PER_MILLION: Record<string, { input: number; output: number }> = {
  'gpt-4o-mini': { input: 0.15, output: 0.6 },
  'gpt-4o': { input: 2.5, output: 10 },
  'gpt-5-mini': { input: 0.25, output: 2 },
  'gpt-5': { input: 1.25, output: 10 },
};
const DEFAULT_RATE = { input: 0.5, output: 1.5 }; // fallback for unlisted models

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
}

/** Per-session cost/usage rollup for the admin Session Detail panel. */
export async function getSessionCostSummary(sessionId: string): Promise<SessionCostSummary> {
  const [durationResult, usageResult] = await Promise.all([
    pool.query<{ minutes: number | null }>(
      `SELECT EXTRACT(EPOCH FROM (COALESCE(ended_at, CURRENT_TIMESTAMP) - created_at)) / 60 AS minutes
       FROM therapy_sessions WHERE session_id = $1`,
      [sessionId]
    ),
    pool.query<{ purpose: LlmUsagePurpose; model: string | null; tokens_in: number | null; tokens_out: number | null }>(
      'SELECT purpose, model, tokens_in, tokens_out FROM session_llm_usage WHERE session_id = $1',
      [sessionId]
    ),
  ]);

  const callsByPurpose: Record<LlmUsagePurpose, number> = { insights: 0, redaction: 0, crisis: 0, eligibility: 0, rerank: 0 };
  let tokensIn = 0;
  let tokensOut = 0;
  let estimatedCost = 0;
  for (const row of usageResult.rows) {
    callsByPurpose[row.purpose] = (callsByPurpose[row.purpose] ?? 0) + 1;
    tokensIn += row.tokens_in ?? 0;
    tokensOut += row.tokens_out ?? 0;
    estimatedCost += estimateCostUsd(row.model, row.tokens_in, row.tokens_out);
  }

  const rawMinutes = durationResult.rows[0]?.minutes;
  return {
    session_id: sessionId,
    realtime_minutes: rawMinutes != null ? Math.round(Number(rawMinutes) * 10) / 10 : null,
    calls_by_purpose: callsByPurpose,
    tokens_in: tokensIn,
    tokens_out: tokensOut,
    estimated_cost_usd: Math.round(estimatedCost * 10000) / 10000,
  };
}

export interface DailySpendRow {
  date: string;
  calls: number;
  tokens_in: number;
  tokens_out: number;
  estimated_cost_usd: number;
}

/** Daily estimated non-realtime LLM spend for the admin analytics view. */
export async function getDailySpend(days = 30): Promise<DailySpendRow[]> {
  const result = await pool.query<{
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
    [days]
  );

  const byDate = new Map<string, DailySpendRow>();
  for (const row of result.rows) {
    const existing = byDate.get(row.date) ?? { date: row.date, calls: 0, tokens_in: 0, tokens_out: 0, estimated_cost_usd: 0 };
    existing.calls += parseInt(row.calls, 10);
    existing.tokens_in += parseInt(row.tokens_in, 10);
    existing.tokens_out += parseInt(row.tokens_out, 10);
    existing.estimated_cost_usd += estimateCostUsd(row.model, parseInt(row.tokens_in, 10), parseInt(row.tokens_out, 10));
    byDate.set(row.date, existing);
  }
  return Array.from(byDate.values())
    .map(r => ({ ...r, estimated_cost_usd: Math.round(r.estimated_cost_usd * 10000) / 10000 }))
    .sort((a, b) => b.date.localeCompare(a.date));
}

export interface CostTotals {
  total_calls: number;
  total_tokens_in: number;
  total_tokens_out: number;
  total_estimated_cost_usd: number;
  total_realtime_minutes: number;
}

/** All-time totals for the admin analytics headline stats. */
export async function getCostTotals(): Promise<CostTotals> {
  const [usageResult, durationResult] = await Promise.all([
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
  ]);

  let totalCalls = 0, tokensIn = 0, tokensOut = 0, estimatedCost = 0;
  for (const row of usageResult.rows) {
    totalCalls += parseInt(row.calls, 10);
    tokensIn += parseInt(row.tokens_in, 10);
    tokensOut += parseInt(row.tokens_out, 10);
    estimatedCost += estimateCostUsd(row.model, parseInt(row.tokens_in, 10), parseInt(row.tokens_out, 10));
  }

  return {
    total_calls: totalCalls,
    total_tokens_in: tokensIn,
    total_tokens_out: tokensOut,
    total_estimated_cost_usd: Math.round(estimatedCost * 10000) / 10000,
    total_realtime_minutes: Math.round(Number(durationResult.rows[0]?.total_minutes ?? 0) * 10) / 10,
  };
}
