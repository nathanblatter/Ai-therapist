// Admin API for the session eval harness (therapist/researcher): read a
// session's LLM-judge quality scores and trigger an eval on demand; capture
// human rubric ratings and compute judge calibration; acknowledge drift
// alerts. The heavy lifting lives in services/sessionEval.service.ts,
// services/evalCalibration.service.ts, and services/evalDrift.service.ts.
import { Router } from 'express';
import { requireRole } from '../../middleware/auth.js';
import { requireSessionClientAccess } from '../../middleware/caseload.js';
import {
  getSessionEval,
  getSession,
  getSessionHumanRatings,
  upsertSessionHumanRating,
  getCalibrationPromptVersions,
  acknowledgeDriftAlert,
  listHarnessRuns,
  getHarnessRun,
} from '../../db/index.js';

export default function evalsRoutes(): Router {
  const router = Router();

  // POST /admin/api/harness/run - start a simulation-eval run from the admin
  // UI (researcher-only: runs spend real API money). One at a time → 409.
  router.post('/admin/api/harness/run', requireRole('researcher'), async (req, res) => {
    try {
      const { startHarnessRun } = await import('../../services/harnessRunner.service.js');
      const { suite, scenarioId, variations } = req.body ?? {};
      const started = await startHarnessRun({
        suite,
        scenarioId: typeof scenarioId === 'string' && scenarioId ? scenarioId : undefined,
        variations: Number(variations) || 1,
        trigger: 'admin',
      });
      res.json({ started: true, ...started });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to start run';
      const inProgress = /already in progress/.test(message);
      if (!inProgress) console.error('Failed to start harness run:', err);
      res.status(inProgress ? 409 : /unknown suite/.test(message) ? 400 : 500).json({ error: message });
    }
  });

  // GET /admin/api/harness/status - live runner state + schedule
  router.get('/admin/api/harness/status', requireRole('therapist', 'researcher'), async (_req, res) => {
    try {
      const { getRunnerStatus, getHarnessSchedule } = await import('../../services/harnessRunner.service.js');
      res.json({ ...getRunnerStatus(), schedule: await getHarnessSchedule() });
    } catch (err) {
      console.error('Failed to fetch harness status:', err);
      res.status(500).json({ error: 'Failed to fetch harness status' });
    }
  });

  // PUT /admin/api/harness/schedule - nightly-run schedule (researcher-only)
  router.put('/admin/api/harness/schedule', requireRole('researcher'), async (req, res) => {
    try {
      const { setHarnessSchedule } = await import('../../services/harnessRunner.service.js');
      const schedule = await setHarnessSchedule(req.body, req.session?.username ?? 'researcher');
      res.json({ schedule });
    } catch (err) {
      console.error('Failed to save harness schedule:', err);
      res.status(500).json({ error: 'Failed to save harness schedule' });
    }
  });

  // GET /admin/api/harness/runs - simulation-eval run list (Simulation Runs
  // panel, ai-therapist-124 phase 3). Newest first.
  router.get('/admin/api/harness/runs', requireRole('therapist', 'researcher'), async (req, res) => {
    try {
      const limit = Number(req.query.limit) || 50;
      res.json({ runs: await listHarnessRuns(limit) });
    } catch (err) {
      console.error('Failed to list harness runs:', err);
      res.status(500).json({ error: 'Failed to list harness runs' });
    }
  });

  // GET /admin/api/harness/runs/:runId - one run + per-scenario results
  router.get('/admin/api/harness/runs/:runId', requireRole('therapist', 'researcher'), async (req, res) => {
    try {
      const id = Number(req.params.runId);
      if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'Invalid run id' });
      const out = await getHarnessRun(id);
      if (!out) return res.status(404).json({ error: 'Run not found' });
      res.json(out);
    } catch (err) {
      console.error('Failed to fetch harness run:', err);
      res.status(500).json({ error: 'Failed to fetch harness run' });
    }
  });

  // GET /admin/api/sessions/:sessionId/eval - latest eval for a session
  router.get('/admin/api/sessions/:sessionId/eval', requireRole('therapist', 'researcher'), requireSessionClientAccess(), async (req, res) => {
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
  router.post('/admin/api/sessions/:sessionId/eval', requireRole('therapist', 'researcher'), requireSessionClientAccess(), async (req, res) => {
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
  router.get('/admin/api/sessions/:sessionId/human-ratings', requireRole('therapist', 'researcher'), requireSessionClientAccess(), async (req, res) => {
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
  router.put('/admin/api/sessions/:sessionId/human-rating', requireRole('therapist', 'researcher'), requireSessionClientAccess(), async (req, res) => {
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
