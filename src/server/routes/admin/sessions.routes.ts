// Admin session browser + message editing API (therapist/researcher): list
// active/all sessions, view a session's transcript, remotely end a session, and
// edit/delete sessions and messages. Read queries live in
// db/adminSessions.queries.ts; mutations reuse the db/ session helpers.
import { Router } from 'express';
import { requireRole } from '../../middleware/auth.js';
import {
  getActiveSessions,
  listSessions,
  countSessions,
  getSessionWithUser,
  getAdminSessionMessages,
  getRedactionStatus,
  getSession,
  updateSessionStatus,
  deleteSession,
  updateMessage,
  deleteMessage,
  type MessageContentColumn,
} from '../../db/index.js';
import { generateSessionNameAsync } from '../../services/sessionName.service.js';

// Split a comma-separated query param into a non-empty string[] (or null).
function parseList(value: unknown): string[] | null {
  if (!value) return null;
  return String(value).split(',').filter(Boolean);
}

export default function adminSessionsRoutes(): Router {
  const router = Router();

  // GET /admin/api/sessions/active - all active sessions (crisis-first)
  router.get('/admin/api/sessions/active', requireRole('therapist', 'researcher'), async (_req, res) => {
    try {
      const sessions = await getActiveSessions();
      res.json({ sessions });
    } catch (err) {
      console.error('Failed to fetch active sessions:', err);
      res.status(500).json({ error: 'Failed to fetch active sessions' });
    }
  });

  // POST /admin/api/sessions/:sessionId/end - remotely terminate a session
  router.post('/admin/api/sessions/:sessionId/end', requireRole('therapist', 'researcher'), async (req, res) => {
    try {
      const { sessionId } = req.params;

      const session = await getSession(sessionId);
      if (!session) {
        return res.status(404).json({ error: 'Session not found' });
      }

      // Idempotent: ending an already-ended session returns the existing data.
      if (session.status === 'ended') {
        console.log(`Admin: Session ${sessionId} already ended, returning existing data (idempotent)`);
        return res.status(200).json({ ...session, alreadyEnded: true, message: 'Session was already ended' });
      }

      const updatedSession = await updateSessionStatus(sessionId, 'ended', req.session.username);

      // Tear down the sideband observer cleanly on remote end.
      try {
        const { sidebandManager } = await import('../../services/sidebandManager.service.js');
        await sidebandManager.disconnect(sessionId);
      } catch (e) {
        console.error('[Sideband] cleanup on admin session end failed:', e);
      }

      // Notify admin dashboards and the participant's own session room.
      global.io.to('admin-broadcast').emit('session:ended', {
        sessionId,
        endedAt: new Date(),
        endedBy: req.session.username,
      });
      global.io.to(`session:${sessionId}`).emit('session:status', {
        status: 'ended',
        endedBy: req.session.username,
        remoteTermination: true,
      });

      // Auto-name the session in the background.
      generateSessionNameAsync(sessionId);

      console.log(`Admin ${req.session.username} remotely ended session ${sessionId}`);

      res.json({ ...updatedSession, message: 'Session ended successfully by admin', endedBy: req.session.username });
    } catch (err) {
      console.error('Failed to end session:', err);
      res.status(500).json({ error: 'Failed to end session' });
    }
  });

  // GET /admin/api/sessions - filtered, paginated session list
  router.get('/admin/api/sessions', requireRole('therapist', 'researcher'), async (req, res) => {
    const {
      search, startDate, endDate, minMessages, maxMessages,
      page = 1, limit = 50,
      voices, languages, durations, sessionTypes, statuses, endedBy,
      crisisFlagged, crisisSeverity,
    } = req.query;

    try {
      const pageNum = parseInt(String(page));
      const limitNum = parseInt(String(limit));
      const filters = {
        search: search ? String(search) : null,
        startDate: startDate ? String(startDate) : null,
        endDate: endDate ? String(endDate) : null,
        minMessages: minMessages ? parseInt(String(minMessages)) : null,
        maxMessages: maxMessages ? parseInt(String(maxMessages)) : null,
        limit: limitNum,
        offset: (pageNum - 1) * limitNum,
        voices: parseList(voices),
        languages: parseList(languages),
        durations: parseList(durations),
        sessionTypes: parseList(sessionTypes),
        statuses: parseList(statuses),
        endedBy: parseList(endedBy),
        crisisFlagged: crisisFlagged === 'true' ? true : crisisFlagged === 'false' ? false : null,
        crisisSeverity: crisisSeverity ? String(crisisSeverity) : null,
      };

      const [sessions, totalCount] = await Promise.all([
        listSessions(filters),
        countSessions(filters),
      ]);

      res.json({
        sessions,
        pagination: { page: pageNum, limit: limitNum, totalCount },
      });
    } catch (err) {
      console.error('Failed to fetch sessions:', err);
      res.status(500).json({ error: 'Failed to fetch sessions' });
    }
  });

  // GET /admin/api/sessions/:sessionId/redaction-status - redaction progress.
  // Registered before /:sessionId for clarity (paths don't actually overlap).
  router.get('/admin/api/sessions/:sessionId/redaction-status', requireRole('therapist', 'researcher'), async (req, res) => {
    const { sessionId } = req.params;
    try {
      const pendingCount = await getRedactionStatus(sessionId);
      res.json({ sessionId, pendingCount, allComplete: pendingCount === 0 });
    } catch (err) {
      console.error('Failed to check redaction status:', err);
      res.status(500).json({ error: 'Failed to check redaction status' });
    }
  });

  // GET /admin/api/sessions/:sessionId - full session transcript
  router.get('/admin/api/sessions/:sessionId', requireRole('therapist', 'researcher'), async (req, res) => {
    const { sessionId } = req.params;
    try {
      const session = await getSessionWithUser(sessionId);
      if (!session) {
        return res.status(404).json({ error: 'Session not found' });
      }

      const contentColumn: MessageContentColumn = req.session.userRole === 'therapist' ? 'content' : 'content_redacted';
      const messages = await getAdminSessionMessages(sessionId, contentColumn);

      res.json({ session, messages });
    } catch (err) {
      console.error('Failed to fetch session details:', err);
      res.status(500).json({ error: 'Failed to fetch session details' });
    }
  });

  // DELETE /admin/api/sessions/:sessionId - delete a session and its data
  router.delete('/admin/api/sessions/:sessionId', requireRole('therapist', 'researcher'), async (req, res) => {
    const { sessionId } = req.params;
    try {
      const deletedSession = await deleteSession(sessionId);
      res.json({
        success: true,
        message: `Session ${deletedSession.session_name || sessionId} deleted successfully`,
      });
    } catch (error: unknown) {
      if (error instanceof Error && error.message === 'Session not found') {
        return res.status(404).json({ error: 'Session not found' });
      }
      console.error('Failed to delete session:', error);
      res.status(500).json({ error: 'Failed to delete session' });
    }
  });

  // PUT /admin/api/messages/:messageId - edit a message's content
  router.put('/admin/api/messages/:messageId', requireRole('therapist', 'researcher'), async (req, res) => {
    const { messageId } = req.params;
    const { content } = req.body;

    if (!content || !content.trim()) {
      return res.status(400).json({ error: 'Message content cannot be empty' });
    }

    try {
      // Therapists edit raw content; researchers edit the redacted column.
      const fieldToUpdate: MessageContentColumn = req.session.userRole === 'therapist' ? 'content' : 'content_redacted';
      const editMetadata = {
        edited: true,
        edited_at: new Date().toISOString(),
        edited_by: req.session.username,
      };

      const updatedMessage = await updateMessage(messageId, content, fieldToUpdate, editMetadata);

      // Return the same shape as the GET endpoint (role-appropriate content).
      const formattedMessage = {
        message_id: updatedMessage.message_id,
        session_id: updatedMessage.session_id,
        role: updatedMessage.role,
        message_type: updatedMessage.message_type,
        message: updatedMessage[fieldToUpdate],
        extras: updatedMessage.metadata,
        created_at: updatedMessage.created_at,
      };

      res.json({ success: true, message: formattedMessage });
    } catch (error: unknown) {
      if (error instanceof Error && error.message === 'Message not found') {
        return res.status(404).json({ error: 'Message not found' });
      }
      console.error('Failed to update message:', error);
      res.status(500).json({ error: 'Failed to update message' });
    }
  });

  // DELETE /admin/api/messages/:messageId - delete a message
  router.delete('/admin/api/messages/:messageId', requireRole('therapist', 'researcher'), async (req, res) => {
    const { messageId } = req.params;
    try {
      const deletedMessage = await deleteMessage(messageId);
      res.json({ success: true, message: 'Message deleted successfully', deletedMessage });
    } catch (error: unknown) {
      if (error instanceof Error && error.message === 'Message not found') {
        return res.status(404).json({ error: 'Message not found' });
      }
      if (error instanceof Error && error.message === 'Cannot delete the last message in a session') {
        return res.status(400).json({ error: 'Cannot delete the last message in a session' });
      }
      console.error('Failed to delete message:', error);
      res.status(500).json({ error: 'Failed to delete message' });
    }
  });

  return router;
}
