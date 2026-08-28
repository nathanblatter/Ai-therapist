// Message retention / wipe / participant-export SQL (caseworker portal,
// docs/caseworker-portal.md section 10 item 8: messages RETAIN LIKE SESSIONS —
// one consistent records policy). Lives apart from messaging.queries.ts only
// because that file is owned by another workstream this phase; the barrel
// (db/index.ts) should re-export this module like every other queries file.
//
// Three surfaces:
//   1. deleteAgedThreadMessages    — dataRetention.service nightly sweep
//   2. wipeAgedThreadMessageBodies — contentWipe.service sweep
//   3. getMessageHistoryForClient  — participant data export (/api/me/export)
//
// Sandbox exemption (spec section 10 item 10): sandbox threads are seeded demo
// fixtures retained until researcher-triggered batch teardown, so both sweep
// queries exclude message_threads.is_sandbox and (belt-and-suspenders) threads
// whose client user is is_sandbox.
import { pool } from '../config/db.js';

export interface AgedMessageDeletionInput {
  days: number;
  runId: string;
  policySnapshot: unknown;
  triggeredBy: 'scheduler' | 'manual';
  triggeredByUser: string | null;
}

export interface AgedMessageDeletionResult {
  messagesDeleted: number;
  crisisEventsDeleted: number;
}

/**
 * Hard-delete thread messages older than `days` (the same retention window the
 * recording age-out uses — spec section 10 item 8), in one transaction, with
 * explicit FK ordering that works whether or not migration 079's CASCADE is in
 * place:
 *   1. null thread_messages.crisis_event_id for the aged set (the aged message
 *      is the row referencing its own scan-flag crisis event, and
 *      thread_messages.crisis_event_id is NO ACTION — the event cannot be
 *      deleted while the message still points at it);
 *   2. delete message-origin crisis_events referencing the aged messages
 *      (crisis_events.thread_message_id — counted explicitly rather than left
 *      to CASCADE so the audit row records what went);
 *   3. delete the aged thread_messages themselves.
 * The data_deletion_log audit row is written INSIDE the same transaction:
 * deletions can never happen unaudited — if the audit insert fails (e.g. the
 * data_deletion_log CHECK constraints have not yet been widened for
 * artifact_type 'thread_message' / reason 'message_retention'), the whole
 * deletion rolls back and the messages are retained until the next run.
 * Threads themselves are kept: the thread row is the care-team assignment
 * record, not content.
 */
export async function deleteAgedThreadMessages(
  input: AgedMessageDeletionInput
): Promise<AgedMessageDeletionResult> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const aged = await client.query<{ message_id: string }>(
      `SELECT tm.message_id
         FROM thread_messages tm
         JOIN message_threads mt ON mt.thread_id = tm.thread_id
         JOIN users cu ON cu.userid = mt.client_id
        WHERE tm.created_at < now() - ($1 || ' days')::interval
          AND mt.is_sandbox IS NOT TRUE
          AND cu.is_sandbox IS NOT TRUE
        ORDER BY tm.message_id`,
      [input.days]
    );
    const ids = aged.rows.map(r => r.message_id);

    if (ids.length === 0) {
      await client.query('COMMIT');
      return { messagesDeleted: 0, crisisEventsDeleted: 0 };
    }

    // FK order (see doc comment): release the message -> event reference, then
    // delete the events, then the messages.
    await client.query(
      `UPDATE thread_messages SET crisis_event_id = NULL WHERE message_id = ANY($1::bigint[])`,
      [ids]
    );
    const crisisResult = await client.query(
      `DELETE FROM crisis_events WHERE thread_message_id = ANY($1::bigint[])`,
      [ids]
    );
    const messagesResult = await client.query(
      `DELETE FROM thread_messages WHERE message_id = ANY($1::bigint[])`,
      [ids]
    );

    const messagesDeleted = messagesResult.rowCount ?? 0;
    const crisisEventsDeleted = crisisResult.rowCount ?? 0;

    // One aggregate audit row per run (PII-free counts, mirroring the
    // per-artifact recording rows written by dataRetention.queries).
    await client.query(
      `INSERT INTO data_deletion_log
         (run_id, artifact_type, artifact_ref, session_id, user_id, reason,
          policy_snapshot, triggered_by, triggered_by_user, success, error_message)
       VALUES ($1, 'thread_message', $2, NULL, NULL, 'message_retention', $3, $4, $5, TRUE, NULL)`,
      [
        input.runId,
        `thread_messages:${messagesDeleted} crisis_events:${crisisEventsDeleted}`,
        JSON.stringify(input.policySnapshot),
        input.triggeredBy,
        input.triggeredByUser,
      ]
    );

    await client.query('COMMIT');
    return { messagesDeleted, crisisEventsDeleted };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Content-wipe inclusion (spec section 10 item 8): blank the BODY of thread
 * messages older than the cutoff, on the same clock as the session-message
 * content wipe. The row and its scan signals (risk_severity, scan_status,
 * crisis_event_id) survive — matching the caseworker-tier records policy of
 * signals-without-content — until the dataRetention sweep hard-deletes the row
 * at the end of the retention window. Body '' is unambiguous "wiped": the send
 * route rejects empty bodies, so no real message is ever empty.
 *
 * `requireScanComplete` is the thread-message analog of the session wipe's
 * require_redaction_complete guard: scan_status='pending' messages are left
 * alone so the async safety scan never loses its input mid-flight.
 */
