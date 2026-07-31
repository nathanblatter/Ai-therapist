// Admin API for the session eval harness (therapist/researcher): read a
// session's LLM-judge quality scores and trigger an eval on demand. The
// heavy lifting lives in services/sessionEval.service.ts.
import { Router } from 'express';
import { requireRole } from '../../middleware/auth.js';
import { getSessionEval } from '../../db/index.js';

export default function evalsRoutes(): Router {
  const router = Router();

  // GET /admin/api/sessions/:sessionId/eval - latest eval for a session
  router.get('/admin/api/sessions/:sessionId/eval', requireRole('therapist', 'researcher'), async (req, res) => {
    try {
      const evalRow = await getSessionEval(req.params.sessionId);
      if (!evalRow) return res.status(404).json({ error: 'No eval for this session yet' });
      res.json({ eval: evalRow });
    } catch (err) {
      console.error('Failed to fetch session eval:', err);
      res.status(500).json({ error: 'Failed to fetch session eval' });
    }
  });

  // POST /admin/api/sessions/:sessionId/eval - run (or re-run with force) the
  // LLM judge for an ended session. Synchronous: the judge call takes a few
  // seconds and the admin UI wants the fresh scores back.
  router.post('/admin/api/sessions/:sessionId/eval', requireRole('therapist', 'researcher'), async (req, res) => {
    const { sessionId } = req.params;
    const force = req.body?.force === true;
    try {
      const { evaluateSession } = await import('../../services/sessionEval.service.js');
      const row = await evaluateSession(sessionId, { force });
      if (!row) {
        return res.status(400).json({
          error: 'Session could not be evaluated (not found, not ended, or empty transcript)',
        });
      }
      res.json({ eval: row });
    } catch (err) {
      console.error(`Eval run failed for ${sessionId}:`, err);
      res.status(500).json({
        error: 'Eval run failed',
        details: err instanceof Error ? err.message : String(err),
      });
    }
  });

  return router;
}
