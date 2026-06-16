// dbQueries.ts
// Helper functions for interacting with normalized database schema

import { pool } from '../config/db.js';
import redactPHI from '../services/redaction.service.js';

// ============================================
// ROW INTERFACES (exported for callers)
// ============================================

export interface SessionRow {
  session_id: string;
  user_id: number | null;
  session_name: string | null;
  status: string;
  session_type: string;
  created_at: Date;
  updated_at: Date;
  ended_at: Date | null;
  ended_by: string | null;
  crisis_flagged?: boolean;
  crisis_severity?: string | null;
  crisis_risk_score?: number | null;
  crisis_flagged_at?: Date | null;
  crisis_flagged_by?: string | null;
  openai_call_id?: string | null;
  sideband_connected?: boolean;
  sideband_connected_at?: Date | null;
  sideband_disconnected_at?: Date | null;
  sideband_error?: string | null;
}

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

export interface UserRow {
  userid: number;
  username: string;
  role: string;
  password?: string;
  preferred_voice?: string | null;
  preferred_language?: string | null;
  mfa_enabled?: boolean;
  mfa_secret?: string | null;
  mfa_backup_codes?: string[] | null;
  mfa_enabled_at?: Date | null;
  created_at?: Date;
  updated_at?: Date;
}

export interface SessionConfigRow {
  session_id: string;
  voice: string | null;
  modalities: string[] | null;
  instructions: string | null;
  turn_detection: Record<string, unknown> | null;
  tools: unknown[] | null;
  temperature: number | null;
  max_response_output_tokens: number | null;
  language: string | null;
}

export interface SessionStatsRow {
  total_sessions: string;
  authenticated_sessions: string;
  active_sessions: string;
  ended_sessions: string;
  avg_duration_minutes: string | null;
}

export interface MessageStatsRow {
  total_messages: string;
  user_messages: string;
  assistant_messages: string;
  sessions_with_messages: string;
}

export interface LanguageStatRow {
  language: string;
  session_count: string;
  percentage: string;
}

export interface VoiceStatRow {
  voice: string;
  session_count: string;
  percentage: string;
}

export interface SystemConfigRow {
  config_value: Record<string, unknown> & { model?: string };
}

export interface CreateSessionConfig {
  sessionId: string;
  userId?: number | null;
  sessionName?: string | null;
  status?: string;
  sessionType?: string;
}

// ============================================
// THERAPY SESSIONS
// ============================================

/**
 * Create a new therapy session
 * @param userId - User ID (null for anonymous) OR session config object
 * @param sessionName - Optional session name (only used if first param is userId)
 * @returns Created session object
 */
export async function createSession(userId: number | CreateSessionConfig | null = null, sessionName: string | null = null): Promise<SessionRow> {
  // Support both object-based and parameter-based calls
  if (typeof userId === 'object' && userId !== null) {
    const config = userId as CreateSessionConfig;
    const result = await pool.query<SessionRow>(
      `INSERT INTO therapy_sessions (session_id, user_id, session_name, status, session_type, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
       RETURNING *`,
      [
        config.sessionId,
        config.userId || null,
        config.sessionName || null,
        config.status || 'active',
        config.sessionType || 'realtime'
      ]
    );
    return result.rows[0];
  } else {
    // Legacy parameter-based call
    const result = await pool.query<SessionRow>(
      `INSERT INTO therapy_sessions (user_id, session_name, status, created_at, updated_at)
       VALUES ($1, $2, 'active', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
       RETURNING *`,
      [userId, sessionName]
    );
    return result.rows[0];
  }
}

/**
 * Get session by ID
 * @param sessionId - UUID of session
 * @returns Session object or null
 */
export async function getSession(sessionId: string): Promise<SessionRow | null> {
  const result = await pool.query<SessionRow>(
    'SELECT * FROM therapy_sessions WHERE session_id = $1',
    [sessionId]
  );
  return result.rows[0] || null;
}

/**
 * Get active session for a user (for idempotency checks)
 * @param userId - User ID
 * @returns Active session or null
 */
