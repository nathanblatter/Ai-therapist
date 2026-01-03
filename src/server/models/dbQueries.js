// dbQueries.js
// Helper functions for interacting with normalized database schema

import { pool } from '../config/db.js';
import redactPHI from '../services/redaction.service.js';

// ============================================
// THERAPY SESSIONS
// ============================================

/**
 * Create a new therapy session
 * @param {number|null} userId - User ID (null for anonymous sessions)
 * @param {string|null} sessionName - Optional session name
 * @returns {Promise<object>} Created session object
 */
export async function createSession(userId = null, sessionName = null) {
  const result = await pool.query(
    `INSERT INTO therapy_sessions (user_id, session_name, status, created_at, updated_at)
     VALUES ($1, $2, 'active', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
     RETURNING *`,
    [userId, sessionName]
  );
  return result.rows[0];
}

/**
 * Get session by ID
 * @param {string} sessionId - UUID of session
 * @returns {Promise<object|null>} Session object or null
 */
export async function getSession(sessionId) {
  const result = await pool.query(
    'SELECT * FROM therapy_sessions WHERE session_id = $1',
    [sessionId]
  );
  return result.rows[0] || null;
}

/**
 * Get active session for a user (for idempotency checks)
 * @param {number} userId - User ID
 * @returns {Promise<object|null>} Active session or null
 */
export async function getActiveSessionForUser(userId) {
  if (!userId) return null;

  const result = await pool.query(
    `SELECT * FROM therapy_sessions
     WHERE user_id = $1 AND status = 'active'
     ORDER BY created_at DESC
     LIMIT 1`,
    [userId]
  );
  return result.rows[0] || null;
}

/**
 * Get all sessions for a user
 * @param {number} userId - User ID
 * @param {string} status - Optional status filter ('active', 'ended', 'archived')
 * @returns {Promise<Array>} Array of session objects
 */
export async function getUserSessions(userId, status = null) {
  const query = status
    ? 'SELECT * FROM therapy_sessions WHERE user_id = $1 AND status = $2 ORDER BY created_at DESC'
    : 'SELECT * FROM therapy_sessions WHERE user_id = $1 ORDER BY created_at DESC';

  const params = status ? [userId, status] : [userId];
  const result = await pool.query(query, params);
  return result.rows;
}

/**
 * Get all sessions (admin view)
 * @param {number} limit - Max sessions to return
 * @param {number} offset - Offset for pagination
 * @returns {Promise<Array>} Array of session objects with message counts
 */
export async function getAllSessions(limit = 50, offset = 0) {
  const result = await pool.query(
    `SELECT
      ts.*,
      u.username,
      COUNT(m.message_id) as message_count
     FROM therapy_sessions ts
     LEFT JOIN users u ON ts.user_id = u.userid
     LEFT JOIN messages m ON ts.session_id = m.session_id
     GROUP BY ts.session_id, u.username
     ORDER BY ts.created_at DESC
     LIMIT $1 OFFSET $2`,
    [limit, offset]
  );
  return result.rows;
}

/**
 * Update session status (idempotent)
 * @param {string} sessionId - UUID of session
 * @param {string} status - New status ('active', 'ended', 'archived')
 * @param {string|null} endedBy - Who ended the session ('user', admin username, or null)
 * @returns {Promise<object>} Updated session object, or existing session if no change needed
 */
export async function updateSessionStatus(sessionId, status, endedBy = null) {
  // First check current status
  const currentSession = await getSession(sessionId);
  if (!currentSession) {
    throw new Error('Session not found');
  }

  // If already in target status, return existing session (idempotent)
  if (currentSession.status === status) {
    return currentSession;
  }

  // Only update if status is different
  const result = await pool.query(
    `UPDATE therapy_sessions
     SET status = $1,
         updated_at = CURRENT_TIMESTAMP,
         ended_at = ${status === 'ended' ? 'CURRENT_TIMESTAMP' : 'ended_at'},
         ended_by = ${status === 'ended' && endedBy ? '$3' : 'ended_by'}
     WHERE session_id = $2
     RETURNING *`,
    status === 'ended' && endedBy ? [status, sessionId, endedBy] : [status, sessionId]
  );
  return result.rows[0];
}

/**
 * Update session name (typically auto-generated after session ends)
 * @param {string} sessionId - UUID of session
 * @param {string} sessionName - New session name
 * @returns {Promise<object>} Updated session object
 */
export async function updateSessionName(sessionId, sessionName) {
  const result = await pool.query(
    `UPDATE therapy_sessions
     SET session_name = $1, updated_at = CURRENT_TIMESTAMP
     WHERE session_id = $2
     RETURNING *`,
    [sessionName, sessionId]
  );
  return result.rows[0];
}

