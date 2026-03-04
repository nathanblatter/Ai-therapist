import { Router } from 'express';
import { pool } from '../../config/db.js';
import { requireRole } from '../../middleware/auth.js';
import { asyncHandler } from '../../utils/asyncHandler.js';
import { createLogger } from '../../utils/logger.js';

const log = createLogger('admin:crisis');

export default function adminCrisisRoutes() {
  const router = Router();

  // POST /admin/api/sessions/:sessionId/crisis/flag - Manually flag session as crisis
  router.post('/admin/api/sessions/:sessionId/crisis/flag', requireRole('therapist', 'researcher'), asyncHandler(async (req, res) => {
    const { sessionId } = req.params;
    const { severity, notes } = req.body;

    // Validate severity
    if (!['low', 'medium', 'high'].includes(severity)) {
      return res.status(400).json({ error: 'Invalid severity. Must be low, medium, or high.' });
    }

    const { flagSessionCrisis, logInterventionAction } = await import('../../services/crisisDetection.service.js');

    // Check if session exists
    const sessionCheck = await pool.query(
      'SELECT session_id FROM therapy_sessions WHERE session_id = $1',
      [sessionId]
    );

    if (sessionCheck.rows.length === 0) {
      return res.status(404).json({ error: 'Session not found' });
    }

    // Calculate risk score based on severity
    const riskScoreMap = { low: 25, medium: 50, high: 85 };
    const riskScore = riskScoreMap[severity];

    // Flag the session
    await flagSessionCrisis(
      sessionId,
      severity,
      riskScore,
      req.session.username,
      'manual',
      null,
      [],
      notes || 'Manually flagged by admin'
    );

    // Log intervention
    await logInterventionAction(sessionId, 'manual_flag', {
      riskScore,
      severity,
      flaggedBy: req.session.username,
      notes
    });

    // Emit Socket.io event
    global.io.to('admin-broadcast').emit('session:crisis-flagged', {
      sessionId,
      severity,
      riskScore,
      flaggedBy: req.session.username,
      flaggedAt: new Date(),
      message: `Session manually flagged as ${severity} risk by ${req.session.username}`
    });

    log.info({ sessionId, severity, adminUsername: req.session.username }, 'Session manually flagged for crisis');

    res.json({
      success: true,
      message: 'Session flagged as crisis',
      sessionId,
      severity,
      riskScore,
      flaggedBy: req.session.username,
      flaggedAt: new Date()
    });
  }));

  // DELETE /admin/api/sessions/:sessionId/crisis/flag - Unflag session
  router.delete('/admin/api/sessions/:sessionId/crisis/flag', requireRole('therapist', 'researcher'), asyncHandler(async (req, res) => {
    const { sessionId } = req.params;
    const { notes } = req.body;

    const { unflagSessionCrisis } = await import('../../services/crisisDetection.service.js');

    // Check if session exists
    const sessionCheck = await pool.query(
      'SELECT session_id, crisis_flagged FROM therapy_sessions WHERE session_id = $1',
      [sessionId]
    );

    if (sessionCheck.rows.length === 0) {
      return res.status(404).json({ error: 'Session not found' });
    }

    if (!sessionCheck.rows[0].crisis_flagged) {
      return res.status(400).json({ error: 'Session is not flagged as crisis' });
    }

    // Unflag the session
    await unflagSessionCrisis(
      sessionId,
      req.session.username,
      notes || 'Manually unflagged by admin'
    );

    // Emit Socket.io event
    global.io.to('admin-broadcast').emit('session:crisis-unflagged', {
      sessionId,
      unflaggedBy: req.session.username,
      unflaggedAt: new Date(),
      message: `Crisis flag removed by ${req.session.username}`
    });

    log.info({ sessionId, adminUsername: req.session.username }, 'Session unflagged');

    res.json({
      success: true,
      message: 'Crisis flag removed',
      sessionId,
      unflaggedBy: req.session.username,
      unflaggedAt: new Date()
    });
  }));

  // GET /admin/api/crisis/all - Get all crisis management data (comprehensive view)
  router.get('/admin/api/crisis/all', requireRole('therapist', 'researcher'), asyncHandler(async (req, res) => {
    log.info('Fetching all crisis management data');

    // Fetch all crisis-related data in parallel
    const [clinicalReviews, crisisEvents, humanHandoffs, interventionActions, riskScoreHistory] = await Promise.all([
      // Clinical Reviews
      pool.query(`
        SELECT
          cr.*,
          ts.session_name
        FROM clinical_reviews cr
        LEFT JOIN therapy_sessions ts ON cr.session_id = ts.session_id
        ORDER BY cr.requested_at DESC
        LIMIT 500
      `),

      // Crisis Events
      pool.query(`
        SELECT
          ce.*,
          ts.session_name
        FROM crisis_events ce
        LEFT JOIN therapy_sessions ts ON ce.session_id = ts.session_id
        ORDER BY ce.created_at DESC
        LIMIT 500
      `),

      // Human Handoffs
      pool.query(`
        SELECT
          hh.*,
          ts.session_name
        FROM human_handoffs hh
        LEFT JOIN therapy_sessions ts ON hh.session_id = ts.session_id
        ORDER BY hh.initiated_at DESC
        LIMIT 500
      `),

      // Intervention Actions
      pool.query(`
        SELECT
          ia.*,
          ts.session_name
        FROM intervention_actions ia
        LEFT JOIN therapy_sessions ts ON ia.session_id = ts.session_id
        ORDER BY ia.performed_at DESC
        LIMIT 500
      `),

      // Risk Score History
      pool.query(`
        SELECT
          rsh.*,
          ts.session_name
        FROM risk_score_history rsh
        LEFT JOIN therapy_sessions ts ON rsh.session_id = ts.session_id
        ORDER BY rsh.calculated_at DESC
        LIMIT 1000
      `)
    ]);

    log.info('Successfully fetched all crisis data');
    res.json({
      clinicalReviews: clinicalReviews.rows,
      crisisEvents: crisisEvents.rows,
      humanHandoffs: humanHandoffs.rows,
      interventionActions: interventionActions.rows,
      riskScoreHistory: riskScoreHistory.rows
    });
  }));

  // GET /admin/api/crisis/events - Get crisis events (all or by sessionId)
  router.get('/admin/api/crisis/events', requireRole('therapist', 'researcher'), asyncHandler(async (req, res) => {
    const { sessionId } = req.query;

    let result;
    if (sessionId) {
      const { getSessionCrisisEvents } = await import('../../services/crisisDetection.service.js');
      const events = await getSessionCrisisEvents(sessionId);
      result = { events };
    } else {
      // Get all crisis events
      const queryResult = await pool.query(`
        SELECT
          ce.*,
          ts.session_name,
          u.username
        FROM crisis_events ce
        LEFT JOIN therapy_sessions ts ON ce.session_id = ts.session_id
        LEFT JOIN users u ON ts.user_id = u.userid
        ORDER BY ce.created_at DESC
        LIMIT 100
      `);
      result = { events: queryResult.rows };
    }

    res.json(result);
  }));

  // GET /admin/api/crisis/active - Get all active crisis sessions
  router.get('/admin/api/crisis/active', requireRole('therapist', 'researcher'), asyncHandler(async (req, res) => {
    const { getActiveCrisisSessions } = await import('../../services/crisisDetection.service.js');
    const sessions = await getActiveCrisisSessions();

    res.json({ sessions });
  }));

  return router;
}
