// Data-access for work_items (caseworker portal, migration 073). Producers
// are idempotent: UNIQUE (item_type, source_table, source_id) + ON CONFLICT
// DO NOTHING. Ownership is enforced IN the queries (assignee = me, or pool
// item for a client on my caseload) so routes keep 404-over-403 semantics
// without a second lookup.
import { pool } from '../config/db.js';
import type { CareTeamRole } from '../../shared/roles.js';

export type WorkItemType =
  | 'crisis_flag'
  | 'message_crisis'
  | 'adverse_event'
  | 'escalation_inbound'
  | 'escalation_response'
  | 'note_awaiting_signature'
  | 'inactivity'
  | 'screener_worsening'
  | 'message_unread_stale'
  | 'survey_drift'
  | 'participant_enrolled'
  | 'participant_withdrawal';

export type WorkItemSeverity = 'info' | 'warning' | 'urgent';
export type WorkItemStatus = 'open' | 'acked' | 'resolved' | 'expired';

export interface WorkItemRow {
  item_id: number;
  org_id: number;
  client_id: number | null;
  assignee_id: number | null;
  assignee_role: CareTeamRole | null;
  item_type: WorkItemType;
  severity: WorkItemSeverity;
  title: string;
  detail: unknown;
  source_table: string;
  source_id: string;
  status: WorkItemStatus;
  acked_by: number | null;
  acked_at: string | null;
  resolved_by: number | null;
  resolved_at: string | null;
  resolution_note: string | null;
  is_sandbox: boolean;
  created_at: string;
}

const ITEM_COLUMNS = `item_id, org_id, client_id, assignee_id, assignee_role, item_type,
       severity, title, detail, source_table, source_id, status,
       acked_by, acked_at::text AS acked_at,
       resolved_by, resolved_at::text AS resolved_at, resolution_note,
       is_sandbox, created_at::text AS created_at`;

// A member can see an item when they are the assignee, or when it is a pool
// item (assignee NULL) for a client on their caseload.
const MEMBER_VISIBILITY = `(
      assignee_id = $1
      OR (assignee_id IS NULL AND client_id IS NOT NULL AND EXISTS (
        SELECT 1 FROM therapist_clients tc WHERE tc.therapist_id = $1 AND tc.client_id = work_items.client_id
      ))
    )`;

export interface EnqueueWorkItemInput {
  orgId: number;
  clientId?: number | null;
  assigneeId?: number | null;
  assigneeRole?: CareTeamRole | null;
  itemType: WorkItemType;
  severity?: WorkItemSeverity;
  title: string;
  detail?: unknown; // reason payload; NEVER transcript/message text
  sourceTable: string;
  sourceId: string;
  isSandbox?: boolean;
  /** When true, a resolved/expired item with the same source key is
   *  reactivated (reset to a fresh open item) instead of being a no-op —
   *  the source condition re-fired after the item was closed (crisis
   *  re-flag, escalation reopen, renewed inactivity). Open/acked duplicates
   *  are still a no-op either way, so producers never double-notify. */
  reopen?: boolean;
}

/**
 * Idempotent insert. Returns the created row, or null when an OPEN/ACKED item
 * with the same (item_type, source_table, source_id) already exists (no
 * re-notify). With `reopen`, a resolved/expired row is reactivated in place
 * (status back to open, ack/resolve state cleared, title/detail/severity/
 * assignee and created_at refreshed) and returned, so the caller notifies
 * again — a re-fired condition after closure must reach a human.
 */
export async function insertWorkItem(input: EnqueueWorkItemInput): Promise<WorkItemRow | null> {
  const onConflict = input.reopen
    ? `ON CONFLICT (item_type, source_table, source_id) DO UPDATE
       SET status = 'open',
           severity = EXCLUDED.severity,
           title = EXCLUDED.title,
           detail = EXCLUDED.detail,
           assignee_id = EXCLUDED.assignee_id,
           assignee_role = EXCLUDED.assignee_role,
           acked_by = NULL, acked_at = NULL,
           resolved_by = NULL, resolved_at = NULL, resolution_note = NULL,
           created_at = now()
       WHERE work_items.status IN ('resolved', 'expired')`
    : `ON CONFLICT (item_type, source_table, source_id) DO NOTHING`;
  const result = await pool.query<WorkItemRow>(
    `INSERT INTO work_items
       (org_id, client_id, assignee_id, assignee_role, item_type, severity,
        title, detail, source_table, source_id, is_sandbox)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     ${onConflict}
     RETURNING ${ITEM_COLUMNS}`,
    [
      input.orgId,
      input.clientId ?? null,
      input.assigneeId ?? null,
      input.assigneeRole ?? null,
      input.itemType,
      input.severity ?? 'info',
      input.title,
      input.detail === undefined ? null : JSON.stringify(input.detail),
      input.sourceTable,
      input.sourceId,
      input.isSandbox ?? false,
    ]
  );
  return result.rows[0] ?? null;
}

