// Data-access for conversation messages: insert (single/batch), read, count,
// edit (with re-redaction on therapist edits), and delete.
import { pool } from '../config/db.js';
import redactPHI from '../services/redaction.service.js';

export interface MessageRow {
  message_id: number;
  session_id: string;
  role: string;
  message_type: string;
  content: string | null;
  content_redacted: string | null;
  metadata: Record<string, unknown> | null;
  created_at: Date;
}

export interface InsertMessageInput {
  session_id: string;
  role: string;
  message_type: string;
  content: string | null;
  content_redacted: string | null;
  metadata?: Record<string, unknown> | null;
  created_at?: Date;
}

/** Insert a single message. */
export async function insertMessage(
  sessionId: string,
  role: string,
  messageType: string,
  content: string | null,
  contentRedacted: string | null,
  metadata: Record<string, unknown> | null = null
): Promise<MessageRow> {
  const result = await pool.query<MessageRow>(
    `INSERT INTO messages (session_id, role, message_type, content, content_redacted, metadata, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, CURRENT_TIMESTAMP)
     RETURNING *`,
    [sessionId, role, messageType, content, contentRedacted, metadata]
  );
  return result.rows[0];
}

/** Insert multiple messages in a single transaction. */
export async function insertMessagesBatch(messages: InsertMessageInput[]): Promise<MessageRow[]> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const results: MessageRow[] = [];

    for (const msg of messages) {
      const result = await client.query<MessageRow>(
        `INSERT INTO messages (session_id, role, message_type, content, content_redacted, metadata, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING *`,
        [msg.session_id, msg.role, msg.message_type, msg.content, msg.content_redacted, msg.metadata, msg.created_at || new Date()]
      );
      results.push(result.rows[0]);
    }

    await client.query('COMMIT');
    return results;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

/** All messages for a session in order; redactedOnly exposes only redacted content. */
export async function getSessionMessages(sessionId: string, redactedOnly = false): Promise<MessageRow[]> {
  const result = await pool.query<MessageRow>(
    `SELECT
      message_id,
      session_id,
      role,
      message_type,
      ${redactedOnly ? 'content_redacted as content' : 'content, content_redacted'},
      metadata,
      created_at
     FROM messages
     WHERE session_id = $1
     ORDER BY created_at ASC`,
    [sessionId]
  );
  return result.rows;
}

/** Number of messages in a session. */
export async function getSessionMessageCount(sessionId: string): Promise<number> {
  const result = await pool.query<{ count: string }>(
    'SELECT COUNT(*) as count FROM messages WHERE session_id = $1',
    [sessionId]
  );
  return parseInt(result.rows[0].count);
}

/**
 * Update a message's content or content_redacted. A therapist edit (field
 * 'content') also re-runs redaction to refresh content_redacted.
 */
export async function updateMessage(
  messageId: number | string,
  newContent: string,
  fieldToUpdate: 'content' | 'content_redacted',
  editMetadata: Record<string, unknown>
): Promise<MessageRow> {
  if (fieldToUpdate !== 'content' && fieldToUpdate !== 'content_redacted') {
    throw new Error('fieldToUpdate must be either "content" or "content_redacted"');
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    let result;

    if (fieldToUpdate === 'content') {
      // Therapist edit: update content and regenerate content_redacted.
      const redactedContent = await redactPHI(newContent);

      result = await client.query<MessageRow>(
        `UPDATE messages
         SET content = $1,
             content_redacted = $2,
             metadata = COALESCE(metadata, '{}'::jsonb) || $3::jsonb
         WHERE message_id = $4
         RETURNING *`,
        [newContent, redactedContent, JSON.stringify(editMetadata), messageId]
      );
    } else {
      // Researcher edit: update only content_redacted.
      result = await client.query<MessageRow>(
        `UPDATE messages
         SET content_redacted = $1,
             metadata = COALESCE(metadata, '{}'::jsonb) || $2::jsonb
         WHERE message_id = $3
         RETURNING *`,
        [newContent, JSON.stringify(editMetadata), messageId]
      );
    }

    if (result.rows.length === 0) {
      throw new Error('Message not found');
    }

    await client.query('COMMIT');
    return result.rows[0];
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

/** Delete a message; refuses to delete the last message in a session. */
export async function deleteMessage(messageId: number | string): Promise<MessageRow> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const messageResult = await client.query<{ session_id: string }>(
      'SELECT session_id FROM messages WHERE message_id = $1',
      [messageId]
    );

    if (messageResult.rows.length === 0) {
      throw new Error('Message not found');
    }

    const sessionId = messageResult.rows[0].session_id;

    const countResult = await client.query<{ count: string }>(
      'SELECT COUNT(*) as count FROM messages WHERE session_id = $1',
      [sessionId]
    );

    const messageCount = parseInt(countResult.rows[0].count);

    if (messageCount <= 1) {
      throw new Error('Cannot delete the last message in a session');
    }

    const deleteResult = await client.query<MessageRow>(
      'DELETE FROM messages WHERE message_id = $1 RETURNING *',
      [messageId]
    );

    await client.query('COMMIT');
    return deleteResult.rows[0];
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
