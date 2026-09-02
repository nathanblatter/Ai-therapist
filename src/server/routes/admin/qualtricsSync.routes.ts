// Researcher-triggered Qualtrics response sync (ai-therapist-149).
//   POST /admin/api/qualtrics/sync — pull all configured study surveys from
//   the Qualtrics export API into qualtrics_responses and report per-survey
//   counts. 503 when the integration is not configured (env-gated like the
//   participant-facing /join-study route).
import { Router } from 'express';
import { requireRole } from '../../middleware/auth.js';
import { getQualtricsSyncConfig, syncAllSurveys } from '../../services/qualtricsSync.service.js';

export default function qualtricsSyncRoutes(): Router {
  const router = Router();

  router.post('/admin/api/qualtrics/sync', requireRole('researcher'), async (_req, res) => {
    const config = getQualtricsSyncConfig();
    if (!config) {
      return res.status(503).json({
        error: 'Qualtrics integration is not configured (QUALTRICS_API_TOKEN + survey ids).',
      });
    }
    try {
      const results = await syncAllSurveys(config);
      const failed = results.filter((r) => r.error);
      res.status(failed.length === results.length && results.length > 0 ? 502 : 200).json({
        success: failed.length === 0,
        results,
      });
    } catch (error) {
      console.error('[QualtricsSync] sync run failed:', error);
      res.status(500).json({ error: 'Sync failed' });
    }
  });

  return router;
}
