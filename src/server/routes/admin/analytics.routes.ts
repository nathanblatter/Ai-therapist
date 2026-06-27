// Admin analytics dashboard API (therapist/researcher). Parses the dashboard's
// filter query params and shapes the aggregated metrics for the frontend; the
// heavy aggregation SQL lives in db/analytics.queries.ts.
import { Router } from 'express';
import { requireRole } from '../../middleware/auth.js';
import { getDashboardAnalytics } from '../../db/index.js';

// Split a comma-separated query param into a non-empty string[] (or null).
function parseList(value: unknown): string[] | null {
  if (!value) return null;
  return String(value).split(',').filter(Boolean);
}

export default function analyticsRoutes(): Router {
  const router = Router();

  // GET /admin/api/analytics - dashboard metrics
  router.get('/admin/api/analytics', requireRole('therapist', 'researcher'), async (req, res) => {
    const { startDate, endDate, voices, languages, sessionTypes, statuses, endedBy, crisisFlagged } = req.query;

    try {
      const data = await getDashboardAnalytics({
        startDate: startDate ? String(startDate) : null,
        endDate: endDate ? String(endDate) : null,
        voices: parseList(voices),
        languages: parseList(languages),
        sessionTypes: parseList(sessionTypes),
        statuses: parseList(statuses),
        endedBy: parseList(endedBy),
        crisisFlagged: crisisFlagged === 'true' ? true : crisisFlagged === 'false' ? false : null,
      });

      res.json({
        metrics: data.metrics || {},
        breakdown: data.breakdown || {},
        daily_trend: data.daily_trend || [],
        user_sessions: data.user_sessions || [],
        time_distribution: data.time_distribution || [],
        duration_distribution: data.duration_distribution || [],
        duration_trend: data.duration_trend || [],
        language_distribution: data.language_distribution || [],
        voice_distribution: data.voice_distribution || [],
        completion_patterns: data.completion_patterns || [],
        abandonment_stats: data.abandonment_stats || {},
        session_depth: data.session_depth || [],
        engagement_pace: data.engagement_pace || {},
        response_times: data.response_times || {},
        turn_taking: data.turn_taking || {},
      });
    } catch (err) {
      console.error('Failed to fetch analytics:', err);
      res.status(500).json({ error: 'Failed to fetch analytics' });
    }
  });

  return router;
}
