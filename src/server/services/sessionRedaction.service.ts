// Per-session redaction. Instead of redacting each message as it arrives (one
// slow double-pass model call per message, which gated live monitoring), we
// redact the whole session in a single batched job once the session ends.
import { pool } from '../config/db.js';
import { redactPHIBatch } from './redaction.service.js';

interface RedactRow {
  message_id: number;
  content: string | null;
}

/**
 * Redact every not-yet-redacted user/assistant message in a session in one
 * batched (double-pass) model call, then persist + notify admins. Fire-and-forget
 * safe: never throws; failures are recorded in message metadata for re-run.
 */
export async function redactSession(sessionId: string): Promise<void> {
  const { rows } = await pool.query<RedactRow>(
    `SELECT message_id, content
       FROM messages
      WHERE session_id = $1
        AND content_redacted IS NULL
        AND role IN ('user', 'assistant')
      ORDER BY message_id ASC`,
    [sessionId]
  );

  if (rows.length === 0) {
    return;
  }

  console.log(`🔒 Redacting session ${sessionId.substring(0, 12)}... (${rows.length} messages, batched)`);

  try {
    const redacted = await redactPHIBatch(rows.map(r => ({ id: r.message_id, content: r.content })));
    const redactedAt = new Date().toISOString();

    // Persist each redacted message.
    for (const [messageId, content] of redacted) {
      await pool.query(
        `UPDATE messages
            SET content_redacted = $1,
                metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object('redacted_at', $2::text)
          WHERE message_id = $3`,
        [content, redactedAt, messageId]
      );
    }

    // Notify admin dashboards so a just-ended session's redacted view refreshes.
    if (global.io) {
      global.io.to('admin-broadcast').emit('session:redaction-complete', {
        sessionId,
        count: redacted.size,
        redactedAt,
      });
    }

    console.log(`Session ${sessionId.substring(0, 12)}... redacted (${redacted.size} messages)`);
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error(`Session redaction failed for ${sessionId}:`, errorMessage);

    // Mark the still-unredacted messages so the failure is visible and re-runnable.
    await pool.query(
      `UPDATE messages
          SET metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object('redaction_error', $1::text)
        WHERE session_id = $2 AND content_redacted IS NULL AND role IN ('user', 'assistant')`,
      [errorMessage, sessionId]
    ).catch(err => console.error('Failed to record redaction error:', err));
  }
}
