// Admin sideband control API (therapist/researcher): inspect sideband
// connection state and push live instruction updates / disconnects to an active
// session. The sidebandManager service is imported lazily because the feature
// is currently disabled (OpenAI returns 404 for WebRTC sessions).
import { Router } from 'express';
import { requireRole } from '../../middleware/auth.js';
import { getActiveSidebandSessions, logSidebandAction } from '../../db/index.js';

export default function sidebandRoutes(): Router {
  const router = Router();

  // POST /admin/api/sessions/:sessionId/update-instructions - update AI instructions mid-session
  router.post('/admin/api/sessions/:sessionId/update-instructions', requireRole('therapist', 'researcher'), async (req, res) => {
    const { sessionId } = req.params;
    const { instructions } = req.body;

    if (!instructions) {
      return res.status(400).json({ error: 'instructions field is required' });
    }

    try {
      const { sidebandManager } = await import('../../services/sidebandManager.service.js');

      if (!sidebandManager.isConnected(sessionId)) {
        return res.status(400).json({ error: 'No active sideband connection for this session' });
      }

      await sidebandManager.updateSession(sessionId, { instructions });

      global.io.to('admin-broadcast').emit('session:instructions-updated', {
        sessionId,
        updatedBy: req.session.username,
        timestamp: new Date(),
      });

      console.log(`Instructions updated for session ${sessionId} by ${req.session.username}`);

      res.json({ success: true, message: 'Instructions updated successfully' });
    } catch (error: unknown) {
      console.error('Failed to update instructions:', error);
      res.status(500).json({
        error: 'Failed to update instructions',
        details: error instanceof Error ? error.message : String(error),
      });
    }
  });

  // GET /admin/api/sideband/status - global sideband connection status
  router.get('/admin/api/sideband/status', requireRole('therapist', 'researcher'), async (_req, res) => {
    try {
      const { sidebandManager } = await import('../../services/sidebandManager.service.js');
      const activeSessions = sidebandManager.getActiveConnections();

      const rows = await getActiveSidebandSessions();
      const sessions = rows.map(session => ({
        ...session,
        connection_active: activeSessions.includes(session.session_id as string),
      }));

      res.json({
        total_active_sessions: rows.length,
        sideband_connected_count: sessions.filter(s => s.connection_active).length,
        sessions,
      });
    } catch (error: unknown) {
      console.error('Failed to fetch sideband status:', error);
      res.status(500).json({
        error: 'Failed to fetch sideband status',
        details: error instanceof Error ? error.message : String(error),
      });
    }
  });

  // POST /admin/api/sideband/update-session - update session instructions via sideband
  router.post('/admin/api/sideband/update-session', requireRole('therapist', 'researcher'), async (req, res) => {
    try {
      const { sessionId, instructions } = req.body;

      if (!sessionId || !instructions) {
        return res.status(400).json({ error: 'Missing required fields', details: 'sessionId and instructions are required' });
      }

      const { sidebandManager } = await import('../../services/sidebandManager.service.js');

      if (!sidebandManager.isConnected(sessionId)) {
        return res.status(400).json({ error: 'No active sideband connection', details: 'Session must have an active sideband connection' });
      }

      await sidebandManager.updateSession(sessionId, { instructions: instructions.trim() });

      await logSidebandAction(sessionId, 'Instructions updated via sideband', {
        admin_user: req.session.user?.username,
        action: 'update_instructions',
      });

      res.json({ success: true, message: 'Session instructions updated successfully' });
    } catch (error: unknown) {
      console.error('Failed to update session via sideband:', error);
      res.status(500).json({
        error: 'Failed to update session',
        details: error instanceof Error ? error.message : String(error),
      });
    }
  });

  // POST /admin/api/sideband/disconnect - disconnect a sideband connection
  router.post('/admin/api/sideband/disconnect', requireRole('therapist', 'researcher'), async (req, res) => {
    try {
      const { sessionId } = req.body;

      if (!sessionId) {
        return res.status(400).json({ error: 'Missing sessionId' });
      }

      const { sidebandManager } = await import('../../services/sidebandManager.service.js');

      if (!sidebandManager.isConnected(sessionId)) {
        return res.status(400).json({ error: 'No active sideband connection for this session' });
      }

      await sidebandManager.disconnect(sessionId);

      await logSidebandAction(sessionId, 'Sideband connection manually disconnected', {
        admin_user: req.session.user?.username,
        action: 'disconnect_sideband',
      });

      res.json({ success: true, message: 'Sideband connection disconnected successfully' });
    } catch (error: unknown) {
      console.error('Failed to disconnect sideband:', error);
      res.status(500).json({
        error: 'Failed to disconnect sideband connection',
        details: error instanceof Error ? error.message : String(error),
      });
    }
  });

  return router;
}
