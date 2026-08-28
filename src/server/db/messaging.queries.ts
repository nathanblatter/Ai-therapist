// Data-access for async messaging (caseworker portal, migration 075):
// message_threads / thread_messages / thread_read_state. One thread per
// (client, clinician) pair; threads are bound to an active care-team
// assignment — unassign freezes (read-only, retained), re-assign of the same
// pair unfreezes the same thread. No edit/delete of sent messages in v1.
import { pool } from '../config/db.js';
import type { CareTeamRole } from '../../shared/roles.js';

export type ThreadStatus = 'active' | 'frozen';
export type ThreadFrozenReason = 'unassigned' | 'client_deactivated' | 'manual';
export type MessageSenderRole = 'participant' | CareTeamRole;
export type MessageScanStatus = 'not_applicable' | 'pending' | 'clear' | 'flagged' | 'scan_failed';

export interface MessageThreadRow {
  thread_id: number;
  org_id: number;
  client_id: number;
  clinician_id: number;
  clinician_role: CareTeamRole;
  status: ThreadStatus;
  frozen_at: string | null;
  frozen_reason: ThreadFrozenReason | null;
  is_sandbox: boolean;
  created_at: string;
  last_message_at: string | null;
}

const THREAD_COLUMNS = `thread_id, org_id, client_id, clinician_id, clinician_role, status,
       frozen_at::text AS frozen_at, frozen_reason, is_sandbox,
       created_at::text AS created_at, last_message_at::text AS last_message_at`;

export interface ThreadMessageRow {
  message_id: number;
  thread_id: number;
  sender_id: number;
  sender_role: MessageSenderRole;
  body: string;
  created_at: string;
  risk_score: number | null;
  risk_severity: 'low' | 'medium' | 'high' | null;
  scan_status: MessageScanStatus;
  crisis_event_id: number | null;
}

const MESSAGE_COLUMNS = `message_id, thread_id, sender_id, sender_role, body,
       created_at::text AS created_at, risk_score, risk_severity, scan_status, crisis_event_id`;

/** One thread by id, or null. */
export async function getThreadById(threadId: number): Promise<MessageThreadRow | null> {
  const result = await pool.query<MessageThreadRow>(
    `SELECT ${THREAD_COLUMNS} FROM message_threads WHERE thread_id = $1`,
    [threadId]
  );
  return result.rows[0] ?? null;
}

/** The (client, clinician) pair's thread, or null. */
export async function getThreadForPair(
  clientId: number,
  clinicianId: number
): Promise<MessageThreadRow | null> {
  const result = await pool.query<MessageThreadRow>(
    `SELECT ${THREAD_COLUMNS} FROM message_threads WHERE client_id = $1 AND clinician_id = $2`,
    [clientId, clinicianId]
  );
  return result.rows[0] ?? null;
}

/**
 * Get-or-create the pair's thread. Re-creating an assignment-frozen thread
 * unfreezes it (same thread, history retained); manually frozen threads stay
 * frozen. Caller verifies the active care-team assignment first.
 */
export async function getOrCreateThread(input: {
  clientId: number;
  clinicianId: number;
  clinicianRole: CareTeamRole;
  orgId: number;
  isSandbox?: boolean;
}): Promise<MessageThreadRow> {
  const result = await pool.query<MessageThreadRow>(
    `INSERT INTO message_threads (client_id, clinician_id, clinician_role, org_id, is_sandbox)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (client_id, clinician_id) DO UPDATE SET
       status = CASE WHEN message_threads.frozen_reason = 'unassigned'
                     THEN 'active' ELSE message_threads.status END,
       frozen_at = CASE WHEN message_threads.frozen_reason = 'unassigned'
                        THEN NULL ELSE message_threads.frozen_at END,
       frozen_reason = CASE WHEN message_threads.frozen_reason = 'unassigned'
                            THEN NULL ELSE message_threads.frozen_reason END
     RETURNING ${THREAD_COLUMNS}`,
    [input.clientId, input.clinicianId, input.clinicianRole, input.orgId, input.isSandbox ?? false]
  );
  return result.rows[0];
}

export interface ThreadListRow extends MessageThreadRow {
  counterpart_username: string | null;
  unread_count: number;
  last_message_preview: string | null;
}

