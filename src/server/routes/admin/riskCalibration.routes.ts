// Risk-score calibration runs (eval spec WP3). Researcher-only, scoped to the
// caller's organization (orgIdFor, fail-closed); sandbox accounts get 404
// like the IRB packet and the weekly digest. Reports are aggregates (counts,
// rates, kappas, thresholds) plus the miss-rate sample's message ids - no
// transcript text or participant identifiers - so no data_access_log row is
// written; the run row's created_by is the audit trail of who ran it.
//
// POST runs synchronously: the SQL side is small and the miss-rate sample is
// capped (MAX_SAMPLE_SIZE, MISS_RATE_BUDGET_USD) so a run finishes well under
// a minute. One run at a time per process so two clicks cannot double-spend.
import { Router, type Request, type Response, type NextFunction } from 'express';
import { requireRole } from '../../middleware/auth.js';
import { orgIdFor } from '../../middleware/org.js';
import { parsePagination } from '../../utils/pagination.js';
import { listRiskCalibrationRuns, getRiskCalibrationRun } from '../../db/index.js';
import {
  runAndStoreRiskCalibration,
  normalizeParams,
  CURRENT_BANDS,
  DEFAULT_SAMPLE_SIZE,
  MAX_SAMPLE_SIZE,
  MISS_RATE_BUDGET_USD,
} from '../../services/riskCalibration.service.js';
import { createLogger } from '../../utils/logger.js';

const log = createLogger('riskCalibrationRoutes');

export default function riskCalibrationRoutes(): Router {
  const router = Router();
  let running = false;

  const denySandbox = (req: Request, res: Response, next: NextFunction): void => {
    if (req.session?.isSandbox === true) {
      log.warn(`Blocked sandbox account '${req.session?.username ?? 'unknown'}' from risk calibration.`);
      res.status(404).json({ error: 'not found' });
      return;
    }
    next();
  };
  const researcher = requireRole('researcher');
  const gate = (req: Request, res: Response, next: NextFunction): void => {
    researcher(req, res, (err?: unknown) => (err ? next(err) : denySandbox(req, res, next)));
  };

  async function scopedOrg(req: Request, res: Response): Promise<number | null> {
    const orgId = await orgIdFor(req);
    if (orgId === null) {
      res.status(401).json({ error: 'Authentication required' });
      return null;
    }
    return orgId;
  }

  // GET /admin/api/risk-calibration/runs - newest first, caller's org only.
  router.get('/admin/api/risk-calibration/runs', gate, async (req, res) => {
    try {
      const orgId = await scopedOrg(req, res);
      if (orgId === null) return;
      const { limit } = parsePagination(req.query as Record<string, unknown>, { defaultLimit: 20, maxLimit: 200 });
      const runs = await listRiskCalibrationRuns(orgId, limit);
      res.json({
        runs,
        current_bands: CURRENT_BANDS,
        defaults: { sample_size: DEFAULT_SAMPLE_SIZE, max_sample_size: MAX_SAMPLE_SIZE, budget_usd: MISS_RATE_BUDGET_USD },
      });
    } catch (err) {
      log.error({ err }, 'Failed to list risk calibration runs');
      res.status(500).json({ error: 'Failed to list risk calibration runs' });
    }
  });

  // GET /admin/api/risk-calibration/runs/:id - full report.
  router.get('/admin/api/risk-calibration/runs/:id', gate, async (req, res) => {
    try {
      const orgId = await scopedOrg(req, res);
      if (orgId === null) return;
      const id = Number(req.params.id);
      if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'Invalid run id' });
      const run = await getRiskCalibrationRun(id, orgId);
      if (!run) return res.status(404).json({ error: 'Run not found' });
      res.json({ run });
    } catch (err) {
      log.error({ err }, 'Failed to fetch risk calibration run');
      res.status(500).json({ error: 'Failed to fetch risk calibration run' });
    }
  });

  // POST /admin/api/risk-calibration/runs - start a run now (synchronous).
  // Body: {since?, until?, sample_size?, seed?, dry_run?, unflagged_as_negative?}.
  // The budget cap is not client-settable: it is the service constant.
  router.post('/admin/api/risk-calibration/runs', gate, async (req, res) => {
    try {
      const orgId = await scopedOrg(req, res);
      if (orgId === null) return;
      const body = (req.body ?? {}) as Record<string, unknown>;
      let params;
      try {
        params = normalizeParams({
          since: typeof body.since === 'string' ? body.since : undefined,
          until: typeof body.until === 'string' ? body.until : undefined,
          sample_size: body.sample_size === undefined ? undefined : Number(body.sample_size),
          seed: body.seed === undefined ? undefined : Number(body.seed),
          dry_run: body.dry_run === true,
          unflagged_as_negative: body.unflagged_as_negative === undefined ? undefined : body.unflagged_as_negative === true,
        });
      } catch (err) {
        return res.status(400).json({ error: err instanceof Error ? err.message : 'Invalid parameters' });
      }
      if (running) return res.status(409).json({ error: 'A calibration run is already in progress' });
      running = true;
      try {
        const run = await runAndStoreRiskCalibration({ orgId, params, createdBy: req.session?.username ?? 'researcher' });
        res.status(201).json({ run });
      } finally {
        running = false;
      }
    } catch (err) {
      log.error({ err }, 'Failed to run risk calibration');
      res.status(500).json({ error: 'Failed to run risk calibration' });
    }
  });

  return router;
}
