import { Router } from 'express';
import { pool } from '../../config/db.js';
import { requireRole } from '../../middleware/auth.js';
import { asyncHandler } from '../../utils/asyncHandler.js';
import { createLogger } from '../../utils/logger.js';
import { updateSessionStatus, getSession, deleteSession, updateMessage, deleteMessage } from '../../models/dbQueries.js';
import { generateSessionNameAsync } from '../../services/sessionName.service.js';
import { handleSessionEndRoomCleanup } from './rooms.routes.js';

const log = createLogger('admin:sessions');

export default function adminSessionsRoutes() {
  const router = Router();

  // GET /admin/api/sessions/active
  router.get('/admin/api/sessions/active', requireRole('therapist', 'researcher'), asyncHandler(async (req, res) => {
    log.info('Fetching active sessions');

    const result = await pool.query(
      `SELECT
        ts.session_id,
        ts.user_id,
        ts.session_name,
        u.username,
        ts.status,
        ts.created_at,
        ts.crisis_flagged,
        ts.crisis_severity,
        ts.crisis_risk_score,
        ts.crisis_flagged_at,
        ts.crisis_flagged_by,
        COUNT(m.message_id) as message_count,
        MAX(m.created_at) as last_activity,
        EXTRACT(EPOCH FROM (CURRENT_TIMESTAMP - ts.created_at)) as duration_seconds
      FROM therapy_sessions ts
      LEFT JOIN users u ON ts.user_id = u.userid
      LEFT JOIN messages m ON ts.session_id = m.session_id
      WHERE ts.status = 'active'
      GROUP BY ts.session_id, u.username
      ORDER BY ts.crisis_flagged DESC, ts.created_at DESC`
    );

    res.json({ sessions: result.rows });
  }));

  // POST /admin/api/sessions/:sessionId/end
  router.post('/admin/api/sessions/:sessionId/end', requireRole('therapist', 'researcher'), asyncHandler(async (req, res) => {
    const { sessionId } = req.params;
    const io = req.app.locals.io;
    const adminUsername = req.session.username;

    log.info({ sessionId, adminUsername }, 'Admin ending session');

    // Check if session exists
    const session = await getSession(sessionId);
    if (!session) {
      return res.status(404).json({ error: 'Session not found' });
    }

    // Idempotency check
    if (session.status === 'ended') {
      log.info({ sessionId }, 'Session already ended (idempotent)');
      return res.status(200).json({
        ...session,
        alreadyEnded: true,
        message: 'Session was already ended'
      });
    }

    // Update session status
    const updatedSession = await updateSessionStatus(sessionId, 'ended', adminUsername);

    // Clean up room assignments
    await handleSessionEndRoomCleanup(sessionId);

    // Emit socket events
    io.to('admin-broadcast').emit('session:ended', {
      sessionId,
      endedAt: new Date(),
      endedBy: adminUsername
    });
    io.to(`session:${sessionId}`).emit('session:status', {
      status: 'ended',
      endedBy: adminUsername,
      remoteTermination: true
    });

    // Generate session name asynchronously
    generateSessionNameAsync(sessionId);

    log.info({ sessionId, adminUsername }, 'Session ended by admin');

    res.json({
      ...updatedSession,
      message: "Session ended successfully by admin",
      endedBy: adminUsername
    });
  }));

  // GET /admin/api/sessions - List all sessions with filters
  router.get('/admin/api/sessions', requireRole('therapist', 'researcher'), asyncHandler(async (req, res) => {
    const {
      search,
      startDate,
      endDate,
      voices,
      languages,
      sessionTypes,
      statuses,
      endedBy,
      crisisFlagged,
      crisisSeverity,
      minMessages,
      maxMessages,
      durations,
      page = '1',
      limit = '50'
    } = req.query;

    log.info({ filters: req.query }, 'Listing sessions with filters');

    const offset = (parseInt(page) - 1) * parseInt(limit);

    // Parse comma-separated arrays
    const voiceArray = voices ? voices.split(',').filter(Boolean) : null;
    const languageArray = languages ? languages.split(',').filter(Boolean) : null;
    const sessionTypeArray = sessionTypes ? sessionTypes.split(',').filter(Boolean) : null;
    const statusArray = statuses ? statuses.split(',').filter(Boolean) : null;
    const endedByArray = endedBy ? endedBy.split(',').filter(Boolean) : null;
    const durationArray = durations ? durations.split(',').filter(Boolean) : null;

    // Convert crisisFlagged to boolean
    const crisisFlaggedBool = crisisFlagged === 'true' ? true : crisisFlagged === 'false' ? false : null;

    const params = [
      search || null,
      startDate || null,
      endDate || null,
      minMessages ? parseInt(minMessages) : null,
      maxMessages ? parseInt(maxMessages) : null,
      parseInt(limit),
      offset,
      voiceArray,
      languageArray,
      sessionTypeArray,
      statusArray,
      endedByArray,
      crisisFlaggedBool,
      crisisSeverity || null,
      durationArray
    ];

    // Main query with all filters
    const dataQuery = `
      WITH session_stats AS (
        SELECT
          ts.session_id, ts.session_name, ts.user_id, u.username, ts.status,
          ts.session_type, ts.created_at AS start_time, ts.ended_at AS end_time,
          ts.ended_by, ts.crisis_flagged, ts.crisis_severity, sc.voice, sc.language,
          EXTRACT(EPOCH FROM (ts.ended_at - ts.created_at)) AS duration_seconds,
          CASE
            WHEN EXTRACT(EPOCH FROM (ts.ended_at - ts.created_at)) < 300 THEN 'short'
            WHEN EXTRACT(EPOCH FROM (ts.ended_at - ts.created_at)) < 1800 THEN 'medium'
            ELSE 'long'
          END AS duration_category,
          COUNT(m.message_id) AS total_messages,
          COUNT(m.message_id) FILTER (WHERE m.role = 'user') AS user_messages,
          COUNT(m.message_id) FILTER (WHERE m.role = 'assistant') AS assistant_messages,
          COUNT(m.message_id) FILTER (WHERE m.message_type = 'voice') AS voice_messages,
          COUNT(m.message_id) FILTER (WHERE m.message_type = 'chat') AS chat_messages
        FROM therapy_sessions ts
        LEFT JOIN users u ON ts.user_id = u.userid
        LEFT JOIN session_configurations sc ON ts.session_id = sc.session_id
        LEFT JOIN messages m ON ts.session_id = m.session_id
        WHERE
          ($1::TEXT IS NULL OR ts.session_id::TEXT ILIKE '%' || $1 || '%' OR ts.session_name ILIKE '%' || $1 || '%' OR u.username ILIKE '%' || $1 || '%')
          AND ($2::TIMESTAMP IS NULL OR ts.created_at >= $2)
          AND ($3::TIMESTAMP IS NULL OR ts.created_at <= $3)
          AND ($8::TEXT[] IS NULL OR sc.voice = ANY($8))
          AND ($9::TEXT[] IS NULL OR sc.language = ANY($9))
          AND ($10::TEXT[] IS NULL OR ts.session_type = ANY($10))
          AND ($11::TEXT[] IS NULL OR ts.status = ANY($11))
          AND ($12::TEXT[] IS NULL OR ts.ended_by = ANY($12))
          AND ($13::BOOLEAN IS NULL OR ts.crisis_flagged = $13)
          AND ($14::TEXT IS NULL OR ts.crisis_severity = $14)
        GROUP BY ts.session_id, u.username, ts.ended_by, ts.session_type, ts.crisis_flagged, ts.crisis_severity, sc.voice, sc.language
      )
      SELECT * FROM session_stats
      WHERE
        ($4::INT IS NULL OR total_messages >= $4)
        AND ($5::INT IS NULL OR total_messages <= $5)
        AND ($15::TEXT[] IS NULL OR duration_category = ANY($15))
      ORDER BY start_time DESC
      LIMIT $6 OFFSET $7
    `;

    const dataResult = await pool.query(dataQuery, params);

    // Count query
    const countResult = await pool.query(`
      SELECT COUNT(DISTINCT ts.session_id) as total
      FROM therapy_sessions ts
      LEFT JOIN users u ON ts.user_id = u.userid
      LEFT JOIN session_configurations sc ON ts.session_id = sc.session_id
      WHERE
        ($1::TEXT IS NULL OR ts.session_id::TEXT ILIKE '%' || $1 || '%' OR ts.session_name ILIKE '%' || $1 || '%' OR u.username ILIKE '%' || $1 || '%')
        AND ($2::TIMESTAMP IS NULL OR ts.created_at >= $2)
        AND ($3::TIMESTAMP IS NULL OR ts.created_at <= $3)
        AND ($4::TEXT[] IS NULL OR sc.voice = ANY($4))
        AND ($5::TEXT[] IS NULL OR sc.language = ANY($5))
        AND ($6::TEXT[] IS NULL OR ts.session_type = ANY($6))
        AND ($7::TEXT[] IS NULL OR ts.status = ANY($7))
        AND ($8::TEXT[] IS NULL OR ts.ended_by = ANY($8))
        AND ($9::BOOLEAN IS NULL OR ts.crisis_flagged = $9)
        AND ($10::TEXT IS NULL OR ts.crisis_severity = $10)
    `, [
      search || null,
      startDate || null,
      endDate || null,
      voiceArray,
      languageArray,
      sessionTypeArray,
      statusArray,
      endedByArray,
      crisisFlaggedBool,
      crisisSeverity || null
    ]);

    res.json({
      sessions: dataResult.rows,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        totalCount: parseInt(countResult.rows[0].total)
      }
    });
  }));

  // GET /admin/api/sessions/:sessionId - Get full conversation
  router.get('/admin/api/sessions/:sessionId', requireRole('therapist', 'researcher'), asyncHandler(async (req, res) => {
    const { sessionId } = req.params;
    const userRole = req.session.userRole;

    log.info({ sessionId, userRole }, 'Fetching session details');

    // Get session metadata
    const sessionResult = await pool.query(
      `SELECT
        ts.*,
        u.username
      FROM therapy_sessions ts
      LEFT JOIN users u ON ts.user_id = u.userid
      WHERE ts.session_id = $1`,
      [sessionId]
    );

    if (sessionResult.rows.length === 0) {
      return res.status(404).json({ error: 'Session not found' });
    }

    // Determine content column based on role
    const contentColumn = userRole === 'therapist' ? 'content' : 'content_redacted';

    // Get messages
    const messagesResult = await pool.query(
      `SELECT
        message_id,
        session_id,
        role,
        message_type,
        ${contentColumn} as message,
        metadata as extras,
        created_at
      FROM messages
      WHERE session_id = $1
      ORDER BY created_at ASC`,
      [sessionId]
    );

    res.json({
      session: sessionResult.rows[0],
      messages: messagesResult.rows
    });
  }));

  // DELETE /admin/api/sessions/:sessionId - Delete session
  router.delete('/admin/api/sessions/:sessionId', requireRole('therapist', 'researcher'), asyncHandler(async (req, res) => {
    const { sessionId } = req.params;
    const adminUsername = req.session.username;

    log.info({ sessionId, adminUsername }, 'Admin deleting session');

    const deletedSession = await deleteSession(sessionId);

    log.info({ sessionId, adminUsername }, 'Session deleted by admin');

    res.json({
      success: true,
      message: `Session ${deletedSession.session_name || sessionId} deleted successfully`
    });
  }));

  // PUT /admin/api/messages/:messageId - Update a message
  router.put('/admin/api/messages/:messageId', requireRole('therapist', 'researcher'), asyncHandler(async (req, res) => {
    const { messageId } = req.params;
    const { content } = req.body;
    const userRole = req.session.userRole;
    const adminUsername = req.session.username;

    log.info({ messageId, userRole, adminUsername }, 'Admin updating message');

    if (!content || !content.trim()) {
      return res.status(400).json({ error: 'Message content cannot be empty' });
    }

    // Determine field to update based on role
    const fieldToUpdate = userRole === 'therapist' ? 'content' : 'content_redacted';

    // Create edit metadata
    const editMetadata = {
      edited: true,
      edited_at: new Date().toISOString(),
      edited_by: adminUsername
    };

    const updatedMessage = await updateMessage(messageId, content, fieldToUpdate, editMetadata);

    // Return message in same format as GET endpoint
    const contentField = userRole === 'therapist' ? 'content' : 'content_redacted';
    const formattedMessage = {
      message_id: updatedMessage.message_id,
      session_id: updatedMessage.session_id,
      role: updatedMessage.role,
      message_type: updatedMessage.message_type,
      message: updatedMessage[contentField],
      extras: updatedMessage.metadata,
      created_at: updatedMessage.created_at
    };

    log.info({ messageId, fieldToUpdate, adminUsername }, 'Message updated by admin');

    res.json({
      success: true,
      message: formattedMessage
    });
  }));

  // DELETE /admin/api/messages/:messageId - Delete a message
  router.delete('/admin/api/messages/:messageId', requireRole('therapist', 'researcher'), asyncHandler(async (req, res) => {
    const { messageId } = req.params;
    const adminUsername = req.session.username;

    log.info({ messageId, adminUsername }, 'Admin deleting message');

    const deletedMessage = await deleteMessage(messageId);

    log.info({ messageId, adminUsername }, 'Message deleted by admin');

    res.json({
      success: true,
      message: "Message deleted successfully",
      deletedMessage
    });
  }));

  // GET /admin/api/sessions/:sessionId/redaction-status
  router.get('/admin/api/sessions/:sessionId/redaction-status', requireRole('therapist', 'researcher'), asyncHandler(async (req, res) => {
    const { sessionId } = req.params;

    log.info({ sessionId }, 'Checking redaction status');

    const result = await pool.query(
      `SELECT COUNT(*) as pending_count
       FROM messages
       WHERE session_id = $1 AND content_redacted IS NULL`,
      [sessionId]
    );

    res.json({
      sessionId,
      pendingCount: parseInt(result.rows[0].pending_count),
      allComplete: result.rows[0].pending_count === '0'
    });
  }));

  return router;
}