export async function wipeAgedThreadMessageBodies(
  cutoff: Date,
  requireScanComplete: boolean
): Promise<number> {
  const scanGuard = requireScanComplete ? `\n        AND tm.scan_status <> 'pending'` : '';
  const result = await pool.query(
    `UPDATE thread_messages tm
        SET body = ''
       FROM message_threads mt
      WHERE mt.thread_id = tm.thread_id
        AND tm.body <> ''
        AND tm.created_at < $1
        AND mt.is_sandbox IS NOT TRUE
        AND NOT EXISTS (
          SELECT 1 FROM users cu
          WHERE cu.userid = mt.client_id AND cu.is_sandbox
        )${scanGuard}`,
    [cutoff]
  );
  return result.rowCount ?? 0;
}

export interface ExportedThreadMessage {
  message_id: number;
  sender_role: string;
  body: string;
  created_at: string;
  flagged: boolean;
}

export interface ExportedMessageThread {
  thread_id: number;
  clinician_role: string;
  status: string;
  created_at: string;
  last_message_at: string | null;
  messages: ExportedThreadMessage[];
}

/**
 * The participant's full message history for the self-scoped data export
 * (spec section 10 item 8). Participant-tier fields ONLY: like
 * messaging.routes' participantMessageView, this never exposes
 * risk_score/risk_severity — just a boolean `flagged` — and no org/sandbox
 * internals. Scoped strictly by client_id (always the authenticated user).
 */
export async function getMessageHistoryForClient(clientId: number): Promise<ExportedMessageThread[]> {
  const result = await pool.query<ExportedMessageThread>(
    `SELECT mt.thread_id,
            mt.clinician_role,
            mt.status,
            mt.created_at::text AS created_at,
            mt.last_message_at::text AS last_message_at,
            COALESCE(
              json_agg(json_build_object(
                'message_id', tm.message_id,
                'sender_role', tm.sender_role,
                'body', tm.body,
                'created_at', tm.created_at,
                'flagged', tm.scan_status = 'flagged'
              ) ORDER BY tm.message_id)
                FILTER (WHERE tm.message_id IS NOT NULL),
              '[]'
            ) AS messages
       FROM message_threads mt
       LEFT JOIN thread_messages tm ON tm.thread_id = mt.thread_id
      WHERE mt.client_id = $1
      GROUP BY mt.thread_id
      ORDER BY mt.thread_id`,
    [clientId]
  );
  return result.rows;
}
