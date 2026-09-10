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
