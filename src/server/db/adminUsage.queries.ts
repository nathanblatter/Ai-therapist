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
