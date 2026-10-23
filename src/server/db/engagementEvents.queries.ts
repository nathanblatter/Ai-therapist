// Phase 2 engagement-telemetry storage (migration 095). The public
// /api/engagement-events route validates kinds against an allowlist, checks
// the feature-flag gates, and caps detail payloads BEFORE calling into here;
// these queries assume sanitized shapes but still bind everything as
// parameters.
import { pool } from '../config/db.js';

export interface EngagementEventRow {
  sessionId: string | null;
  userId: number | null;
  kind: string;
  detail: Record<string, unknown> | null;
}

/** Persist a batch of engagement events in one multi-row insert. */
export async function insertEngagementEvents(events: EngagementEventRow[]): Promise<void> {
  if (events.length === 0) return;
  const values: unknown[] = [];
  const rows = events.map((e, i) => {
    values.push(e.sessionId, e.userId, e.kind, e.detail ? JSON.stringify(e.detail) : null);
    const base = i * 4;
    return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4})`;
  });
  await pool.query(
    `INSERT INTO engagement_events (session_id, user_id, kind, detail)
     VALUES ${rows.join(', ')}`,
    values
  );
}

export interface EngagementEventKindStat {
  kind: string;
  count: number;
  last_seen: Date;
}

/** Per-kind counts over the trailing window, for the admin ops dashboard. */
export async function getEngagementEventStats(days: number): Promise<EngagementEventKindStat[]> {
  const result = await pool.query(
    `SELECT kind, COUNT(*)::int AS count, MAX(created_at) AS last_seen
     FROM engagement_events
     WHERE created_at >= NOW() - make_interval(days => $1)
     GROUP BY kind
     ORDER BY count DESC`,
    [days]
  );
  return result.rows as EngagementEventKindStat[];
}

export interface SessionRhythmSummary {
  sessions: number;
  participants: number;
  p50_duration_seconds: number | null;
  p50_gap_seconds: number | null;
  /** Sessions started per local-server hour (0-23); hours with no sessions are omitted. */
  start_hours: Array<{ start_hour: number; sessions: number }>;
}

/**
 * Habit metrics from the participant_session_rhythm view (migration 095):
 * median session duration, median gap between a participant's consecutive
 * sessions, and the start-hour histogram. Aggregate-only — the view carries
 * user_id but nothing per-participant leaves this function.
 */
export async function getSessionRhythmSummary(days: number): Promise<SessionRhythmSummary> {
  const [summary, hours] = await Promise.all([
    pool.query(
      `SELECT COUNT(*)::int AS sessions,
              COUNT(DISTINCT user_id)::int AS participants,
              PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY duration_seconds) AS p50_duration_seconds,
              PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY seconds_since_prev_session) AS p50_gap_seconds
       FROM participant_session_rhythm
       WHERE started_at >= NOW() - make_interval(days => $1)`,
      [days]
    ),
    pool.query(
      `SELECT start_hour, COUNT(*)::int AS sessions
       FROM participant_session_rhythm
       WHERE started_at >= NOW() - make_interval(days => $1)
       GROUP BY start_hour
       ORDER BY start_hour`,
      [days]
    ),
  ]);
  const row = summary.rows[0] ?? {};
  return {
    sessions: Number(row.sessions ?? 0),
    participants: Number(row.participants ?? 0),
    p50_duration_seconds: row.p50_duration_seconds == null ? null : Number(row.p50_duration_seconds),
    p50_gap_seconds: row.p50_gap_seconds == null ? null : Number(row.p50_gap_seconds),
    start_hours: hours.rows as Array<{ start_hour: number; sessions: number }>,
  };
}
