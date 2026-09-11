// GPT-Live voice-duration metering (migration 098).
//
// Unlike the Realtime API, GPT-Live bills the voice session by wall-clock
// duration: a flat per-second rate with no rounding up to the minute. Backend
// Responses work is billed separately at normal model rates and lands in
// session_llm_usage with purpose 'live_delegation', so it flows into the
// existing cost dashboard without special handling.
//
// The critical correctness rule, straight from the docs: session.usage.updated
// carries a CUMULATIVE snapshot, not an increment. Summing the snapshots would
// massively overcount a long session. So live_usage holds exactly one row per
// session and each snapshot overwrites it.

import { pool } from '../config/db.js';

/**
 * $/minute rate for GPT-Live voice sessions (OpenAI published pricing as of
 * 2026-09). Hand-maintained ESTIMATE for relative cost tracking, matching the
 * convention used by REALTIME_RATES_PER_MILLION — invoices are the source of
 * truth. Edit here if OpenAI's pricing moves.
 */
export const LIVE_RATES_PER_MINUTE: Record<string, number> = {
  'gpt-live-1': 0.05,
};
const LIVE_DEFAULT_RATE_PER_MINUTE = 0.05;

/** Price a GPT-Live voice session in USD from its billed duration. */
export function estimateLiveCostUsd(model: string | null, durationSeconds: number | null): number {
  if (!durationSeconds || durationSeconds <= 0) return 0;
  const perMinute = (model ? LIVE_RATES_PER_MINUTE[model] : undefined) ?? LIVE_DEFAULT_RATE_PER_MINUTE;
  const cost = (durationSeconds / 60) * perMinute;
  return Math.round(cost * 1_000_000) / 1_000_000;
}

/**
 * Record a cumulative voice-duration snapshot. Idempotent by session: the
 * latest snapshot wins.
 *
 * `durationSeconds` never moves backwards within a session, but a late-arriving
 * out-of-order frame theoretically could, so the upsert takes GREATEST of the
 * stored and incoming values. `finalized` is likewise sticky — once
 * session.closed has confirmed the total, a stray in-flight snapshot must not
 * downgrade it back to provisional.
 *
 * Best-effort: swallows its own errors so a metering failure can never affect a
 * live voice session.
 */
export async function recordLiveUsage(
  sessionId: string,
  model: string,
  durationSeconds: number,
  opts: { finalized?: boolean; closeReason?: string | null; contextRatio?: number | null } = {},
): Promise<void> {
  try {
    await pool.query(
      `INSERT INTO live_usage
         (session_id, model, duration_seconds, finalized, close_reason, peak_context_ratio)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (session_id) DO UPDATE SET
         model              = EXCLUDED.model,
         duration_seconds   = GREATEST(live_usage.duration_seconds, EXCLUDED.duration_seconds),
         finalized          = live_usage.finalized OR EXCLUDED.finalized,
         close_reason       = COALESCE(EXCLUDED.close_reason, live_usage.close_reason),
         peak_context_ratio = GREATEST(
                                COALESCE(live_usage.peak_context_ratio, 0),
                                COALESCE(EXCLUDED.peak_context_ratio, 0)
                              ),
         updated_at         = CURRENT_TIMESTAMP`,
      [
        sessionId,
        model,
        durationSeconds,
        opts.finalized === true,
        opts.closeReason ?? null,
        opts.contextRatio ?? null,
      ],
    );
  } catch (err) {
    console.error('[liveUsage] Failed to record live usage (non-fatal):', err);
  }
}

export interface LiveUsageRow {
  session_id: string;
  model: string;
  duration_seconds: number;
  finalized: boolean;
  close_reason: string | null;
  peak_context_ratio: number | null;
}

/** Voice usage for one session, or null when it never ran on GPT-Live. */
export async function getLiveUsage(sessionId: string): Promise<LiveUsageRow | null> {
  const result = await pool.query<LiveUsageRow>(
    `SELECT session_id, model, duration_seconds::float8 AS duration_seconds,
            finalized, close_reason, peak_context_ratio::float8 AS peak_context_ratio
       FROM live_usage WHERE session_id = $1`,
    [sessionId],
  );
  return result.rows[0] ?? null;
}

export interface LiveUsageTotals {
  sessions: number;
  /** Sessions whose duration is still provisional (no session.closed seen). */
  unfinalized_sessions: number;
  total_seconds: number;
  estimated_cost_usd: number;
}

/**
 * Voice-duration totals over a trailing window, for the admin cost dashboard.
 *
 * Reports `unfinalized_sessions` alongside the total on purpose: a session that
 * lost its connection before session.closed has an unconfirmed duration, and the
 * dashboard should be able to say so rather than presenting an estimate as
 * settled.
 */
export async function getLiveUsageTotals(days: number): Promise<LiveUsageTotals> {
  const result = await pool.query<{
    sessions: string;
    unfinalized_sessions: string;
    total_seconds: number | null;
    model: string | null;
  }>(
    `SELECT COUNT(*)::text                                          AS sessions,
            COUNT(*) FILTER (WHERE NOT finalized)::text             AS unfinalized_sessions,
            COALESCE(SUM(duration_seconds), 0)::float8              AS total_seconds,
            MODE() WITHIN GROUP (ORDER BY model)                    AS model
       FROM live_usage
      WHERE created_at > NOW() - ($1::int * INTERVAL '1 day')`,
    [days],
  );

  const row = result.rows[0];
  const totalSeconds = row?.total_seconds ?? 0;
  return {
    sessions: Number(row?.sessions ?? 0),
    unfinalized_sessions: Number(row?.unfinalized_sessions ?? 0),
    total_seconds: totalSeconds,
    estimated_cost_usd: estimateLiveCostUsd(row?.model ?? null, totalSeconds),
  };
}