/** One work item by id, or null (researcher/org read path). */
export async function getWorkItemById(itemId: number): Promise<WorkItemRow | null> {
  const result = await pool.query<WorkItemRow>(
    `SELECT ${ITEM_COLUMNS} FROM work_items WHERE item_id = $1`,
    [itemId]
  );
  return result.rows[0] ?? null;
}

/** A member's visible items (own + caseload pool), newest first. */
export async function listWorkItemsForMember(
  memberId: number,
  options: { statuses?: WorkItemStatus[]; limit?: number } = {}
): Promise<WorkItemRow[]> {
  const statuses = options.statuses ?? ['open', 'acked'];
  const result = await pool.query<WorkItemRow>(
    `SELECT ${ITEM_COLUMNS} FROM work_items
     WHERE ${MEMBER_VISIBILITY}
       AND status = ANY($2)
     ORDER BY created_at DESC, item_id DESC
     LIMIT $3`,
    [memberId, statuses, options.limit ?? 200]
  );
  return result.rows;
}

/** Org-wide items (researcher read), newest first. */
export async function listWorkItemsForOrg(
  orgId: number,
  options: { statuses?: WorkItemStatus[]; limit?: number } = {}
): Promise<WorkItemRow[]> {
  const statuses = options.statuses ?? ['open', 'acked'];
  const result = await pool.query<WorkItemRow>(
    `SELECT ${ITEM_COLUMNS} FROM work_items
     WHERE org_id = $1 AND status = ANY($2)
     ORDER BY created_at DESC, item_id DESC
     LIMIT $3`,
    [orgId, statuses, options.limit ?? 200]
  );
  return result.rows;
}

/**
 * Ack an open item the member can see. Returns the updated row, or null when
 * the item is missing, not visible to the member, or not open — the route
 * maps null to 404 (invisible) / 409 (raced), after a getWorkItemById check.
 */
export async function ackWorkItem(itemId: number, memberId: number): Promise<WorkItemRow | null> {
  const result = await pool.query<WorkItemRow>(
    `UPDATE work_items
     SET status = 'acked', acked_by = $1, acked_at = now()
     WHERE item_id = $2 AND status = 'open' AND ${MEMBER_VISIBILITY}
     RETURNING ${ITEM_COLUMNS}`,
    [memberId, itemId]
  );
  return result.rows[0] ?? null;
}

/** Resolve an open/acked item the member can see. Same null semantics as ack. */
export async function resolveWorkItem(
  itemId: number,
  memberId: number,
  resolutionNote: string | null
): Promise<WorkItemRow | null> {
  const result = await pool.query<WorkItemRow>(
    `UPDATE work_items
     SET status = 'resolved', resolved_by = $1, resolved_at = now(), resolution_note = $3
     WHERE item_id = $2 AND status IN ('open', 'acked') AND ${MEMBER_VISIBILITY}
     RETURNING ${ITEM_COLUMNS}`,
    [memberId, itemId, resolutionNote]
  );
  return result.rows[0] ?? null;
}

/**
 * The subset of the given work-item ids that are sandbox-origin
 * (work_items.is_sandbox). Used by the digest sweep to keep sandbox-origin
 * notifications out of real recipients' emails.
 */
export async function getSandboxWorkItemIds(itemIds: number[]): Promise<number[]> {
  if (itemIds.length === 0) return [];
  const result = await pool.query<{ item_id: number }>(
    `SELECT item_id FROM work_items WHERE item_id = ANY($1) AND is_sandbox = TRUE`,
    [itemIds]
  );
  return result.rows.map((row) => Number(row.item_id));
}

/**
 * Expire open/acked items by source (e.g. an inactivity item auto-expiring on
 * re-engagement, or the daily reconciliation sweep). Returns expired item ids.
 */
export async function expireWorkItemsBySource(
  itemType: WorkItemType,
  sourceTable: string,
  sourceIds: string[]
): Promise<number[]> {
  if (sourceIds.length === 0) return [];
  const result = await pool.query<{ item_id: number }>(
    `UPDATE work_items
     SET status = 'expired'
     WHERE item_type = $1 AND source_table = $2 AND source_id = ANY($3)
       AND status IN ('open', 'acked')
     RETURNING item_id`,
    [itemType, sourceTable, sourceIds]
  );
  return result.rows.map((row) => row.item_id);
}
