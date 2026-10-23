// assistant_audit reads (migration 092, ai-therapist-197): one row per admin
// assistant turn — who asked what and which tools ran with how many rows
// returned (never the payloads). The insert lives in
// services/assistant.service.ts; this module is the read side.
import { pool } from '../config/db.js';

export interface AssistantAuditRow {
  audit_id: number;
  user_id: number;
  username: string | null;
  role: string;
  question: string;
  tools: Array<{ name: string; args: Record<string, unknown>; row_count: number }>;
  model: string;
  input_tokens: number | null;
  output_tokens: number | null;
  created_at: string;
}

export interface AssistantAuditFilters {
  userId?: number | null;
  /** Case-insensitive substring match on the asking account's username. */
  username?: string | null;
  since?: string | null;
  until?: string | null;
  limit: number;
  offset: number;
}

/**
 * Paginated assistant audit trail. `orgId` (C13): restrict to askers in that
 * organization; null = unscoped.
 */
export async function listAssistantAudit(
  filters: AssistantAuditFilters,
  orgId: number | null = null,
): Promise<{ rows: AssistantAuditRow[]; total: number }> {
  const where = `
    WHERE ($1::int IS NULL OR aa.user_id = $1)
      AND ($2::text IS NULL OR u.username ILIKE '%' || $2 || '%')
      AND ($3::timestamptz IS NULL OR aa.created_at >= $3)
      AND ($4::timestamptz IS NULL OR aa.created_at < $4)
      AND ($5::int IS NULL OR u.organization_id = $5)`;
  const params = [
    filters.userId ?? null,
    filters.username ?? null,
    filters.since ?? null,
    filters.until ?? null,
    orgId,
  ];
  const from = 'FROM assistant_audit aa LEFT JOIN users u ON u.userid = aa.user_id';
  const [page, count] = await Promise.all([
    pool.query<AssistantAuditRow>(
      `SELECT aa.audit_id, aa.user_id, u.username, aa.role, aa.question, aa.tools, aa.model,
              aa.input_tokens, aa.output_tokens, aa.created_at::text AS created_at
       ${from} ${where}
       ORDER BY aa.audit_id DESC
       LIMIT $6 OFFSET $7`,
      [...params, filters.limit, filters.offset],
    ),
    pool.query<{ count: string }>(`SELECT COUNT(*) AS count ${from} ${where}`, params),
  ]);
  return { rows: page.rows, total: parseInt(count.rows[0].count, 10) };
}
