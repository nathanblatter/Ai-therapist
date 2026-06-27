// Chat-only therapy endpoints (no auth required; anonymous users keyed by
// session id). Used when voice is disabled — routes to the GPT chat-completions
// flow instead of the Realtime API. Conversation state lives in
// services/chatTherapy.service.ts; persistence/redaction go through the db
// layer and the redaction queue.
import { Router } from 'express';
import {
  createSession,
  insertMessagesBatch,
  updateSessionStatus,
  getActiveSessionForUser,
  getSessionAccessInfo,
  getUserPreferredLanguage,
  setUserPreferredLanguage,
} from '../../db/index.js';
import { checkSessionLimits, getSystemPrompt } from '../../utils/sessionHelpers.js';
import { generateSessionNameAsync } from '../../services/sessionName.service.js';

export default function chatRoutes(): Router {
  const router = Router();

  // POST /api/chat/start - start a chat-only therapy session
  router.post('/api/chat/start', async (req, res) => {
    const userId: number | string = req.session?.userId ?? req.sessionID;
    const numericUserId: number | null = typeof userId === 'number' ? userId : null;

    try {
      // Enforce session limits (mirrors the /token endpoint).
      const userRole = req.session?.userRole || 'participant';
      const limitCheck = await checkSessionLimits(userId, userRole);
      if (!limitCheck.allowed) {
        return res.status(429).json({
          error: 'Session limit exceeded',
          reason: limitCheck.reason,
          minutes_remaining: limitCheck.reason === 'cooldown' ? limitCheck.minutes_remaining : undefined,
        });
      }

      // One active session per user at a time.
      const existingSession = await getActiveSessionForUser(userId);
      if (existingSession) {
        return res.status(200).json({
          message: 'Active session already exists',
          sessionId: existingSession.session_id,
          alreadyActive: true,
        });
      }

      // Language: request body wins, else the user's saved preference, else 'en'.
      let userLanguage = req.body?.language;
      if (!userLanguage && req.session?.userId) {
        userLanguage = (await getUserPreferredLanguage(userId)) || 'en';
      } else {
        userLanguage = userLanguage || 'en';
      }

      // Persist the language for next time (fire-and-forget).
      if (req.session?.userId) {
        setUserPreferredLanguage(userId, userLanguage).catch(err =>
          console.error('[ChatStart] Failed to save user language preference:', err));
      }

      const sessionId = `chat_${Date.now()}_${Math.random().toString(36).substring(7)}`;
      const systemPrompt = await getSystemPrompt(userLanguage, 'chat');

      const { initializeChatSession } = await import('../../services/chatTherapy.service.js');
      initializeChatSession(sessionId, systemPrompt);

      const username = req.session?.username || null;
      await createSession({
        sessionId,
        userId: numericUserId,
        sessionName: null, // generated from the conversation when the session ends
        status: 'active',
        sessionType: 'chat',
      });

      global.io.to('admin-broadcast').emit('session:started', {
        sessionId,
        userId,
        username,
        sessionType: 'chat',
        startedAt: new Date(),
      });

      console.log(`Chat-only session started: ${sessionId.substring(0, 12)}... for user ${userId}`);

      res.json({ success: true, sessionId, sessionType: 'chat', message: 'Chat therapy session started' });
    } catch (error: unknown) {
      console.error('Failed to start chat session:', error);
      res.status(500).json({
        error: 'Failed to start chat session',
        details: error instanceof Error ? error.message : String(error),
      });
    }
  });

  // POST /api/chat/message - send a message and get the AI response
  router.post('/api/chat/message', async (req, res) => {
    const { sessionId, message } = req.body;

    if (!sessionId || !message) {
      return res.status(400).json({ error: 'sessionId and message are required' });
    }

    try {
      const session = await getSessionAccessInfo(sessionId);
      if (!session) {
        return res.status(404).json({ error: 'Session not found' });
      }
      if (session.status !== 'active') {
        return res.status(400).json({ error: 'Session is not active' });
      }
      if (session.session_type !== 'chat') {
        return res.status(400).json({ error: 'Session is not a chat-only session' });
      }

      // Ownership check.
      const userId = req.session?.userId || req.sessionID;
      if (session.user_id !== userId) {
        return res.status(403).json({ error: 'Unauthorized: You do not own this session' });
      }

      const { sendMessage } = await import('../../services/chatTherapy.service.js');
      const aiResponse = await sendMessage(sessionId, message);

      // Persist both turns; content_redacted is filled in once per session at
      // session end (see sessionRedaction.service), not per message.
      await insertMessagesBatch([
        { session_id: sessionId, role: 'user', message_type: 'text', content: message, content_redacted: null },
        { session_id: sessionId, role: 'assistant', message_type: 'text', content: aiResponse, content_redacted: null },
      ]);

      // Live-monitoring events.
      global.io.to(`session:${sessionId}`).emit('message:new', { sessionId, role: 'user', message, timestamp: new Date() });
      global.io.to(`session:${sessionId}`).emit('message:new', { sessionId, role: 'assistant', message: aiResponse, timestamp: new Date() });

      console.log(`[ChatTherapy] Message exchanged for session ${sessionId.substring(0, 12)}...`);

      res.json({ success: true, response: aiResponse, sessionId });
    } catch (error: unknown) {
      console.error('Failed to process chat message:', error);
      res.status(500).json({
        error: 'Failed to process message',
        details: error instanceof Error ? error.message : String(error),
      });
    }
  });

  // POST /api/chat/end - end a chat therapy session
  router.post('/api/chat/end', async (req, res) => {
    const { sessionId } = req.body;

    if (!sessionId) {
      return res.status(400).json({ error: 'sessionId is required' });
    }

    try {
      const session = await getSessionAccessInfo(sessionId);
      if (!session) {
        return res.status(404).json({ error: 'Session not found' });
      }

      // Ownership check.
      const userId = req.session?.userId || req.sessionID;
      if (session.user_id !== userId) {
        return res.status(403).json({ error: 'Unauthorized: You do not own this session' });
      }

      // Idempotent end.
      if (session.status === 'ended') {
        console.log(`Chat session ${sessionId} already ended, returning existing data (idempotent)`);
        return res.status(200).json({ ...session, alreadyEnded: true, message: 'Session was already ended' });
      }

      const { endChatSession } = await import('../../services/chatTherapy.service.js');
      endChatSession(sessionId);

      const updatedSession = await updateSessionStatus(sessionId, 'ended', 'user');

      // Redact the whole session in one batched job (fire-and-forget).
      import('../../services/sessionRedaction.service.js')
        .then(m => m.redactSession(sessionId))
        .catch(e => console.error('[Redaction] session redaction failed:', e));

      global.io.to('admin-broadcast').emit('session:ended', { sessionId, endedBy: 'user', endedAt: new Date() });
      global.io.to(`session:${sessionId}`).emit('session:ended', { sessionId, endedAt: new Date() });

      // Auto-name from the conversation in the background.
      generateSessionNameAsync(sessionId);

      console.log(`Chat session ${sessionId.substring(0, 12)}... ended by user`);

      res.json({ success: true, message: 'Chat session ended', session: updatedSession });
    } catch (error: unknown) {
      console.error('Failed to end chat session:', error);
      res.status(500).json({
        error: 'Failed to end session',
        details: error instanceof Error ? error.message : String(error),
      });
    }
  });

  return router;
}