/**
 * Delete a therapy session and all associated data
 * @param {string} sessionId - UUID of session
 * @returns {Promise<object>} Deleted session object
 */
export async function deleteSession(sessionId) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // First get the session to return it
    const sessionResult = await client.query(
      'SELECT * FROM therapy_sessions WHERE session_id = $1',
      [sessionId]
    );

    if (sessionResult.rows.length === 0) {
      throw new Error('Session not found');
    }

    const session = sessionResult.rows[0];

    // Delete all messages associated with the session
    await client.query(
      'DELETE FROM messages WHERE session_id = $1',
      [sessionId]
    );

    // Delete session configuration if exists
    await client.query(
      'DELETE FROM session_configurations WHERE session_id = $1',
      [sessionId]
    );

    // Delete the session itself
    await client.query(
      'DELETE FROM therapy_sessions WHERE session_id = $1',
      [sessionId]
    );

    await client.query('COMMIT');
    return session;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

// ============================================
// SESSION CONFIGURATIONS
// ============================================

/**
 * Create or update session configuration
 * @param {string} sessionId - UUID of session
 * @param {object} config - Configuration object
 * @returns {Promise<object>} Created/updated configuration
 */
export async function upsertSessionConfig(sessionId, config) {
  const {
    voice = 'alloy',
    modalities = ['text', 'audio'],
    instructions = null,
    turn_detection = null,
    tools = null,
    temperature = 0.8,
    max_response_output_tokens = 4096,
    language = 'en'
  } = config;

  // Handle JSONB fields: convert to JSON string if not null, otherwise keep as null
  const turnDetectionJson = turn_detection ? JSON.stringify(turn_detection) : null;
  const toolsJson = tools ? JSON.stringify(tools) : null;

  const result = await pool.query(
    `INSERT INTO session_configurations
     (session_id, voice, modalities, instructions, turn_detection, tools, temperature, max_response_output_tokens, language)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7, $8, $9)
     ON CONFLICT (session_id)
     DO UPDATE SET
       voice = EXCLUDED.voice,
       modalities = EXCLUDED.modalities,
       instructions = EXCLUDED.instructions,
       turn_detection = EXCLUDED.turn_detection,
       tools = EXCLUDED.tools,
       temperature = EXCLUDED.temperature,
       max_response_output_tokens = EXCLUDED.max_response_output_tokens,
       language = EXCLUDED.language
     RETURNING *`,
    [sessionId, voice, modalities, instructions, turnDetectionJson, toolsJson, temperature, max_response_output_tokens, language]
  );
  return result.rows[0];
}

/**
 * Get session configuration
 * @param {string} sessionId - UUID of session
 * @returns {Promise<object|null>} Configuration object or null
 */
export async function getSessionConfig(sessionId) {
  const result = await pool.query(
    'SELECT * FROM session_configurations WHERE session_id = $1',
    [sessionId]
  );
  return result.rows[0] || null;
}

// ============================================
// MESSAGES
// ============================================

/**
 * Insert a new message
 * @param {string} sessionId - UUID of session
 * @param {string} role - Message role ('user', 'assistant', 'system')
 * @param {string} messageType - Message type ('voice', 'chat', 'session_start', etc.)
 * @param {string} content - Original message content
 * @param {string} contentRedacted - HIPAA-compliant redacted content
 * @param {object} metadata - Additional metadata
 * @returns {Promise<object>} Created message object
 */
export async function insertMessage(sessionId, role, messageType, content, contentRedacted, metadata = null) {
  const result = await pool.query(
    `INSERT INTO messages (session_id, role, message_type, content, content_redacted, metadata, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, CURRENT_TIMESTAMP)
     RETURNING *`,
    [sessionId, role, messageType, content, contentRedacted, metadata]
  );
  return result.rows[0];
}

/**
 * Insert multiple messages in a batch
 * @param {Array<object>} messages - Array of message objects
 * @returns {Promise<Array>} Array of created message objects
 */
