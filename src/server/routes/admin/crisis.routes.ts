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

      // Steer the live model too (ai-therapist-112): a manual flag used to be
      // record/alert only, leaving the model blind to the human's judgment.
      // No-ops when the session has no live sideband (chat, already ended).
      const { injectManualFlagGuidance } = await import('../../services/crisisIntervention.service.js');
      const steered = await injectManualFlagGuidance(sessionId, severity, riskScore, req.session.username!);

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
        modelSteered: steered,
      });
    } catch (err) {
      console.error('Failed to flag session as crisis:', err);
      res.status(500).json({ error: 'Failed to flag session' });
    }
  });

  // POST /admin/api/sessions/:sessionId/crisis/wind-down - gracefully end a
  // crisis session (ai-therapist-112). Asks the live model over the sideband
  // to surface crisis resources, close warmly, and call end_session itself;
  // hard-ends server-side after a grace window (immediately when no sideband).
  // Contrast with POST /admin/api/sessions/:id/end, which yanks the session
  // with no closure for the participant.
  router.post('/admin/api/sessions/:sessionId/crisis/wind-down', requireRole('therapist', 'researcher'), async (req, res) => {
    const { sessionId } = req.params;
    try {
      const { getSession } = await import('../../db/index.js');
      const session = await getSession(sessionId);
      if (!session) return res.status(404).json({ error: 'Session not found' });
      if (session.status !== 'active') {
        return res.status(400).json({ error: 'Session is not active' });
      }

      const { initiateCrisisWindDown } = await import('../../services/crisisIntervention.service.js');
      const { injected } = await initiateCrisisWindDown(sessionId, req.session.username!);

      global.io.to('admin-broadcast').emit('session:crisis-wind-down', {
        sessionId,
        initiatedBy: req.session.username,
        injected,
        at: new Date(),
      });

      res.json({
        success: true,
        injected,
        message: injected
          ? 'Model asked to share resources and close the session; hard-end backstop scheduled.'
          : 'No live sideband — session is being ended server-side now.',
      });
    } catch (err) {
      console.error('Failed to initiate crisis wind-down:', err);
      res.status(500).json({ error: 'Failed to initiate crisis wind-down' });
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

  // GET /admin/api/sessions/:sessionId/risk-history - the per-message risk
  // timeline for one session (scores, severity, and the stage-2 LLM's context
  // judgment + reasoning from score_factors). Drives SessionDetail's timeline.
  router.get('/admin/api/sessions/:sessionId/risk-history', requireRole('therapist', 'researcher'), async (req, res) => {
    try {
      const { getSessionRiskHistory } = await import('../../services/crisisDetection.service.js');
      const history = await getSessionRiskHistory(req.params.sessionId);
      res.json({ history });
    } catch (err) {
      console.error('Failed to fetch session risk history:', err);
      res.status(500).json({ error: 'Failed to fetch session risk history' });
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
