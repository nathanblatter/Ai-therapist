// Admin API for the session eval harness (therapist/researcher): read a
// session's LLM-judge quality scores and trigger an eval on demand; capture
// human rubric ratings and compute judge calibration; acknowledge drift
// alerts. The heavy lifting lives in services/sessionEval.service.ts,
// services/evalCalibration.service.ts, and services/evalDrift.service.ts.
import { Router } from 'express';
import { requireRole } from '../../middleware/auth.js';
import {
  getSessionEval,
  getSession,
  getSessionHumanRatings,
  upsertSessionHumanRating,
  getCalibrationPromptVersions,
  acknowledgeDriftAlert,
} from '../../db/index.js';

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

  // GET /admin/api/sessions/:sessionId/human-ratings - all human ratings for a
  // session (+ my_user_id so the UI can locate "my" rating).
  router.get('/admin/api/sessions/:sessionId/human-ratings', requireRole('therapist', 'researcher'), async (req, res) => {
    try {
      const ratings = await getSessionHumanRatings(req.params.sessionId);
      res.json({ ratings, my_user_id: req.session.userId });
    } catch (err) {
      console.error('Failed to fetch human ratings:', err);
      res.status(500).json({ error: 'Failed to fetch human ratings' });
    }
  });

  // PUT /admin/api/sessions/:sessionId/human-rating - upsert the calling rater's
  // rating on the six-dimension rubric for an ended session.
  router.put('/admin/api/sessions/:sessionId/human-rating', requireRole('therapist', 'researcher'), async (req, res) => {
    const { sessionId } = req.params;
    try {
      const session = await getSession(sessionId);
      if (!session) return res.status(400).json({ error: 'Session not found' });
      if (session.status !== 'ended') {
        return res.status(400).json({ error: 'Only ended sessions can be rated' });
      }

      const { validateHumanRubric, HUMAN_RUBRIC_VERSION } = await import(
        '../../services/evalCalibration.service.js'
      );
      const validation = validateHumanRubric(req.body);
      if (!validation.ok) return res.status(400).json({ error: validation.error });

      const rating = await upsertSessionHumanRating(
        sessionId,
        req.session.userId!,
        validation.rubric!,
        validation.overallNotes ?? null,
        HUMAN_RUBRIC_VERSION
      );
      res.json({ rating });
    } catch (err) {
      console.error(`Failed to save human rating for ${sessionId}:`, err);
      res.status(500).json({ error: 'Failed to save human rating' });
    }
  });

  // GET /admin/api/evals/calibration?promptVersion=v1 - judge-vs-human agreement.
  router.get('/admin/api/evals/calibration', requireRole('therapist', 'researcher'), async (req, res) => {
    try {
      const { computeCalibrationReport } = await import('../../services/evalCalibration.service.js');
      const { EVAL_PROMPT_VERSION } = await import('../../services/sessionEval.service.js');
      const promptVersion = req.query.promptVersion ? String(req.query.promptVersion) : EVAL_PROMPT_VERSION;
      const [report, availableVersions] = await Promise.all([
        computeCalibrationReport(promptVersion),
        getCalibrationPromptVersions(),
      ]);
      res.json({ report, available_prompt_versions: availableVersions });
    } catch (err) {
      console.error('Failed to compute calibration:', err);
      res.status(500).json({ error: 'Failed to compute calibration' });
    }
  });

  // POST /admin/api/evals/drift-alerts/:alertId/ack - acknowledge a drift alert.
  router.post('/admin/api/evals/drift-alerts/:alertId/ack', requireRole('therapist', 'researcher'), async (req, res) => {
    try {
      const alert = await acknowledgeDriftAlert(Number(req.params.alertId), req.session.userId!);
      if (!alert) return res.status(404).json({ error: 'Alert not found or already acknowledged' });
      res.json({ alert });
    } catch (err) {
      console.error('Failed to acknowledge drift alert:', err);
      res.status(500).json({ error: 'Failed to acknowledge drift alert' });
    }
  });

  return router;
}
