// Qualtrics response sync admin surface (ai-therapist-149).
//   POST /admin/api/qualtrics/sync   — trigger a sync now (also runs on the
//     background scheduler when QUALTRICS_SYNC_INTERVAL_MINUTES is set).
//   GET  /admin/api/qualtrics/status — config presence (booleans only, never
//     the token), scheduler + last-run state, per-survey linkage stats, and
//     the finished-but-unlinked responses that need human attention.
// Both 503 when the integration is not configured (env-gated like /join-study).
import { Router } from 'express';
import { requireRole } from '../../middleware/auth.js';
import {
  getQualtricsSyncConfig,
  getSyncRunStatus,
  runSync,
} from '../../services/qualtricsSync.service.js';
import { getQualtricsLinkageStats, getUnlinkedFinishedResponses } from '../../db/index.js';

export default function qualtricsSyncRoutes(): Router {
  const router = Router();

  router.post('/admin/api/qualtrics/sync', requireRole('researcher'), async (_req, res) => {
    if (!getQualtricsSyncConfig()) {
      return res.status(503).json({
        error: 'Qualtrics integration is not configured (QUALTRICS_API_TOKEN + survey ids).',
      });
    }
    try {
      const results = await runSync('manual');
      if (results === 'busy') {
        return res.status(409).json({
          error: 'A sync is already running — try again in a moment.',
        });
      }
      const failed = (results ?? []).filter((r) => r.error);
      const allFailed = results !== null && results.length > 0 && failed.length === results.length;
      res.status(allFailed ? 502 : 200).json({
        success: failed.length === 0,
        results,
        // surfaced so the client toast can say WHICH survey failed and why
        error: failed.length > 0
          ? failed.map((f) => `${f.surveyRole}: ${f.error}`).join('; ')
          : undefined,
      });
    } catch (error) {
      console.error('[QualtricsSync] sync run failed:', error);
      res.status(500).json({ error: 'Sync failed' });
    }
  });

  router.get('/admin/api/qualtrics/status', requireRole('researcher'), async (_req, res) => {
    const config = getQualtricsSyncConfig();
    if (!config) {
      return res.status(503).json({
        configured: false,
        error: 'Qualtrics integration is not configured (QUALTRICS_API_TOKEN + survey ids).',
      });
    }
    try {
      const [linkage, unlinked] = await Promise.all([
        getQualtricsLinkageStats(),
        getUnlinkedFinishedResponses(),
      ]);
      res.json({
        configured: true,
        surveys: Object.fromEntries(
          Object.entries(config.surveys).map(([role, id]) => [role, id])
        ),
        sync: getSyncRunStatus(),
        linkage,
        unlinked,
      });
    } catch (error) {
      console.error('[QualtricsSync] status failed:', error);
      res.status(500).json({ error: 'Status unavailable' });
    }
  });

  return router;
}
