import { Router } from 'express';
import { pool } from '../config/db.js';
import { requireAuth } from '../middleware/auth.js';
import { createSession, getSession, upsertSessionConfig, updateSessionStatus, getAiModel, insertMessagesBatch } from '../models/dbQueries.js';
import { generateSessionNameAsync } from '../services/sessionName.service.js';
import { getOpenAIKey } from '../config/secrets.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { checkSessionLimits, getSystemPrompt, sessionConfigDefault } from '../utils/sessionHelpers.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('sessions');

export default function sessionsRoutes() {
  const router = Router();

  // ALL /token - Get session token for OpenAI Realtime API
  router.all("/token", asyncHandler(async (req, res) => {
    const userId = req.session?.userId || null;
    const userRole = req.session?.userRole || null;
    const io = req.app.locals.io;
    const apiKey = req.app.locals.apiKey;

    // RATE LIMITING CHECK
    const limitCheck = await checkSessionLimits(userId, userRole);
    if (!limitCheck.allowed) {
      log.info({ userId, reason: limitCheck.reason }, 'Session limit exceeded');
      return res.status(429).json({
        error: 'rate_limit_exceeded',
        reason: limitCheck.reason,
        message: limitCheck.message,
        details: {
          limit: limitCheck.limit,
          current: limitCheck.current,
          cooldown_minutes: limitCheck.cooldown_minutes,
          minutes_remaining: limitCheck.minutes_remaining
        }
      });
    }

    // IDEMPOTENCY CHECK
    if (userId) {
      const { getActiveSessionForUser } = await import("../models/dbQueries.js");
      const existingSession = await getActiveSessionForUser(userId);

      if (existingSession) {
        log.info({ userId, sessionId: existingSession.session_id.substring(0, 12) + '...' }, 'Returning existing active session');
        return res.status(200).json({
          session: {
            id: existingSession.session_id,
            exists: true,
            created_at: existingSession.created_at
          },
          message: "Active session already exists. Please end current session before starting a new one."
        });
      }
    }

    // Get user settings
    let userVoice = req.body?.voice;
    let userLanguage = req.body?.language;

    log.debug({ voice: userVoice, language: userLanguage, userId }, 'Token request');

    if (!userVoice || !userLanguage) {
      try {
        const prefsResult = await pool.query(
          'SELECT preferred_voice, preferred_language FROM users WHERE userid = $1',
          [userId]
        );

        if (prefsResult.rows.length > 0) {
          userVoice = userVoice || prefsResult.rows[0].preferred_voice || 'cedar';
          userLanguage = userLanguage || prefsResult.rows[0].preferred_language || 'en';
        } else {
          userVoice = userVoice || 'cedar';
          userLanguage = userLanguage || 'en';
        }
      } catch (err) {
        log.error({ err }, 'Failed to load user preferences, using defaults');
        userVoice = userVoice || 'cedar';
        userLanguage = userLanguage || 'en';
      }
    }

    log.info({ voice: userVoice, language: userLanguage, userId }, 'Using session settings');

    // Save preferences (async, don't block)
    if (userId) {
      pool.query(
        'UPDATE users SET preferred_voice = $1, preferred_language = $2 WHERE userid = $3',
        [userVoice, userLanguage, userId]
      ).catch(err => log.error({ err }, 'Failed to save user preferences'));
    }

    const temperature = 0.8;
    const aiModel = await getAiModel();

    const { toolRegistry } = await import('../services/toolRegistry.service.js');
    const tools = toolRegistry.getAllToolDefinitions();

    const dynamicSessionConfig = JSON.stringify({
      session: {
        type: "realtime",
        tools,
        tool_choice: "auto",
        model: aiModel,
        instructions: await getSystemPrompt(userLanguage, 'realtime'),
        audio: {
          input: { transcription: { model: "whisper-1" } },
          output: { voice: userVoice },
        },
      },
    });

    log.info({ voice: userVoice, language: userLanguage, configLength: dynamicSessionConfig.length }, 'Sending session config to OpenAI');

    const response = await fetch(
      "https://api.openai.com/v1/realtime/client_secrets",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: dynamicSessionConfig,
      }
    );

    if (!response.ok) {
      const errorText = await response.text();
      log.error({ status: response.status, errorText }, 'OpenAI API error');
      throw new Error(`OpenAI API error: ${response.status} ${errorText}`);
    }

    const data = await response.json();
    log.debug({ data }, 'OpenAI response');

    if (!data || !data.session || !data.session.id) {
      log.error({ data }, 'Invalid OpenAI response structure');
      throw new Error("Invalid response from OpenAI API - missing session.id");
    }

    const sessionId = data.session.id;
    const username = req.session?.username || null;

    log.debug({ sessionId: sessionId.substring(0, 12) + '...', userId, username }, 'Creating therapy session');

    try {
      await pool.query(
        `INSERT INTO therapy_sessions (session_id, user_id, status, created_at, updated_at)
         VALUES ($1, $2, 'active', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
         ON CONFLICT (session_id) DO NOTHING`,
        [sessionId, userId]
      );
      log.info({ userId }, 'Therapy session created');

      io.to('admin-broadcast').emit('session:created', {
        sessionId, userId, username, status: 'active', created_at: new Date()
      });

      // Schedule auto-termination
      if (limitCheck.limits && limitCheck.limits.max_duration_minutes && !limitCheck.bypass) {
        const durationMs = limitCheck.limits.max_duration_minutes * 60 * 1000;
        setTimeout(async () => {
          try {
            const checkResult = await pool.query(
              'SELECT status FROM therapy_sessions WHERE session_id = $1',
              [sessionId]
            );

            if (checkResult.rows.length > 0 && checkResult.rows[0].status === 'active') {
              log.info({ sessionId, minutes: limitCheck.limits.max_duration_minutes }, 'Auto-terminating session');

              const { updateSessionStatus } = await import("../models/dbQueries.js");
              await updateSessionStatus(sessionId, 'ended', 'system');

              const { handleSessionEndRoomCleanup } = await import('./admin/rooms.routes.js');
              await handleSessionEndRoomCleanup(sessionId);

              io.to(`session:${sessionId}`).emit('session:status', {
                status: 'ended',
                endedBy: 'system',
                reason: 'duration_limit',
                message: `Your session has ended after ${limitCheck.limits.max_duration_minutes} minutes (maximum session duration).`,
                remoteTermination: true
              });

              io.to('admin-broadcast').emit('session:ended', {
                sessionId, endedAt: new Date(), endedBy: 'system', reason: 'duration_limit'
              });
            }
          } catch (err) {
            log.error({ err, sessionId }, 'Failed to auto-terminate session');
          }
        }, durationMs);

        log.info({ sessionId, minutes: limitCheck.limits.max_duration_minutes }, 'Session auto-terminate scheduled');
      }

      const sessionConfigObj = JSON.parse(dynamicSessionConfig);
      await upsertSessionConfig(sessionId, {
        voice: userVoice,
        modalities: ['text', 'audio'],
        instructions: sessionConfigObj.session?.instructions || null,
        turn_detection: sessionConfigObj.session?.turn_detection || null,
        tools: sessionConfigObj.session?.tools || null,
        temperature,
        max_response_output_tokens: sessionConfigObj.session?.max_response_output_tokens || 4096,
        language: userLanguage
      });
      log.info({ sessionId: sessionId.substring(0, 12) + '...', voice: userVoice, language: userLanguage }, 'Session configuration created');
    } catch (dbError) {
      log.error({ err: dbError }, 'Failed to create session in database');
    }

    const responseData = { ...data, session_limits: limitCheck.limits || null };
    res.json(responseData);
  }));

  // POST /api/chat/start
  router.post("/api/chat/start", asyncHandler(async (req, res) => {
    const userId = req.session?.userId || req.sessionID;
    const io = req.app.locals.io;

    const userRole = req.session?.userRole || 'participant';
    const limitCheck = await checkSessionLimits(userId, userRole);

    if (!limitCheck.allowed) {
      return res.status(429).json({
        error: 'Session limit exceeded',
        reason: limitCheck.reason,
        timeRemaining: limitCheck.timeRemaining
      });
    }

    const { getActiveSessionForUser } = await import("../models/dbQueries.js");
    const existingSession = await getActiveSessionForUser(userId);
    if (existingSession) {
      return res.status(200).json({
        message: "Active session already exists",
        sessionId: existingSession.session_id,
        alreadyActive: true
      });
    }

    let userLanguage = req.body?.language;

    if (!userLanguage && req.session?.userId) {
      try {
        const prefsResult = await pool.query(
          'SELECT preferred_language FROM users WHERE userid = $1',
          [userId]
        );
        if (prefsResult.rows.length > 0) {
          userLanguage = prefsResult.rows[0].preferred_language || 'en';
        } else {
          userLanguage = 'en';
        }
      } catch (err) {
        log.error({ err }, 'Failed to load user preferences, using default');
        userLanguage = 'en';
      }
    } else {
      userLanguage = userLanguage || 'en';
    }

    log.info({ language: userLanguage, userId }, 'Starting chat session');

    if (req.session?.userId) {
      pool.query(
        'UPDATE users SET preferred_language = $1 WHERE userid = $2',
        [userLanguage, userId]
      ).catch(err => log.error({ err }, 'Failed to save user language preference'));
    }

    const sessionId = `chat_${Date.now()}_${Math.random().toString(36).substring(7)}`;
    const systemPrompt = await getSystemPrompt(userLanguage, 'chat');

    const { initializeChatSession } = await import('../services/chatTherapy.service.js');
    initializeChatSession(sessionId, systemPrompt);

    const username = req.session?.username || null;
    await createSession({
      sessionId, userId, sessionName: null, status: 'active', sessionType: 'chat'
    });

    io.to('admin-broadcast').emit('session:started', {
      sessionId, userId, username, sessionType: 'chat', startedAt: new Date()
    });

    log.info({ sessionId: sessionId.substring(0, 12) + '...', userId }, 'Chat session started');

    res.json({
      success: true, sessionId, sessionType: 'chat', message: 'Chat therapy session started'
    });
  }));

  // POST /api/chat/message
  router.post("/api/chat/message", asyncHandler(async (req, res) => {
    const { sessionId, message } = req.body;
    const io = req.app.locals.io;

    if (!sessionId || !message) {
      return res.status(400).json({ error: 'sessionId and message are required' });
    }

    const sessionCheck = await pool.query(
      'SELECT status, user_id, session_type FROM therapy_sessions WHERE session_id = $1',
      [sessionId]
    );

    if (sessionCheck.rows.length === 0) {
      return res.status(404).json({ error: 'Session not found' });
    }

    const session = sessionCheck.rows[0];

    if (session.status !== 'active') {
      return res.status(400).json({ error: 'Session is not active' });
    }

    if (session.session_type !== 'chat') {
      return res.status(400).json({ error: 'Session is not a chat-only session' });
    }

    const userId = req.session?.userId || req.sessionID;
    if (session.user_id !== userId) {
      return res.status(403).json({ error: 'Unauthorized: You do not own this session' });
    }

    const { sendMessage } = await import('../services/chatTherapy.service.js');
    const aiResponse = await sendMessage(sessionId, message);

    const insertedMessages = await insertMessagesBatch([
      { session_id: sessionId, role: 'user', message_type: 'text', content: message, content_redacted: null },
      { session_id: sessionId, role: 'assistant', message_type: 'text', content: aiResponse, content_redacted: null }
    ]);

    const { queueRedactionBatch } = await import('../services/redactionQueue.service.js');
    const redactionJobs = insertedMessages.map(msg => ({
      messageId: msg.message_id, content: msg.content, sessionId: msg.session_id
    }));
    queueRedactionBatch(redactionJobs);
    log.info({ count: redactionJobs.length }, 'Queued chat messages for async redaction');

    io.to(`session:${sessionId}`).emit('message:new', {
      sessionId, role: 'user', message, timestamp: new Date()
    });
    io.to(`session:${sessionId}`).emit('message:new', {
      sessionId, role: 'assistant', message: aiResponse, timestamp: new Date()
    });

    log.info({ sessionId: sessionId.substring(0, 12) + '...' }, 'Chat message exchanged');

    res.json({ success: true, response: aiResponse, sessionId });
  }));

  // POST /api/chat/end
  router.post("/api/chat/end", asyncHandler(async (req, res) => {
    const { sessionId } = req.body;
    const io = req.app.locals.io;

    if (!sessionId) {
      return res.status(400).json({ error: 'sessionId is required' });
    }

    const sessionCheck = await pool.query(
      'SELECT status, user_id FROM therapy_sessions WHERE session_id = $1',
      [sessionId]
    );

    if (sessionCheck.rows.length === 0) {
      return res.status(404).json({ error: 'Session not found' });
    }

    const session = sessionCheck.rows[0];

    const userId = req.session?.userId || req.sessionID;
    if (session.user_id !== userId) {
      return res.status(403).json({ error: 'Unauthorized: You do not own this session' });
    }

    if (session.status === 'ended') {
      log.info({ sessionId }, 'Chat session already ended (idempotent)');
      return res.status(200).json({
        ...session, alreadyEnded: true, message: "Session was already ended"
      });
    }

    const { endChatSession } = await import('../services/chatTherapy.service.js');
    endChatSession(sessionId);

    const updatedSession = await updateSessionStatus(sessionId, 'ended', 'user');

    const { handleSessionEndRoomCleanup } = await import('./admin/rooms.routes.js');
    await handleSessionEndRoomCleanup(sessionId);

    io.to('admin-broadcast').emit('session:ended', {
      sessionId, endedBy: 'user', endedAt: new Date()
    });
    io.to(`session:${sessionId}`).emit('session:ended', {
      sessionId, endedAt: new Date()
    });

    generateSessionNameAsync(sessionId);

    log.info({ sessionId: sessionId.substring(0, 12) + '...' }, 'Chat session ended by user');

    res.json({ success: true, message: 'Chat session ended', session: updatedSession });
  }));

  // POST /api/sessions/create
  router.post("/api/sessions/create", asyncHandler(async (req, res) => {
    const userId = req.session?.userId || null;
    const { sessionName } = req.body;
    const session = await createSession(userId, sessionName);
    res.json(session);
  }));

  // GET /api/sessions
  router.get("/api/sessions", requireAuth, asyncHandler(async (req, res) => {
    const { getUserSessions } = await import("../models/dbQueries.js");
    const sessions = await getUserSessions(req.session.userId);
    res.json(sessions);
  }));

  // GET /api/sessions/:sessionId
  router.get("/api/sessions/:sessionId", asyncHandler(async (req, res) => {
    const { getSession, getSessionMessages, getSessionConfig } = await import("../models/dbQueries.js");
    const { sessionId } = req.params;
    const session = await getSession(sessionId);

    if (!session) {
      return res.status(404).json({ error: "Session not found" });
    }

    if (session.user_id && session.user_id !== req.session?.userId) {
      return res.status(403).json({ error: "Access denied" });
    }

    const messages = await getSessionMessages(sessionId, false);
    const config = await getSessionConfig(sessionId);

    res.json({ session, messages, config });
  }));

  // POST /api/sessions/:sessionId/end
  router.post("/api/sessions/:sessionId/end", asyncHandler(async (req, res) => {
    const { updateSessionStatus } = await import("../models/dbQueries.js");
    const { sessionId } = req.params;
    const io = req.app.locals.io;

    const session = await getSession(sessionId);
    if (!session) {
      return res.status(404).json({ error: "Session not found" });
    }

    if (session.user_id && session.user_id !== req.session?.userId) {
      return res.status(403).json({ error: "Access denied" });
    }

    if (session.status === 'ended') {
      log.info({ sessionId }, 'Session already ended (idempotent)');
      return res.status(200).json({
        ...session, alreadyEnded: true, message: "Session was already ended"
      });
    }

    const updatedSession = await updateSessionStatus(sessionId, 'ended', 'user');

    const { handleSessionEndRoomCleanup } = await import('./admin/rooms.routes.js');
    await handleSessionEndRoomCleanup(sessionId);

    io.to('admin-broadcast').emit('session:ended', {
      sessionId, endedAt: new Date(), endedBy: 'user'
    });
    io.to(`session:${sessionId}`).emit('session:status', {
      status: 'ended', endedBy: 'user'
    });

    generateSessionNameAsync(sessionId);

    res.json({ ...updatedSession, message: "Session ended successfully" });
  }));

  return router;
}