/** A clinician's inbox: threads with counterpart name, unread count, preview. */
export async function listThreadsForClinician(clinicianId: number): Promise<ThreadListRow[]> {
  const result = await pool.query<ThreadListRow>(
    `SELECT ${prefixedThreadColumns('t')},
            u.username AS counterpart_username,
            COALESCE(un.unread_count, 0)::int AS unread_count,
            lm.body AS last_message_preview
     FROM message_threads t
     JOIN users u ON u.userid = t.client_id
     LEFT JOIN LATERAL (
       SELECT COUNT(*) AS unread_count FROM thread_messages tm
       WHERE tm.thread_id = t.thread_id AND tm.sender_id <> $1
         AND tm.message_id > COALESCE(
           (SELECT trs.last_read_message_id FROM thread_read_state trs
            WHERE trs.thread_id = t.thread_id AND trs.user_id = $1), 0)
     ) un ON TRUE
     LEFT JOIN LATERAL (
       SELECT tm.body FROM thread_messages tm
       WHERE tm.thread_id = t.thread_id
       ORDER BY tm.message_id DESC LIMIT 1
     ) lm ON TRUE
     WHERE t.clinician_id = $1
     ORDER BY t.last_message_at DESC NULLS LAST, t.thread_id DESC`,
    [clinicianId]
  );
  return result.rows;
}

/** A participant's threads with clinician name, unread count, preview. */
export async function listThreadsForClient(clientId: number): Promise<ThreadListRow[]> {
  const result = await pool.query<ThreadListRow>(
    `SELECT ${prefixedThreadColumns('t')},
            u.username AS counterpart_username,
            COALESCE(un.unread_count, 0)::int AS unread_count,
            lm.body AS last_message_preview
     FROM message_threads t
     JOIN users u ON u.userid = t.clinician_id
     LEFT JOIN LATERAL (
       SELECT COUNT(*) AS unread_count FROM thread_messages tm
       WHERE tm.thread_id = t.thread_id AND tm.sender_id <> $1
         AND tm.message_id > COALESCE(
           (SELECT trs.last_read_message_id FROM thread_read_state trs
            WHERE trs.thread_id = t.thread_id AND trs.user_id = $1), 0)
     ) un ON TRUE
     LEFT JOIN LATERAL (
       SELECT tm.body FROM thread_messages tm
       WHERE tm.thread_id = t.thread_id
       ORDER BY tm.message_id DESC LIMIT 1
     ) lm ON TRUE
     WHERE t.client_id = $1
     ORDER BY t.last_message_at DESC NULLS LAST, t.thread_id DESC`,
    [clientId]
  );
  return result.rows;
}

function prefixedThreadColumns(alias: string): string {
  return `${alias}.thread_id, ${alias}.org_id, ${alias}.client_id, ${alias}.clinician_id,
       ${alias}.clinician_role, ${alias}.status, ${alias}.frozen_at::text AS frozen_at,
       ${alias}.frozen_reason, ${alias}.is_sandbox,
       ${alias}.created_at::text AS created_at, ${alias}.last_message_at::text AS last_message_at`;
}

/** Insert a message and bump the thread's last_message_at, atomically. */
export async function insertThreadMessage(input: {
  threadId: number;
  senderId: number;
  senderRole: MessageSenderRole;
  body: string;
  scanStatus?: MessageScanStatus;
}): Promise<ThreadMessageRow> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const inserted = await client.query<ThreadMessageRow>(
      `INSERT INTO thread_messages (thread_id, sender_id, sender_role, body, scan_status)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING ${MESSAGE_COLUMNS}`,
      [input.threadId, input.senderId, input.senderRole, input.body, input.scanStatus ?? 'not_applicable']
    );
    await client.query(
      `UPDATE message_threads SET last_message_at = now() WHERE thread_id = $1`,
      [input.threadId]
    );
    await client.query('COMMIT');
    return inserted.rows[0];
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/** A thread's messages, oldest first, keyset-paginated by message_id. */
export async function listThreadMessages(
  threadId: number,
  options: { beforeMessageId?: number | null; limit?: number } = {}
): Promise<ThreadMessageRow[]> {
  const result = await pool.query<ThreadMessageRow>(
    `SELECT * FROM (
       SELECT ${MESSAGE_COLUMNS} FROM thread_messages
       WHERE thread_id = $1 AND ($2::bigint IS NULL OR message_id < $2)
       ORDER BY message_id DESC
       LIMIT $3
     ) page ORDER BY message_id ASC`,
    [threadId, options.beforeMessageId ?? null, options.limit ?? 50]
  );
  return result.rows;
}

/** Advance the caller's read pointer (never moves backwards). */
export async function markThreadRead(
  threadId: number,
  userId: number,
  lastReadMessageId: number
): Promise<void> {
  await pool.query(
    `INSERT INTO thread_read_state (thread_id, user_id, last_read_message_id, updated_at)
     VALUES ($1, $2, $3, now())
     ON CONFLICT (thread_id, user_id) DO UPDATE SET
       last_read_message_id = GREATEST(thread_read_state.last_read_message_id, EXCLUDED.last_read_message_id),
       updated_at = now()`,
    [threadId, userId, lastReadMessageId]
  );
}