export async function insertMessagesBatch(messages) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const results = [];

    for (const msg of messages) {
      const result = await client.query(
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

/**
 * Get all messages for a session
 * @param {string} sessionId - UUID of session
 * @param {boolean} redactedOnly - If true, only return redacted content
 * @returns {Promise<Array>} Array of message objects
 */
export async function getSessionMessages(sessionId, redactedOnly = false) {
  const result = await pool.query(
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

/**
 * Get message count for a session
 * @param {string} sessionId - UUID of session
 * @returns {Promise<number>} Message count
 */
export async function getSessionMessageCount(sessionId) {
  const result = await pool.query(
    'SELECT COUNT(*) as count FROM messages WHERE session_id = $1',
    [sessionId]
  );
  return parseInt(result.rows[0].count);
}

/**
 * Update a message (either content or content_redacted based on role)
 * @param {number} messageId - Message ID
 * @param {string} newContent - Updated message content
 * @param {string} fieldToUpdate - Either 'content' or 'content_redacted'
 * @param {object} editMetadata - Information about who edited and when
 * @returns {Promise<object>} Updated message object
 */
export async function updateMessage(messageId, newContent, fieldToUpdate, editMetadata) {
  // Validate field parameter
  if (fieldToUpdate !== 'content' && fieldToUpdate !== 'content_redacted') {
    throw new Error('fieldToUpdate must be either "content" or "content_redacted"');
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    let result;

    if (fieldToUpdate === 'content') {
      // Therapist edit: update both content and regenerate content_redacted
      const redactedContent = await redactPHI(newContent);

      result = await client.query(
        `UPDATE messages
         SET content = $1,
             content_redacted = $2,
             metadata = COALESCE(metadata, '{}'::jsonb) || $3::jsonb
         WHERE message_id = $4
         RETURNING *`,
        [newContent, redactedContent, JSON.stringify(editMetadata), messageId]
      );
    } else {
      // Researcher edit: update only content_redacted
      result = await client.query(
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

/**
 * Delete a message (with validation to prevent deleting last message)
 * @param {number} messageId - Message ID
 * @returns {Promise<object>} Deleted message object
 */
export async function deleteMessage(messageId) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Get the message to find its session_id
    const messageResult = await client.query(
      'SELECT session_id FROM messages WHERE message_id = $1',
      [messageId]
    );

    if (messageResult.rows.length === 0) {
      throw new Error('Message not found');
    }

    const sessionId = messageResult.rows[0].session_id;

    // Check message count for the session
    const countResult = await client.query(
      'SELECT COUNT(*) as count FROM messages WHERE session_id = $1',
      [sessionId]
    );

    const messageCount = parseInt(countResult.rows[0].count);

    if (messageCount <= 1) {
      throw new Error('Cannot delete the last message in a session');
    }

    // Proceed with deletion
    const deleteResult = await client.query(
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

// ============================================
// ANALYTICS
// ============================================

/**
 * Get session statistics
 * @returns {Promise<object>} Statistics object
 */
export async function getSessionStats() {
  const result = await pool.query(
    `SELECT
      COUNT(DISTINCT session_id) as total_sessions,
      COUNT(DISTINCT user_id) FILTER (WHERE user_id IS NOT NULL) as authenticated_sessions,
      COUNT(*) FILTER (WHERE status = 'active') as active_sessions,
      COUNT(*) FILTER (WHERE status = 'ended') as ended_sessions,
      AVG(EXTRACT(EPOCH FROM (ended_at - created_at))/60) FILTER (WHERE ended_at IS NOT NULL) as avg_duration_minutes
     FROM therapy_sessions`
  );
  return result.rows[0];
}

/**
 * Get message statistics
 * @returns {Promise<object>} Statistics object
 */
export async function getMessageStats() {
  const result = await pool.query(
    `SELECT
      COUNT(*) as total_messages,
      COUNT(*) FILTER (WHERE role = 'user') as user_messages,
      COUNT(*) FILTER (WHERE role = 'assistant') as assistant_messages,
      COUNT(DISTINCT session_id) as sessions_with_messages
     FROM messages`
  );
  return result.rows[0];
}

/**
 * Get language usage statistics
 * @returns {Promise<Array>} Array of language stats with counts and percentages
 */
export async function getLanguageStats() {
  const result = await pool.query(
    `SELECT
      sc.language,
      COUNT(*) as session_count,
      ROUND(COUNT(*) * 100.0 / SUM(COUNT(*)) OVER (), 2) as percentage
     FROM session_configurations sc
     JOIN therapy_sessions ts ON sc.session_id = ts.session_id
     WHERE sc.language IS NOT NULL
     GROUP BY sc.language
     ORDER BY session_count DESC`
  );
  return result.rows;
}

/**
 * Get voice usage statistics
 * @returns {Promise<Array>} Array of voice stats with counts and percentages
 */
export async function getVoiceStats() {
  const result = await pool.query(
    `SELECT
      sc.voice,
      COUNT(*) as session_count,
      ROUND(COUNT(*) * 100.0 / SUM(COUNT(*)) OVER (), 2) as percentage
     FROM session_configurations sc
     JOIN therapy_sessions ts ON sc.session_id = ts.session_id
     WHERE sc.voice IS NOT NULL
     GROUP BY sc.voice
     ORDER BY session_count DESC`
  );
  return result.rows;
}

/**
 * Get combined session configuration statistics
 * @returns {Promise<object>} Object containing language and voice statistics
 */
export async function getConfigStats() {
  const languageStats = await getLanguageStats();
  const voiceStats = await getVoiceStats();

  return {
    languages: languageStats,
    voices: voiceStats
  };
}
