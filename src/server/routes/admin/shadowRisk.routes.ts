// Shadow risk scorer report (ai-therapist-83): where the production crisis
// pipeline and the shadow scorer disagree. Researcher-only, scoped to the
// caller's organisation (orgIdFor, fail-closed); sandbox accounts get 404,
// like the risk calibration report this sits beside. Read-only: there is no
// route that changes anything, and the switch is the system_config key.
//
// The response is counts, band names, probabilities and row ids. The table
// holds no message text, so there is none to return and no data_access_log
// row is written (the same rule as riskCalibration.routes.ts).
import { Router, type Request, type Response, type NextFunction } from 'express';
import { requireRole } from '../../middleware/auth.js';
import { orgIdFor } from '../../middleware/org.js';
import { getIrbStudyOrgId, getSystemConfigByKey } from '../../db/index.js';
import { getShadowRiskReport } from '../../db/shadowRisk.queries.js';
import { parseShadowConfig, SHADOW_CONFIG_KEY } from '../../services/shadowRiskScorer.service.js';
import { SHADOW_MODEL, SHADOW_QUESTION_SET_VERSION } from '../../services/shadowRiskQuestions.js';
import { createLogger } from '../../utils/logger.js';

const log = createLogger('shadowRiskRoutes');

export const SHADOW_REPORT_DEFAULT_DAYS = 30;
export const SHADOW_REPORT_MAX_DAYS = 365;

export default function shadowRiskRoutes(): Router {
  const router = Router();

  const denySandbox = (req: Request, res: Response, next: NextFunction): void => {
    if (req.session?.isSandbox === true) {
      log.warn(`Blocked sandbox account '${req.session?.username ?? 'unknown'}' from the shadow scorer report.`);
      res.status(404).json({ error: 'not found' });
      return;
    }
    next();
  };
  const researcher = requireRole('researcher');
  const gate = (req: Request, res: Response, next: NextFunction): void => {
    researcher(req, res, (err?: unknown) => (err ? next(err) : denySandbox(req, res, next)));
  };

  // GET /admin/api/shadow-risk/report?days=30 - caller's organisation only.
  router.get('/admin/api/shadow-risk/report', gate, async (req, res) => {
    try {
      const orgId = await orgIdFor(req);
      if (orgId === null) return res.status(401).json({ error: 'Authentication required' });
      const raw = req.query.days === undefined ? SHADOW_REPORT_DEFAULT_DAYS : Number(req.query.days);
      if (!Number.isInteger(raw) || raw < 1 || raw > SHADOW_REPORT_MAX_DAYS) {
        return res.status(400).json({ error: `days must be a whole number from 1 to ${SHADOW_REPORT_MAX_DAYS}` });
      }
      const to = new Date();
      const from = new Date(to.getTime() - raw * 24 * 60 * 60 * 1000);
      const irbOrgId = await getIrbStudyOrgId();
      const [report, configRow] = await Promise.all([
        getShadowRiskReport({
          from: from.toISOString(),
          to: to.toISOString(),
          orgId,
          includeUnattributed: irbOrgId !== null && irbOrgId === orgId,
        }),
        getSystemConfigByKey(SHADOW_CONFIG_KEY),
      ]);
      res.json({
        enabled: parseShadowConfig(configRow?.config_value).enabled,
        model: SHADOW_MODEL,
        question_set_version: SHADOW_QUESTION_SET_VERSION,
        days: raw,
        report,
      });
    } catch (err) {
      log.error({ err }, 'Failed to build the shadow scorer report');
      res.status(500).json({ error: 'Failed to build the shadow scorer report' });
    }
  });

  return router;
}