/** Record scan results on a participant message (messageSafety service). */
export async function updateThreadMessageScan(
  messageId: number,
  update: {
    scanStatus: MessageScanStatus;
    riskScore?: number | null;
    riskSeverity?: 'low' | 'medium' | 'high' | null;
    crisisEventId?: number | null;
  }
): Promise<void> {
  await pool.query(
    `UPDATE thread_messages
     SET scan_status = $2, risk_score = $3, risk_severity = $4,
         crisis_event_id = COALESCE($5, crisis_event_id)
     WHERE message_id = $1`,
    [messageId, update.scanStatus, update.riskScore ?? null, update.riskSeverity ?? null, update.crisisEventId ?? null]
  );
}

/** Freeze the pair's active thread on unassignment. Returns frozen thread ids. */
export async function freezeThreadsForPair(
  clinicianId: number,
  clientId: number,
  reason: ThreadFrozenReason
): Promise<number[]> {
  const result = await pool.query<{ thread_id: number }>(
    `UPDATE message_threads
     SET status = 'frozen', frozen_at = now(), frozen_reason = $3
     WHERE clinician_id = $1 AND client_id = $2 AND status = 'active'
     RETURNING thread_id`,
    [clinicianId, clientId, reason]
  );
  return result.rows.map((row) => row.thread_id);
}

/** Total unread messages for a user across their threads (header badge). */
export async function countUnreadForUser(userId: number): Promise<number> {
  const result = await pool.query<{ total: string }>(
    `SELECT COUNT(*) AS total
     FROM thread_messages tm
     JOIN message_threads t ON t.thread_id = tm.thread_id
     WHERE (t.client_id = $1 OR t.clinician_id = $1)
       AND tm.sender_id <> $1
       AND tm.message_id > COALESCE(
         (SELECT trs.last_read_message_id FROM thread_read_state trs
          WHERE trs.thread_id = tm.thread_id AND trs.user_id = $1), 0)`,
    [userId]
  );
  return parseInt(result.rows[0]?.total ?? '0', 10);
}

/** Per-client unread counts for a clinician's roster (dashboard chips). */
export async function countUnreadByClientForMember(
  memberId: number
): Promise<Array<{ client_id: number; unread_count: number }>> {
  const result = await pool.query<{ client_id: number; unread_count: number }>(
    `SELECT t.client_id, COUNT(*)::int AS unread_count
     FROM thread_messages tm
     JOIN message_threads t ON t.thread_id = tm.thread_id
     WHERE t.clinician_id = $1
       AND tm.sender_id <> $1
       AND tm.message_id > COALESCE(
         (SELECT trs.last_read_message_id FROM thread_read_state trs
          WHERE trs.thread_id = tm.thread_id AND trs.user_id = $1), 0)
     GROUP BY t.client_id`,
    [memberId]
  );
  return result.rows;
}

/**
 * Crisis events raised by the message-safety scan (origin='thread_message',
 * migration 076), newest first, joined to the flagged client. When memberId
 * is set, restrict to the member's caseload (CrisisManagement embed). When
 * orgId is set (researchers, C13), restrict to events whose flagged client
 * belongs to that organization.
 */
export async function listMessageOriginCrisisEvents(
  memberId?: number | null,
  orgId?: number | null,
  limit = 100
): Promise<Record<string, unknown>[]> {
  const params: unknown[] = [limit];
  let scopeClause = '';
  if (memberId !== null && memberId !== undefined) {
    params.push(memberId);
    scopeClause += ` AND EXISTS (SELECT 1 FROM therapist_clients tc WHERE tc.therapist_id = $${params.length} AND tc.client_id = ce.client_user_id)`;
  }
  if (orgId !== null && orgId !== undefined) {
    params.push(orgId);
    scopeClause += ` AND EXISTS (SELECT 1 FROM users ou WHERE ou.userid = ce.client_user_id AND ou.organization_id = $${params.length})`;
  }
  const result = await pool.query(
    `SELECT ce.*, u.username, tm.thread_id
     FROM crisis_events ce
     LEFT JOIN users u ON u.userid = ce.client_user_id
     LEFT JOIN thread_messages tm ON tm.message_id = ce.thread_message_id
     WHERE ce.origin = 'thread_message'${scopeClause}
     ORDER BY ce.created_at DESC
     LIMIT $1`,
    params
  );
  return result.rows;
}
