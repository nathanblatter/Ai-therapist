// Data-access for the redaction-verification tool.
import { pool } from '../config/db.js';

/** A random sample of redacted user/assistant messages for manual review. */
export async function getRandomRedactedMessages(): Promise<Record<string, unknown>[]> {
  const result = await pool.query(`
    SELECT message_id, content_redacted, role, message_type, created_at
    FROM messages
    WHERE content_redacted IS NOT NULL AND role IN ('user', 'assistant')
    ORDER BY RANDOM()
    LIMIT 20
  `);
  return result.rows;
}

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
  return (result.rowCount ?? 0) > 0;
}
