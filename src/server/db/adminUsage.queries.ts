// De-identified admin usage telemetry storage (migration 096). The ingest
// route authenticates the caller but deliberately never passes identity into
// these rows — only the coarse role cohort. Keep it that way: adding a
// user reference here breaks the de-identification the schema promises.
import { pool } from '../config/db.js';

export interface AdminUsageEventRow {
  usageSessionId: string;
  seq: number | null;
  role: string | null;
  kind: string;
  detail: Record<string, unknown> | null;
}

/** Persist a batch of admin usage events in one multi-row insert. */
export async function insertAdminUsageEvents(events: AdminUsageEventRow[]): Promise<void> {
  if (events.length === 0) return;
  const values: unknown[] = [];
  const rows = events.map((e, i) => {
    values.push(e.usageSessionId, e.seq, e.role, e.kind, e.detail ? JSON.stringify(e.detail) : null);
    const base = i * 5;
    return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5})`;
  });
  await pool.query(
    `INSERT INTO admin_usage_events (usage_session_id, seq, role, kind, detail)
     VALUES ${rows.join(', ')}`,
    values
  );
}

export interface AdminUsageKindStat {
  kind: string;
  count: number;
  last_seen: Date;
}

/** Per-kind counts over the trailing window (aggregate-only reads). */
export async function getAdminUsageStats(days: number): Promise<AdminUsageKindStat[]> {
  const result = await pool.query(
    `SELECT kind, COUNT(*)::int AS count, MAX(created_at) AS last_seen
     FROM admin_usage_events
     WHERE created_at >= NOW() - make_interval(days => $1)
     GROUP BY kind
     ORDER BY count DESC`,
    [days]
  );
  return result.rows as AdminUsageKindStat[];
}

/** View-reach aggregate: opens per view over the trailing window. */
export async function getAdminViewReach(days: number): Promise<Array<{ view: string; opens: number }>> {
  const result = await pool.query(
    `SELECT detail->>'view' AS view, COUNT(*)::int AS opens
     FROM admin_usage_events
     WHERE kind = 'view_open'
       AND detail->>'view' IS NOT NULL
       AND created_at >= NOW() - make_interval(days => $1)
     GROUP BY detail->>'view'
     ORDER BY opens DESC`,
    [days]
  );
  return result.rows as Array<{ view: string; opens: number }>;
}

export interface AdminViewUsageRow {
  view: string;
  /** Coarse role cohort; 'unknown' when the ingest saw no role. */
  role: string;
  opens: number;
  /** Summed view_heartbeat visible time, in milliseconds. */
  visible_ms: number;
}

/**
 * View usage split by role cohort over the trailing window: opens plus the
 * summed visible time from heartbeats. Aggregate-only, like the other reads
 * here — the row carries no identity to begin with.
 */
export async function getAdminViewUsageByRole(days: number): Promise<AdminViewUsageRow[]> {
  const result = await pool.query(
    `SELECT detail->>'view' AS view,
            COALESCE(role, 'unknown') AS role,
            COUNT(*) FILTER (WHERE kind = 'view_open')::int AS opens,
            COALESCE(SUM((detail->>'visible_ms')::double precision) FILTER (WHERE kind = 'view_heartbeat'), 0)::double precision AS visible_ms
     FROM admin_usage_events
     WHERE kind IN ('view_open', 'view_heartbeat')
       AND detail->>'view' IS NOT NULL
       AND created_at >= NOW() - make_interval(days => $1)
     GROUP BY detail->>'view', COALESCE(role, 'unknown')
     ORDER BY opens DESC, view ASC`,
    [days]
  );
  return result.rows as AdminViewUsageRow[];
}
