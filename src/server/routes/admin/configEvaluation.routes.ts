// Admin side of the red-team config gate (services/configEvaluation.service.ts).
//
//   GET /admin/api/config-evaluation/status    therapist, researcher: drift notice data
//   GET /admin/api/config-evaluation/snapshot  researcher: download the evaluated
//       configuration (configuration only, see utils/evaluatedConfig.ts) to run
//       `npm run redteam:full -- --config-snapshot <file>` by hand
//
// Read-only. Recording an evaluation is the workflow's job and goes through
// the token-gated routes/redteamConfigEval.routes.ts.
import { Router } from 'express';
import { requireRole } from '../../middleware/auth.js';
import { exportConfigSnapshot, getConfigEvalStatus } from '../../services/configEvaluation.service.js';
import { shortFingerprint } from '../../utils/evaluatedConfig.js';
import { createLogger } from '../../utils/logger.js';

const log = createLogger('adminConfigEvaluationRoutes');

export default function adminConfigEvaluationRoutes(): Router {
  const router = Router();

  router.get('/admin/api/config-evaluation/status', requireRole('therapist', 'researcher'), async (_req, res) => {
    try {
      res.json(await getConfigEvalStatus());
    } catch (err) {
      log.error({ err }, 'Failed to compute config evaluation status');
      res.status(500).json({ error: 'Failed to compute config evaluation status' });
    }
  });

  router.get('/admin/api/config-evaluation/snapshot', requireRole('researcher'), async (req, res) => {
    try {
      const snapshot = await exportConfigSnapshot(req.hostname || null);
      log.info(
        { username: req.session.username, fingerprint: shortFingerprint(snapshot.fingerprint) },
        'config snapshot exported',
      );
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="config-snapshot-${shortFingerprint(snapshot.fingerprint)}.json"`,
      );
      res.json(snapshot);
    } catch (err) {
      log.error({ err }, 'Failed to export config snapshot');
      res.status(500).json({ error: 'Failed to export config snapshot' });
    }
  });

  return router;
}
