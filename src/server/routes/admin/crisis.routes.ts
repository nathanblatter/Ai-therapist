// Admin crisis-management routes (therapist/researcher): flag/unflag sessions
// and read crisis dashboards. Heavy logic lives in crisisDetection.service.
import { Router } from 'express';
import { requireRole } from '../../middleware/auth.js';
import {
  sessionExists,
  getSessionCrisisFlag,
  getAllCrisisData,
  getAllCrisisEvents,
} from '../../db/index.js';

export default function crisisRoutes(): Router {
  const router = Router();

  // POST /admin/api/sessions/:sessionId/crisis/flag - manually flag a session
  router.post('/admin/api/sessions/:sessionId/crisis/flag', requireRole('therapist', 'researcher'), async (req, res) => {
    const { sessionId } = req.params;
    const { severity, notes } = req.body;

    if (!['low', 'medium', 'high'].includes(severity)) {
      return res.status(400).json({ error: 'Invalid severity. Must be low, medium, or high.' });
    }

    try {
      const { flagSessionCrisis, logInterventionAction } = await import('../../services/crisisDetection.service.js');

      if (!(await sessionExists(sessionId))) {
        return res.status(404).json({ error: 'Session not found' });
      }

      const riskScoreMap: Record<string, number> = { low: 25, medium: 50, high: 85 };
      const riskScore = riskScoreMap[severity];

      await flagSessionCrisis(
        sessionId,
        severity,
        riskScore,
        req.session.username!,
        'manual',
        null,
        [],
        notes || 'Manually flagged by admin'
      );

      await logInterventionAction(sessionId, 'manual_flag', {
        riskScore,
        severity,
        flaggedBy: req.session.username,
        notes,
      });

      global.io.to('admin-broadcast').emit('session:crisis-flagged', {
        sessionId,
        severity,
        riskScore,
        flaggedBy: req.session.username,
        flaggedAt: new Date(),
        message: `Session manually flagged as ${severity} risk by ${req.session.username}`,
      });

      res.json({
        success: true,
        message: 'Session flagged as crisis',
        sessionId,
        severity,
        riskScore,
        flaggedBy: req.session.username,
        flaggedAt: new Date(),
      });
    } catch (err) {
      console.error('Failed to flag session as crisis:', err);
      res.status(500).json({ error: 'Failed to flag session' });
    }
  });

  // DELETE /admin/api/sessions/:sessionId/crisis/flag - remove a crisis flag
  router.delete('/admin/api/sessions/:sessionId/crisis/flag', requireRole('therapist', 'researcher'), async (req, res) => {
    const { sessionId } = req.params;
    const { notes } = req.body;

    try {
      const { unflagSessionCrisis } = await import('../../services/crisisDetection.service.js');

      const flag = await getSessionCrisisFlag(sessionId);
      if (!flag) {
        return res.status(404).json({ error: 'Session not found' });
      }
      if (!flag.crisis_flagged) {
        return res.status(400).json({ error: 'Session is not flagged as crisis' });
      }

      await unflagSessionCrisis(sessionId, req.session.username!, notes || 'Manually unflagged by admin');

      global.io.to('admin-broadcast').emit('session:crisis-unflagged', {
        sessionId,
        unflaggedBy: req.session.username,
        unflaggedAt: new Date(),
        message: `Crisis flag removed by ${req.session.username}`,
      });

      res.json({
        success: true,
        message: 'Crisis flag removed',
        sessionId,
        unflaggedBy: req.session.username,
        unflaggedAt: new Date(),
      });
    } catch (err) {
      console.error('Failed to unflag session:', err);
      res.status(500).json({ error: 'Failed to unflag session' });
    }
  });

  // GET /admin/api/crisis/all - comprehensive crisis dashboard data
  router.get('/admin/api/crisis/all', requireRole('therapist', 'researcher'), async (_req, res) => {
    try {
      const data = await getAllCrisisData();
      res.json(data);
    } catch (err: unknown) {
      console.error('[Crisis API] Failed to fetch comprehensive crisis data:', err);
      const errMsg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: 'Failed to fetch crisis management data', details: errMsg });
    }
  });

  // GET /admin/api/crisis/events - crisis events (all, or for one session)
  router.get('/admin/api/crisis/events', requireRole('therapist', 'researcher'), async (req, res) => {
    const { sessionId } = req.query;

    try {
      if (sessionId) {
        const { getSessionCrisisEvents } = await import('../../services/crisisDetection.service.js');
        const events = await getSessionCrisisEvents(String(sessionId));
        res.json({ events });
      } else {
        const events = await getAllCrisisEvents();
        res.json({ events });
      }
    } catch (err) {
      console.error('Failed to fetch crisis events:', err);
      res.status(500).json({ error: 'Failed to fetch crisis events' });
    }
  });

  // GET /admin/api/crisis/active - active crisis sessions
  router.get('/admin/api/crisis/active', requireRole('therapist', 'researcher'), async (_req, res) => {
    try {
      const { getActiveCrisisSessions } = await import('../../services/crisisDetection.service.js');
      const sessions = await getActiveCrisisSessions();
      res.json({ sessions });
    } catch (err) {
      console.error('Failed to fetch active crisis sessions:', err);
      res.status(500).json({ error: 'Failed to fetch active crisis sessions' });
    }
  });

  return router;
}
