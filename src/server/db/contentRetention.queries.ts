// Data-access for the content-wipe audit log.
import { pool } from '../config/db.js';

export interface ContentWipeLogPage {
  wipes: Record<string, unknown>[];
  total: number;
}

/** Paginated history of content-wipe runs, newest first. */
export async function getContentWipeLog(limit: number, offset: number): Promise<ContentWipeLogPage> {
  const result = await pool.query(
    `SELECT * FROM content_wipe_log
     ORDER BY started_at DESC
     LIMIT $1 OFFSET $2`,
    [limit, offset]
  );
  const countResult = await pool.query<{ count: string }>('SELECT COUNT(*) as count FROM content_wipe_log');
  return { wipes: result.rows, total: parseInt(countResult.rows[0].count) };
}
