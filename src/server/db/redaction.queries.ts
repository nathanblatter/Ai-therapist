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

/** Overwrite a message's redacted content; returns false if no such message. */
export async function updateRedactedContent(messageId: string, contentRedacted: string): Promise<boolean> {
  const result = await pool.query(
    'UPDATE messages SET content_redacted = $1 WHERE message_id = $2 RETURNING message_id',
    [contentRedacted, messageId]
  );
  return (result.rowCount ?? 0) > 0;
}
