import redactPHI from './redaction.service.js';
import { pool } from '../config/db.js';

// In-memory queue for redaction jobs
const redactionQueue = [];
let isProcessing = false;

/**
 * Queue a message for asynchronous redaction
 * @param {number} messageId - Message ID to redact
 * @param {string} content - Original content to redact
 * @param {string} sessionId - Session ID for Socket.io event
 */
export function queueRedaction(messageId, content, sessionId) {
  redactionQueue.push({ messageId, content, sessionId });

  // Start processing if not already running
  if (!isProcessing) {
    processQueue();
  }
}

/**
 * Process the redaction queue asynchronously
 */
async function processQueue() {
  if (isProcessing || redactionQueue.length === 0) {
    return;
  }

  isProcessing = true;

  while (redactionQueue.length > 0) {
    const job = redactionQueue.shift();

    try {
      console.log(`🔒 Redacting message ${job.messageId}...`);

      // Perform double-pass redaction
      const redactedContent = await redactPHI(job.content);

      // Update the database with redacted content
      const redactedAt = new Date().toISOString();
      await pool.query(
        `UPDATE messages
         SET content_redacted = $1,
             metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object('redacted_at', $2::text)
         WHERE message_id = $3`,
        [redactedContent, redactedAt, job.messageId]
      );

      // Emit Socket.io event to notify admins redaction is complete
      if (global.io && job.sessionId) {
        global.io.to(`session:${job.sessionId}`).emit('message:redacted', {
          messageId: job.messageId,
          content_redacted: redactedContent,
          redacted_at: redactedAt
        });
      }

      console.log(`Message ${job.messageId} redacted successfully`);
    } catch (error) {
      console.error(`Failed to redact message ${job.messageId}:`, error);

      // Store error in metadata for debugging
      await pool.query(
        `UPDATE messages
         SET metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object('redaction_error', $1::text)
         WHERE message_id = $2`,
        [error.message, job.messageId]
      ).catch(err => console.error('Failed to update error metadata:', err));
    }
  }

  isProcessing = false;
}

/**
 * Get queue status for monitoring
 */
export function getQueueStatus() {
  return {
    queueLength: redactionQueue.length,
    isProcessing
  };
}

/**
 * Batch queue multiple messages for redaction
 * @param {Array<{messageId: number, content: string, sessionId: string}>} messages
 */
export function queueRedactionBatch(messages) {
  for (const msg of messages) {
    queueRedaction(msg.messageId, msg.content, msg.sessionId);
  }
}
