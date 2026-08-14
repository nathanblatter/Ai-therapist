// Client error-beacon storage (pass-3 telemetry, migration 059). The public
// /api/client-events route validates kind against an allowlist and caps the
// detail payload BEFORE calling into here; these queries assume sanitized
// input shapes but still bind everything as parameters.
import { pool } from '../config/db.js';

export interface InsertClientEventInput {
  sessionId?: string | null;
  userId?: number | null;
  kind: string;
  detail?: Record<string, unknown> | null;
  userAgent?: string | null;
}

export interface ClientEventKindStat {
  kind: string;
  count: number;
  last_seen: Date;
}

/** Persist one browser-reported event. Fire-and-forget from the route. */
export async function insertClientEvent(input: InsertClientEventInput): Promise<void> {
  await pool.query(
    `INSERT INTO client_events (session_id, user_id, kind, detail, user_agent)
     VALUES ($1, $2, $3, $4, $5)`,
    [
      input.sessionId ?? null,
      input.userId ?? null,
      input.kind,
      input.detail ? JSON.stringify(input.detail) : null,
      input.userAgent ?? null,
    ]
  );
}

/** Per-kind counts over the trailing window, for the admin ops dashboard. */
export async function getClientEventStats(days: number): Promise<ClientEventKindStat[]> {
  const result = await pool.query(
    `SELECT kind, COUNT(*)::int AS count, MAX(created_at) AS last_seen
     FROM client_events
     WHERE created_at >= NOW() - make_interval(days => $1)
     GROUP BY kind
     ORDER BY count DESC`,
    [days]
  );
  return result.rows as ClientEventKindStat[];
}
