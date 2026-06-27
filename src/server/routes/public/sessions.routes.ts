// Public session management API: create/list/view/end a participant's own
// therapy sessions, plus register-call which attaches the OpenAI realtime call
// id. Session owners see their own unredacted content. Mutations reuse
// db/sessions.queries.ts + db/messages.queries.ts.
import { Router } from 'express';
import { requireAuth } from '../../middleware/auth.js';
import {
  createSession,
  getSession,
  getUserSessions,
  getSessionMessages,
  getSessionConfig,
  updateSessionStatus,
  getSessionAccessInfo,
  setSessionCallId,
} from '../../db/index.js';
import { generateSessionNameAsync } from '../../services/sessionName.service.js';

export default function sessionsRoutes(): Router {
  const router = Router();

  // POST /api/sessions/:sessionId/register-call - attach an OpenAI call id
  router.post('/api/sessions/:sessionId/register-call', async (req, res) => {
    const { sessionId } = req.params;
    const { call_id } = req.body;

    if (!call_id) {
      return res.status(400).json({ error: 'call_id is required' });
    }

    try {
      const session = await getSessionAccessInfo(sessionId);
      if (!session) {
        return res.status(404).json({ error: 'Session not found' });
      }
      if (session.status !== 'active') {
        return res.status(400).json({ error: 'Session is not active' });
      }

      await setSessionCallId(sessionId, call_id);

      // Sideband auto-connect is intentionally disabled (OpenAI returns 404 for
      // WebRTC sessions); we just record the call id here.
      res.json({ success: true, message: 'Call registered', sessionId, call_id });
    } catch (error: unknown) {
      console.error('Failed to establish sideband connection:', error);
      res.status(500).json({
        error: 'Failed to establish sideband connection',
        details: error instanceof Error ? error.message : String(error),
      });
    }
  });

  // POST /api/sessions/create - create a new therapy session
  router.post('/api/sessions/create', async (req, res) => {
    try {
      const userId = req.session?.userId || null;
      const { sessionName } = req.body;
      const session = await createSession(userId, sessionName);
      res.json(session);
    } catch (err) {
      console.error('Failed to create session:', err);
      res.status(500).json({ error: 'Failed to create session' });
    }
  });

  // GET /api/sessions - list the authenticated user's sessions
  router.get('/api/sessions', requireAuth, async (req, res) => {
    try {
      const sessions = await getUserSessions(req.session.userId!);
      res.json(sessions);
    } catch (err) {
      console.error('Failed to fetch sessions:', err);
      res.status(500).json({ error: 'Failed to fetch sessions' });
    }
  });

  // GET /api/sessions/:sessionId - full session detail (owner only)
  router.get('/api/sessions/:sessionId', async (req, res) => {
    try {
      const { sessionId } = req.params;
      const session = await getSession(sessionId);
      if (!session) {
        return res.status(404).json({ error: 'Session not found' });
      }
      if (session.user_id && session.user_id !== req.session?.userId) {
        return res.status(403).json({ error: 'Access denied' });
      }

      // Owners see their own unredacted content.
      const messages = await getSessionMessages(sessionId, false);
      const config = await getSessionConfig(sessionId);

      res.json({ session, messages, config });
    } catch (err) {
      console.error('Failed to fetch session details:', err);
      res.status(500).json({ error: 'Failed to fetch session details' });
    }
  });

  // POST /api/sessions/:sessionId/end - end a session (triggers auto-naming)
  router.post('/api/sessions/:sessionId/end', async (req, res) => {
    try {
      const { sessionId } = req.params;
      const session = await getSession(sessionId);
      if (!session) {
        return res.status(404).json({ error: 'Session not found' });
      }
      if (session.user_id && session.user_id !== req.session?.userId) {
        return res.status(403).json({ error: 'Access denied' });
      }

      // Idempotent end.
      if (session.status === 'ended') {
        console.log(`Session ${sessionId} already ended, returning existing data (idempotent)`);
        return res.status(200).json({ ...session, alreadyEnded: true, message: 'Session was already ended' });
      }

      const updatedSession = await updateSessionStatus(sessionId, 'ended', 'user');

      global.io.to('admin-broadcast').emit('session:ended', { sessionId, endedAt: new Date(), endedBy: 'user' });
      global.io.to(`session:${sessionId}`).emit('session:status', { status: 'ended', endedBy: 'user' });

      // Auto-name from the conversation in the background.
      generateSessionNameAsync(sessionId);

      res.json({ ...updatedSession, message: 'Session ended successfully' });
    } catch (err) {
      console.error('Failed to end session:', err);
      res.status(500).json({ error: 'Failed to end session' });
    }
  });

  return router;
}
