// Participant profile admin API (ai-therapist-110): the per-user drill-down
// behind the admin "View profile" page.
//   - GET /admin/api/users/:userId/profile  — the same memory/clinical bundle
//     that is injected into the AI prompt (therapist-only: unredacted clinical
//     content, same rule as the session-insights routes).
//   - GET /admin/api/users/:userId/sessions — that user's session history with
//     eval score + feedback rating (therapist or researcher, like the main
//     session browser).
import { Router } from 'express';
import { requireRole } from '../../middleware/auth.js';
import {
  getUserById,
  getUserProfileBundle,
  getSessionScoreExtras,
  listSessions,
  countSessions,
} from '../../db/index.js';

export default function participantProfileRoutes(): Router {
  const router = Router();

  // GET /admin/api/users/:userId/profile - full memory/clinical bundle
  router.get('/admin/api/users/:userId/profile', requireRole('therapist'), async (req, res) => {
    try {
      const userId = parseInt(req.params.userId, 10);
      if (!Number.isFinite(userId)) return res.status(400).json({ error: 'Invalid user id' });

      const user = await getUserById(userId);
      if (!user) return res.status(404).json({ error: 'User not found' });

      const bundle = await getUserProfileBundle(userId);
      res.json({
        user: {
          userid: user.userid,
          username: user.username,
          role: user.role,
          preferred_voice: user.preferred_voice ?? null,
          preferred_language: user.preferred_language ?? null,
          mfa_enabled: user.mfa_enabled ?? false,
          created_at: user.created_at ?? null,
        },
        ...bundle,
      });
    } catch (err) {
      console.error('Failed to fetch participant profile:', err);
      res.status(500).json({ error: 'Failed to fetch participant profile' });
    }
  });

  // GET /admin/api/users/:userId/sessions - per-user session history
  router.get('/admin/api/users/:userId/sessions', requireRole('therapist', 'researcher'), async (req, res) => {
    try {
      const userId = parseInt(req.params.userId, 10);
      if (!Number.isFinite(userId)) return res.status(400).json({ error: 'Invalid user id' });

      const pageNum = Math.max(1, parseInt(String(req.query.page ?? '1')) || 1);
      const limitNum = Math.min(100, Math.max(1, parseInt(String(req.query.limit ?? '25')) || 25));
      const filters = {
        search: null,
        startDate: null,
        endDate: null,
        minMessages: null,
        maxMessages: null,
        limit: limitNum,
        offset: (pageNum - 1) * limitNum,
        voices: null,
        languages: null,
        durations: null,
        sessionTypes: null,
        statuses: null,
        endedBy: null,
        crisisFlagged: null,
        crisisSeverity: null,
        userId,
      };

      const [sessions, totalCount] = await Promise.all([
        listSessions(filters),
        countSessions(filters),
      ]);

      const extras = await getSessionScoreExtras(sessions.map(s => String(s.session_id)));
      const extrasById = new Map(extras.map(e => [e.session_id, e]));
      const enriched = sessions.map(s => ({
        ...s,
        eval_score: extrasById.get(String(s.session_id))?.eval_score ?? null,
        feedback_rating: extrasById.get(String(s.session_id))?.feedback_rating ?? null,
      }));

      res.json({
        sessions: enriched,
        pagination: { page: pageNum, limit: limitNum, totalCount },
      });
    } catch (err) {
      console.error('Failed to fetch participant sessions:', err);
      res.status(500).json({ error: 'Failed to fetch participant sessions' });
    }
  });

  return router;
}