export async function getActiveSessionForUser(userId: number | string): Promise<SessionRow | null> {
  if (!userId) return null;

  const result = await pool.query<SessionRow>(
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
 * @param userId - User ID
 * @param status - Optional status filter ('active', 'ended', 'archived')
 * @returns Array of session objects
 */
export async function getUserSessions(userId: number | string, status: string | null = null): Promise<SessionRow[]> {
  const query = status
    ? 'SELECT * FROM therapy_sessions WHERE user_id = $1 AND status = $2 ORDER BY created_at DESC'
    : 'SELECT * FROM therapy_sessions WHERE user_id = $1 ORDER BY created_at DESC';

  const params = status ? [userId, status] : [userId];
  const result = await pool.query<SessionRow>(query, params);
  return result.rows;
}

/**
 * Get all sessions (admin view)
 * @param limit - Max sessions to return
 * @param offset - Offset for pagination
 * @returns Array of session objects with message counts
 */
export async function getAllSessions(limit = 50, offset = 0): Promise<Array<SessionRow & { username?: string; message_count?: string }>> {
  const result = await pool.query<SessionRow & { username?: string; message_count?: string }>(
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
 * @param sessionId - UUID of session
 * @param status - New status ('active', 'ended', 'archived')
 * @param endedBy - Who ended the session ('user', admin username, or null)
 * @returns Updated session object, or existing session if no change needed
 */
export async function updateSessionStatus(sessionId: string, status: string, endedBy: string | null = null): Promise<SessionRow> {
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
  const result = await pool.query<SessionRow>(
    `UPDATE therapy_sessions
     SET status = $1,
         updated_at = CURRENT_TIMESTAMP,
         ended_at = ${status === 'ended' ? "CURRENT_TIMESTAMP" : 'ended_at'},
         ended_by = ${status === 'ended' && endedBy ? '$3' : 'ended_by'}
     WHERE session_id = $2
     RETURNING *`,
    status === 'ended' && endedBy ? [status, sessionId, endedBy] : [status, sessionId]
  );
  return result.rows[0];
}

/**
 * Update session name (typically auto-generated after session ends)
 * @param sessionId - UUID of session
 * @param sessionName - New session name
 * @returns Updated session object
 */
export async function updateSessionName(sessionId: string, sessionName: string): Promise<SessionRow> {
  const result = await pool.query<SessionRow>(
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
 * @param sessionId - UUID of session
 * @returns Deleted session object
 */
export async function deleteSession(sessionId: string): Promise<SessionRow> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // First get the session to return it
    const sessionResult = await client.query<SessionRow>(
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

export interface UpsertSessionConfigInput {
  voice?: string;
  modalities?: string[];
  instructions?: string | null;
  turn_detection?: Record<string, unknown> | null;
  tools?: unknown[] | null;
  temperature?: number;
  max_response_output_tokens?: number;
  language?: string;
}

/**
 * Create or update session configuration
 * @param sessionId - UUID of session
 * @param config - Configuration object
 * @returns Created/updated configuration
 */
export async function upsertSessionConfig(sessionId: string, config: UpsertSessionConfigInput): Promise<SessionConfigRow> {
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

  const result = await pool.query<SessionConfigRow>(
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
 * @param sessionId - UUID of session
 * @returns Configuration object or null
 */
export async function getSessionConfig(sessionId: string): Promise<SessionConfigRow | null> {
  const result = await pool.query<SessionConfigRow>(
    'SELECT * FROM session_configurations WHERE session_id = $1',
    [sessionId]
  );
  return result.rows[0] || null;
}

// ============================================
// MESSAGES
// ============================================

export interface InsertMessageInput {
  session_id: string;
  role: string;
  message_type: string;
  content: string | null;
  content_redacted: string | null;
  metadata?: Record<string, unknown> | null;
  created_at?: Date;
}

/**
 * Insert a new message
 * @param sessionId - UUID of session
 * @param role - Message role ('user', 'assistant', 'system')
 * @param messageType - Message type ('voice', 'chat', 'session_start', etc.)
 * @param content - Original message content
 * @param contentRedacted - HIPAA-compliant redacted content
 * @param metadata - Additional metadata
 * @returns Created message object
 */
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

/**
 * Insert multiple messages in a batch
 * @param messages - Array of message objects
 * @returns Array of created message objects
 */
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

/**
 * Get all messages for a session
 * @param sessionId - UUID of session
 * @param redactedOnly - If true, only return redacted content
 * @returns Array of message objects
 */
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

/**
 * Get message count for a session
 * @param sessionId - UUID of session
 * @returns Message count
 */
export async function getSessionMessageCount(sessionId: string): Promise<number> {
  const result = await pool.query<{ count: string }>(
    'SELECT COUNT(*) as count FROM messages WHERE session_id = $1',
    [sessionId]
  );
  return parseInt(result.rows[0].count);
}

/**
 * Update a message (either content or content_redacted based on role)
 * @param messageId - Message ID
 * @param newContent - Updated message content
 * @param fieldToUpdate - Either 'content' or 'content_redacted'
 * @param editMetadata - Information about who edited and when
 * @returns Updated message object
 */
export async function updateMessage(
  messageId: number | string,
  newContent: string,
  fieldToUpdate: 'content' | 'content_redacted',
  editMetadata: Record<string, unknown>
): Promise<MessageRow> {
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
      // Researcher edit: update only content_redacted
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

/**
 * Delete a message (with validation to prevent deleting last message)
 * @param messageId - Message ID
 * @returns Deleted message object
 */
export async function deleteMessage(messageId: number | string): Promise<MessageRow> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Get the message to find its session_id
    const messageResult = await client.query<{ session_id: string }>(
      'SELECT session_id FROM messages WHERE message_id = $1',
      [messageId]
    );

    if (messageResult.rows.length === 0) {
      throw new Error('Message not found');
    }

    const sessionId = messageResult.rows[0].session_id;

    // Check message count for the session
    const countResult = await client.query<{ count: string }>(
      'SELECT COUNT(*) as count FROM messages WHERE session_id = $1',
      [sessionId]
    );

    const messageCount = parseInt(countResult.rows[0].count);

    if (messageCount <= 1) {
      throw new Error('Cannot delete the last message in a session');
    }

    // Proceed with deletion
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

// ============================================
// ANALYTICS
// ============================================

/**
 * Get session statistics
 * @returns Statistics object
 */
export async function getSessionStats(): Promise<SessionStatsRow> {
  const result = await pool.query<SessionStatsRow>(
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
 * @returns Statistics object
 */
export async function getMessageStats(): Promise<MessageStatsRow> {
  const result = await pool.query<MessageStatsRow>(
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
 * @returns Array of language stats with counts and percentages
 */
export async function getLanguageStats(): Promise<LanguageStatRow[]> {
  const result = await pool.query<LanguageStatRow>(
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
 * @returns Array of voice stats with counts and percentages
 */
export async function getVoiceStats(): Promise<VoiceStatRow[]> {
  const result = await pool.query<VoiceStatRow>(
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
 * @returns Object containing language and voice statistics
 */
export async function getConfigStats(): Promise<{ languages: LanguageStatRow[]; voices: VoiceStatRow[] }> {
  const languageStats = await getLanguageStats();
  const voiceStats = await getVoiceStats();

  return {
    languages: languageStats,
    voices: voiceStats
  };
}

// ============================================
// SYSTEM CONFIGURATION
// ============================================

/**
 * Get AI model configuration from system_config
 * @returns Model name (defaults to 'gpt-realtime-mini')
 */
export async function getAiModel(): Promise<string> {
  try {
    const result = await pool.query<SystemConfigRow>(
      `SELECT config_value FROM system_config WHERE config_key = 'ai_model'`
    );

    if (result.rows.length > 0) {
      const config = result.rows[0].config_value;
      return config.model || 'gpt-realtime-mini';
    }

    // Default model if not configured
    return 'gpt-realtime-mini';
  } catch (error) {
    console.error('Failed to fetch AI model config:', error);
    // Fallback to default model
    return 'gpt-realtime-mini';
  }
}
