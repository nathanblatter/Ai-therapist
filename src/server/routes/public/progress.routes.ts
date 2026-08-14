// Participant progress home endpoints (ai-therapist-121) — the SELF-scoped
// "/api/me/*" surface shown between sessions: trends, worksheets, safety plan.
//
// Scoping rule: the user id ALWAYS comes from the authenticated session,
// never from params, query, headers, or body. There is deliberately no way to
// name another user on these routes. Content here is intentionally narrower
// than the admin participant profile — no memories, case profile, clinician
// notes, or crisis history (clinical framing stays admin-side).
import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { requireAuth } from '../../middleware/auth.js';
import {
  getOwnProgress,
  getUserLatestSafetyPlan,
  listUserWorksheetInstances,
  listUserAssignments,
  completeAssignment,
} from '../../db/index.js';

export default function progressRoutes(): Router {
  const router = Router();

  // Light limiter, same shape as the other public GET surfaces.
  const progressLimiter = rateLimit({ windowMs: 60_000, limit: 60, standardHeaders: true, legacyHeaders: false });

  // GET /api/me/progress - session count, trends, weekly continuity, safety-plan flag
  router.get('/api/me/progress', progressLimiter, requireAuth, async (req, res) => {
    try {
      const progress = await getOwnProgress(req.session.userId!);
      res.json(progress);
    } catch (error) {
      console.error('Error fetching own progress:', error);
      res.status(500).json({ error: 'Failed to fetch progress' });
    }
  });

  // GET /api/me/safety-plan - the participant's latest safety plan, or null
  router.get('/api/me/safety-plan', progressLimiter, requireAuth, async (req, res) => {
    try {
      const safetyPlan = await getUserLatestSafetyPlan(req.session.userId!);
      res.json({ safety_plan: safetyPlan });
    } catch (error) {
      console.error('Error fetching own safety plan:', error);
      res.status(500).json({ error: 'Failed to fetch safety plan' });
    }
  });

  // GET /api/me/worksheets - the participant's worksheet instances, newest first
  router.get('/api/me/worksheets', progressLimiter, requireAuth, async (req, res) => {
    try {
      const worksheets = await listUserWorksheetInstances(req.session.userId!);
      res.json({ worksheets });
    } catch (error) {
      console.error('Error fetching own worksheets:', error);
      res.status(500).json({ error: 'Failed to fetch worksheets' });
    }
  });

  // GET /api/me/assignments - open + recent practice assignments, newest first
  router.get('/api/me/assignments', progressLimiter, requireAuth, async (req, res) => {
    try {
      const assignments = await listUserAssignments(req.session.userId!, { limit: 50 });
      res.json({ assignments });
    } catch (error) {
      console.error('Error fetching own assignments:', error);
      res.status(500).json({ error: 'Failed to fetch assignments' });
    }
  });

  // POST /api/me/assignments/:id/complete {note?} - mark one of YOUR OWN
  // assignments done. completeAssignment is scoped by (id, user_id), so a
  // guessed id belonging to someone else just comes back null -> 404.
  router.post('/api/me/assignments/:id/complete', progressLimiter, requireAuth, async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (!Number.isInteger(id) || id <= 0) {
        return res.status(400).json({ error: 'Invalid assignment id' });
      }
      const note = typeof req.body?.note === 'string' && req.body.note.trim()
        ? req.body.note.trim().substring(0, 500)
        : null;
      const assignment = await completeAssignment(id, req.session.userId!, note);
      if (!assignment) {
        return res.status(404).json({ error: 'Assignment not found' });
      }
      res.json({ assignment });
    } catch (error) {
      console.error('Error completing assignment:', error);
      res.status(500).json({ error: 'Failed to complete assignment' });
    }
  });

  return router;
}
