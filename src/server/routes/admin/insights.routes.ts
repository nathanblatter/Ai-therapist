// Session insights admin API: memory summary + AI-drafted SOAP note review.
// Therapist-only — both artifacts are derived from unredacted content, which
// researchers must not see.
import { Router } from 'express';
import { requireRole } from '../../middleware/auth.js';
import { getSessionInsights, markSoapReviewed } from '../../db/index.js';

export default function insightsRoutes(): Router {
  const router = Router();

  // GET /admin/api/sessions/:sessionId/insights
  router.get('/admin/api/sessions/:sessionId/insights', requireRole('therapist'), async (req, res) => {
    try {
      const insights = await getSessionInsights(req.params.sessionId);
      if (!insights) {
        return res.status(404).json({ error: 'No insights for this session (yet)' });
      }
      res.json(insights);
    } catch (err) {
      console.error('Failed to fetch session insights:', err);
      res.status(500).json({ error: 'Failed to fetch session insights' });
    }
  });

  // POST /admin/api/sessions/:sessionId/insights/review - mark SOAP note reviewed
  router.post('/admin/api/sessions/:sessionId/insights/review', requireRole('therapist'), async (req, res) => {
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
  router.post('/admin/api/sessions/:sessionId/insights/regenerate', requireRole('therapist'), async (req, res) => {
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

  return router;
}
