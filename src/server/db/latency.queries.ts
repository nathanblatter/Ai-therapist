// Per-turn response latency (telemetry pass 3, migration 057). One row per
// completed model turn with ground-truth timing:
//   realtime — captured by the sideband from OpenAI events
//              (input_audio_transcription.completed -> first output delta ->
//              response.done),
//   chat     — the full sendMessage tool-loop wall time (non-streaming, so
//              ttfa == total).
// Inserts are fire-and-forget from the capturing services — a logging failure
// must never break a live turn, so insertTurnLatency swallows its own errors.
import { pool } from '../config/db.js';

export type LatencyChannel = 'realtime' | 'chat';

export interface TurnLatencyInsert {
  sessionId: string;
  turnIndex?: number | null;
  userDoneAt: Date;
  /** First audio/text output delta after the user turn; null when only
   *  response.done was observed (ttfa_ms is then null too). */
  firstOutputAt: Date | null;
  responseDoneAt: Date;
  channel: LatencyChannel;
}

/** Insert one measured turn. Best-effort: swallows its own errors. */
export async function insertTurnLatency(row: TurnLatencyInsert): Promise<void> {
  const ttfaMs = row.firstOutputAt
    ? Math.max(0, row.firstOutputAt.getTime() - row.userDoneAt.getTime())
    : null;
  const totalMs = Math.max(0, row.responseDoneAt.getTime() - row.userDoneAt.getTime());
  try {
    await pool.query(
      `INSERT INTO turn_latency
         (session_id, turn_index, user_done_at, first_output_at, response_done_at, ttfa_ms, total_ms, channel)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [row.sessionId, row.turnIndex ?? null, row.userDoneAt, row.firstOutputAt, row.responseDoneAt, ttfaMs, totalMs, row.channel]
    );
  } catch (err) {
    console.error('[latency] Failed to record turn latency (non-fatal):', err);
  }
}

export interface LatencyStatsRow {
  channel: LatencyChannel;
  turns: number;
  p50_ttfa_ms: number | null;
  p95_ttfa_ms: number | null;
  p50_total_ms: number | null;
  p95_total_ms: number | null;
}

/** p50/p95 TTFA + total per channel over the last N days. */
export async function getLatencyStats(days = 7): Promise<LatencyStatsRow[]> {
  const result = await pool.query<{
    channel: LatencyChannel; turns: string;
    p50_ttfa_ms: number | null; p95_ttfa_ms: number | null;
    p50_total_ms: number | null; p95_total_ms: number | null;
  }>(
    // PERCENTILE_CONT ignores NULL inputs, so turns without an observed first
    // output (ttfa_ms NULL) still count toward the total_ms percentiles.
    `SELECT channel,
            COUNT(*) AS turns,
            PERCENTILE_CONT(0.5)  WITHIN GROUP (ORDER BY ttfa_ms)  AS p50_ttfa_ms,
            PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY ttfa_ms)  AS p95_ttfa_ms,
            PERCENTILE_CONT(0.5)  WITHIN GROUP (ORDER BY total_ms) AS p50_total_ms,
            PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY total_ms) AS p95_total_ms
       FROM turn_latency
      WHERE created_at >= CURRENT_TIMESTAMP - ($1 || ' days')::INTERVAL
      GROUP BY channel
      ORDER BY channel`,
    [days]
  );
  return result.rows.map(r => ({ ...r, turns: parseInt(r.turns, 10) }));
}

export interface SessionLatencyRow {
  turn_index: number | null;
  user_done_at: Date;
  ttfa_ms: number | null;
  total_ms: number | null;
  channel: LatencyChannel;
}

/** All measured turns for one session, in turn order. */
export async function getSessionLatency(sessionId: string): Promise<SessionLatencyRow[]> {
  const result = await pool.query<SessionLatencyRow>(
    `SELECT turn_index, user_done_at, ttfa_ms, total_ms, channel
       FROM turn_latency
      WHERE session_id = $1
      ORDER BY created_at ASC`,
    [sessionId]
  );
  return result.rows;
}
