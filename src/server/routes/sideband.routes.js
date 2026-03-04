import { Router } from 'express';
import { pool } from '../config/db.js';
import { requireRole } from '../middleware/auth.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('sideband');

export default function sidebandRoutes() {
  const router = Router();

  // POST /api/sessions/:sessionId/register-call
  router.post("/api/sessions/:sessionId/register-call", asyncHandler(async (req, res) => {
    const { sessionId } = req.params;
    const { call_id } = req.body;

    if (!call_id) {
      return res.status(400).json({ error: 'call_id is required' });
    }

    const sessionCheck = await pool.query(
      'SELECT status FROM therapy_sessions WHERE session_id = $1',
      [sessionId]
    );

    if (sessionCheck.rows.length === 0) {
      return res.status(404).json({ error: 'Session not found' });
    }

    if (sessionCheck.rows[0].status !== 'active') {
      return res.status(400).json({ error: 'Session is not active' });
    }

    await pool.query(
      'UPDATE therapy_sessions SET openai_call_id = $1 WHERE session_id = $2',
      [call_id, sessionId]
    );

    res.json({ success: true, message: 'Call registered', sessionId, call_id });
  }));

  // POST /admin/api/sessions/:sessionId/update-instructions
  router.post("/admin/api/sessions/:sessionId/update-instructions", requireRole('therapist', 'researcher'), asyncHandler(async (req, res) => {
    const { sessionId } = req.params;
    const { instructions } = req.body;
    const io = req.app.locals.io;

    if (!instructions) {
      return res.status(400).json({ error: 'instructions field is required' });
    }

    const { sidebandManager } = await import('../services/sidebandManager.service.js');

    if (!sidebandManager.isConnected(sessionId)) {
      return res.status(400).json({ error: 'No active sideband connection for this session' });
    }

    await sidebandManager.updateSession(sessionId, { instructions });

    io.to('admin-broadcast').emit('session:instructions-updated', {
      sessionId, updatedBy: req.session.username, timestamp: new Date()
    });

    log.info({ sessionId, updatedBy: req.session.username }, 'Instructions updated');

    res.json({ success: true, message: 'Instructions updated successfully' });
  }));

  // GET /admin/api/sideband/status
  router.get("/admin/api/sideband/status", requireRole('therapist', 'researcher'), asyncHandler(async (req, res) => {
    const { sidebandManager } = await import('../services/sidebandManager.service.js');
    const activeSessions = sidebandManager.getActiveConnections();

    const result = await pool.query(`
      SELECT
        session_id, openai_call_id, sideband_connected, sideband_connected_at,
        sideband_disconnected_at, sideband_error, status
      FROM therapy_sessions
      WHERE status = 'active'
      ORDER BY created_at DESC
    `);

    const sessions = result.rows.map(s => ({
      ...s, connection_active: activeSessions.includes(s.session_id)
    }));

    res.json({
      total_active_sessions: result.rows.length,
      sideband_connected_count: sessions.filter(s => s.connection_active).length,
      sessions
    });
  }));

  // POST /admin/api/sideband/update-session
  router.post("/admin/api/sideband/update-session", requireRole('therapist', 'researcher'), asyncHandler(async (req, res) => {
    const { sessionId, instructions } = req.body;

    if (!sessionId || !instructions) {
      return res.status(400).json({
        error: 'Missing required fields',
        details: 'sessionId and instructions are required'
      });
    }

    const { sidebandManager } = await import('../services/sidebandManager.service.js');

    if (!sidebandManager.isConnected(sessionId)) {
      return res.status(400).json({
        error: 'No active sideband connection',
        details: 'Session must have an active sideband connection'
      });
    }

    await sidebandManager.updateSession(sessionId, { instructions: instructions.trim() });

    await pool.query(`
      INSERT INTO messages (session_id, role, type, message, metadata)
      VALUES ($1, 'system', 'admin_action', 'Instructions updated via sideband', $2)
    `, [sessionId, JSON.stringify({
      admin_user: req.session.user?.username,
      action: 'update_instructions'
    })]);

    res.json({ success: true, message: 'Session instructions updated successfully' });
  }));

  // POST /admin/api/sideband/disconnect
  router.post("/admin/api/sideband/disconnect", requireRole('therapist', 'researcher'), asyncHandler(async (req, res) => {
    const { sessionId } = req.body;

    if (!sessionId) {
      return res.status(400).json({ error: 'Missing sessionId' });
    }

    const { sidebandManager } = await import('../services/sidebandManager.service.js');

    if (!sidebandManager.isConnected(sessionId)) {
      return res.status(400).json({ error: 'No active sideband connection for this session' });
    }

    await sidebandManager.disconnect(sessionId);

    await pool.query(`
      INSERT INTO messages (session_id, role, type, message, metadata)
      VALUES ($1, 'system', 'admin_action', 'Sideband connection manually disconnected', $2)
    `, [sessionId, JSON.stringify({
      admin_user: req.session.user?.username,
      action: 'disconnect_sideband'
    })]);

    res.json({ success: true, message: 'Sideband connection disconnected successfully' });
  }));

  return router;
}
