// Session insights admin API: memory summary + AI-drafted SOAP note review.
// Therapist-only — both artifacts are derived from unredacted content, which
// researchers must not see.
import { Router } from 'express';
import { requireRole } from '../../middleware/auth.js';
import { requireClientAccess, requireSessionClientAccess } from '../../middleware/caseload.js';
import {
  getSessionInsights,
  markSoapReviewed,
  getSessionSafetyPlan,
  getSessionScaleResponses,
  setSessionNotesForNextSession,
  setUserRiskContextEnabled,
} from '../../db/index.js';

export default function insightsRoutes(): Router {
  const router = Router();

  // GET /admin/api/sessions/:sessionId/insights
  router.get('/admin/api/sessions/:sessionId/insights', requireRole('therapist'), requireSessionClientAccess(), async (req, res) => {
    try {
      const [insights, safetyPlan, scaleResponses] = await Promise.all([
        getSessionInsights(req.params.sessionId),
        getSessionSafetyPlan(req.params.sessionId),
        getSessionScaleResponses(req.params.sessionId),
      ]);
      if (!insights && !safetyPlan && scaleResponses.length === 0) {
        return res.status(404).json({ error: 'No insights for this session (yet)' });
      }
      res.json({ ...(insights ?? {}), safety_plan: safetyPlan, scale_responses: scaleResponses });
    } catch (err) {
      console.error('Failed to fetch session insights:', err);
      res.status(500).json({ error: 'Failed to fetch session insights' });
    }
  });

  // POST /admin/api/sessions/:sessionId/insights/review - mark SOAP note reviewed
  router.post('/admin/api/sessions/:sessionId/insights/review', requireRole('therapist'), requireSessionClientAccess(), async (req, res) => {
    try {
      const ok = await markSoapReviewed(req.params.sessionId, req.session.username ?? 'unknown');
      if (!ok) {
        return res.status(404).json({ error: 'No insights for this session' });
      }
      res.json({ success: true });
    } catch (err) {
      console.error('Failed to mark SOAP note reviewed:', err);
      res.status(500).json({ error: 'Failed to mark SOAP note reviewed' });
    }
  });

  // POST /admin/api/sessions/:sessionId/insights/regenerate
  router.post('/admin/api/sessions/:sessionId/insights/regenerate', requireRole('therapist'), requireSessionClientAccess(), async (req, res) => {
    try {
      const { generateSessionInsights } = await import('../../services/sessionInsights.service.js');
      // Force regeneration by bypassing the idempotency skip: clear first.
      const { pool } = await import('../../config/db.js');
      await pool.query('DELETE FROM session_insights WHERE session_id = $1', [req.params.sessionId]);
      await generateSessionInsights(req.params.sessionId);
      const insights = await getSessionInsights(req.params.sessionId);
      if (!insights) {
        return res.status(422).json({ error: 'Session has no conversation content to analyze' });
      }
      res.json(insights);
    } catch (err) {
      console.error('Failed to regenerate session insights:', err);
      res.status(500).json({ error: 'Failed to regenerate session insights' });
    }
  });

  // POST /admin/api/sessions/:sessionId/insights/notes - therapist guidance for the participant's NEXT session
  router.post('/admin/api/sessions/:sessionId/insights/notes', requireRole('therapist'), requireSessionClientAccess(), async (req, res) => {
    try {
      const notes = typeof req.body?.notes === 'string' ? req.body.notes.trim().substring(0, 1000) : '';
      const ok = await setSessionNotesForNextSession(req.params.sessionId, notes, req.session.username ?? 'unknown');
      if (!ok) {
        return res.status(404).json({ error: 'No insights row for this session yet — generate insights first' });
      }
      res.json({ success: true, notes });
    } catch (err) {
      console.error('Failed to save notes for next session:', err);
      res.status(500).json({ error: 'Failed to save notes for next session' });
    }
  });

  // POST /admin/api/users/:userId/risk-context - clinical/study-staff opt-in for
  // injecting this user's prior-crisis history into their future sessions
  // (default off). Widened to therapist+researcher (ai-therapist-91): the Users
  // tab and /api/users are researcher-only, so a therapist-only write route
  // makes the toggle unusable from the only screen that lists participants.
  router.post('/admin/api/users/:userId/risk-context', requireRole('therapist', 'researcher'), requireClientAccess(), async (req, res) => {
    try {
      const userId = parseInt(req.params.userId, 10);
      if (!Number.isFinite(userId)) return res.status(400).json({ error: 'Invalid user id' });
      const enabled = req.body?.enabled === true;
      await setUserRiskContextEnabled(userId, enabled);
      res.json({ success: true, enabled });
    } catch (err) {
      console.error('Failed to update risk-context sharing flag:', err);
      res.status(500).json({ error: 'Failed to update risk-context sharing flag' });
    }
  });

  return router;
}
