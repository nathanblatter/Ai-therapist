// Data-access for the redaction-verification tool.
import { pool } from '../config/db.js';
import { REDACTABLE_ROWS_SQL } from './redactionScope.js';

/** Rows the leak-check flagged and no researcher has corrected or approved yet. */
const FLAGGED_UNREVIEWED_SQL =
  `(metadata->'redaction_check'->>'flagged') = 'true' AND COALESCE(metadata->'redaction_check'->>'reviewed', 'false') <> 'true'`;

/**
 * The review queue: leak-flagged messages first (ai-therapist-262), then a
 * random sample. Scoped with the shared redaction predicate so tool_event_%
 * rows — participant free text from thought records and fear ladders — are
 * eligible for verification too.
 */
export async function getRandomRedactedMessages(): Promise<Record<string, unknown>[]> {
  const result = await pool.query(`
    SELECT message_id, content_redacted, role, message_type, created_at,
           metadata->'redaction_check' AS redaction_check
    FROM messages
    WHERE content_redacted IS NOT NULL AND ${REDACTABLE_ROWS_SQL}
    ORDER BY (${FLAGGED_UNREVIEWED_SQL}) DESC, RANDOM()
    LIMIT 20
  `);
  return result.rows;
}

/** How many leak-flagged messages are still waiting for a researcher. */
export async function countFlaggedUnreviewed(): Promise<number> {
  const result = await pool.query<{ n: string }>(
    `SELECT COUNT(*)::text AS n FROM messages WHERE ${FLAGGED_UNREVIEWED_SQL} AND ${REDACTABLE_ROWS_SQL}`
  );
  return Number(result.rows[0]?.n ?? 0);
}

/** Mark a message's leak-check as human-reviewed (no-op when never checked). */
const MARK_REVIEWED_SQL = `
  UPDATE messages
     SET metadata = jsonb_set(metadata, '{redaction_check,reviewed}', 'true'::jsonb)
   WHERE message_id = $1 AND metadata ? 'redaction_check'`;

/**
 * Overwrite a message's redacted content and record WHO corrected it in
 * redaction_review_log (091), in one transaction — a correction without its
 * accountability row must not exist. Returns false if no such message.
 */
export async function updateRedactedContent(
  messageId: string,
  contentRedacted: string,
  reviewedBy: number | null
): Promise<boolean> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await client.query(
      'UPDATE messages SET content_redacted = $1 WHERE message_id = $2 RETURNING message_id',
      [contentRedacted, messageId]
    );
    if ((result.rowCount ?? 0) === 0) {
      await client.query('ROLLBACK');
      return false;
    }
    await client.query(
      `INSERT INTO redaction_review_log (message_id, reviewed_by, action)
       VALUES ($1, $2, 'corrected')`,
      [messageId, reviewedBy]
    );
    await client.query(MARK_REVIEWED_SQL, [messageId]);
    await client.query('COMMIT');
    return true;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Record a no-change sign-off from the /redact verification tool: the reviewer
 * looked at the sampled message and approved the auto-redaction as-is.
 * Returns false if the message does not exist.
 */
export async function recordRedactionApproval(
  messageId: string,
  reviewedBy: number | null
): Promise<boolean> {
  const result = await pool.query(
    `INSERT INTO redaction_review_log (message_id, reviewed_by, action)
     SELECT message_id, $2, 'approved' FROM messages WHERE message_id = $1
     RETURNING review_id`,
    [messageId, reviewedBy]
  );
  if ((result.rowCount ?? 0) === 0) return false;
  await pool.query(MARK_REVIEWED_SQL, [messageId]);
  return true;
}
