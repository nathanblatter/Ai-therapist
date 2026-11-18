// Machine API for the redteam-config workflow (.github/workflows/redteam-config.yml).
//
// Authenticated by ONE dedicated bearer token, REDTEAM_CONFIG_EVAL_TOKEN in
// the environment's deploy .env, that can do exactly three things:
//
//   GET  /api/redteam/config-eval/status                read the fingerprint + drift state
//   POST /api/redteam/config-eval/claim                 claim the current fingerprint and
//                                                       receive its configuration snapshot
//   POST /api/redteam/config-eval/evaluations/:id/finish  record the run's totals
//
// It cannot read or write anything else: no session, no role, no participant
// data, no config writes. With the variable unset (the default) every route
// answers 404, so the surface does not exist until the owner adds the token.
// Mounted before the session middleware: these calls never create a session.
import { Router, type NextFunction, type Request, type Response } from 'express';
import rateLimit from 'express-rate-limit';
import {
  claimConfigEvaluation,
  finishConfigEvaluation,
  getConfigEvalStatus,
} from '../services/configEvaluation.service.js';
import { tokensMatch } from '../utils/crypto.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('redteamConfigEvalRoutes');

/** Shortest token accepted; anything shorter leaves the surface disabled. */
export const MIN_TOKEN_LENGTH = 32;
const SUITES = new Set(['smoke', 'full', 'quality', 'voice']);
const FINISH_STATUSES = new Set(['passed', 'failed', 'error']);

function configuredToken(): string | null {
  const t = process.env.REDTEAM_CONFIG_EVAL_TOKEN;
  return t && t.length >= MIN_TOKEN_LENGTH ? t : null;
}

function requireEvalToken(req: Request, res: Response, next: NextFunction): void {
  const expected = configuredToken();
  if (!expected) {
    res.status(404).json({ error: 'Not found' });
    return;
  }
  const header = req.get('authorization') ?? '';
  const provided = header.startsWith('Bearer ') ? header.slice('Bearer '.length).trim() : '';
  if (!provided || !tokensMatch(provided, expected)) {
    log.warn({ ip: req.ip, path: req.path }, 'config-eval call with a missing or wrong token');
    res.status(401).json({ error: 'Invalid token' });
    return;
  }
  next();
}

function optText(v: unknown, max: number): string | null | undefined {
  if (v === undefined || v === null || v === '') return null;
  if (typeof v !== 'string' || v.length > max) return undefined;
  return v;
}

function optCount(v: unknown): number | null | undefined {
  if (v === undefined || v === null) return null;
  return typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 100_000 ? v : undefined;
}

const GIT_SHA_RE = /^[0-9a-f]{7,40}$/;
const RESULT_URL_RE = /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/actions\/runs\/\d+(\/[\w/-]*)?$/;

export default function redteamConfigEvalRoutes(): Router {
  const router = Router();
  const limiter = rateLimit({ windowMs: 60_000, limit: 30, standardHeaders: true, legacyHeaders: false });
  router.use('/api/redteam/config-eval', limiter, requireEvalToken);

  router.get('/api/redteam/config-eval/status', async (_req, res) => {
    try {
      const status = await getConfigEvalStatus();
      // The workflow logs on a public repository: no staff usernames here.
      res.json({ ...status, last_change: { ...status.last_change, by: null } });
    } catch (err) {
      log.error({ err }, 'config-eval status failed');
      res.status(500).json({ error: 'Failed to compute status' });
    }
  });

  router.post('/api/redteam/config-eval/claim', async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const suite = typeof body.suite === 'string' ? body.suite : 'full';
    const triggeredBy = optText(body.triggered_by, 200);
    const gitSha = optText(body.git_sha, 40);
    const resultUrl = optText(body.result_url, 500);
    const environment = optText(body.environment, 40);
    if (!SUITES.has(suite)) return res.status(400).json({ error: 'unknown suite' });
    if (!triggeredBy) return res.status(400).json({ error: 'triggered_by is required (max 200 chars)' });
    if (gitSha === undefined || (gitSha && !GIT_SHA_RE.test(gitSha))) {
      return res.status(400).json({ error: 'git_sha must be a hex commit id' });
    }
    if (resultUrl === undefined || (resultUrl && !RESULT_URL_RE.test(resultUrl))) {
      return res.status(400).json({ error: 'result_url must be a GitHub Actions run URL' });
    }
    if (environment === undefined) return res.status(400).json({ error: 'environment must be a short label' });
    try {
      const outcome = await claimConfigEvaluation({
        suite,
        triggeredBy,
        gitSha,
        resultUrl,
        environment,
        force: body.force === true,
      });
      if (!outcome.claimed) {
        return res.status(outcome.reason === 'daily_cap' ? 429 : 409).json({
          claimed: false,
          reason: outcome.reason,
          fingerprint: outcome.status.fingerprint,
          state: outcome.status.state,
        });
      }
      res.status(201).json(outcome);
    } catch (err) {
      log.error({ err }, 'config-eval claim failed');
      res.status(500).json({ error: 'Failed to claim' });
    }
  });

  router.post('/api/redteam/config-eval/evaluations/:id/finish', async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'bad id' });
    const body = (req.body ?? {}) as Record<string, unknown>;
    const status = body.status;
    if (typeof status !== 'string' || !FINISH_STATUSES.has(status)) {
      return res.status(400).json({ error: 'status must be passed, failed or error' });
    }
    const counts = {
      scenariosTotal: optCount(body.scenarios_total),
      scenariosPassed: optCount(body.scenarios_passed),
      scenariosFailed: optCount(body.scenarios_failed),
      knownGaps: optCount(body.known_gaps),
    };
    if (Object.values(counts).some((v) => v === undefined)) {
      return res.status(400).json({ error: 'counts must be non-negative integers' });
    }
    const cost = body.est_cost_usd;
    if (cost !== undefined && cost !== null && (typeof cost !== 'number' || !(cost >= 0) || cost > 1000)) {
      return res.status(400).json({ error: 'est_cost_usd must be a non-negative number' });
    }
    // A pass must be backed by totals with zero failures; anything else is recorded as what it is.
    if (status === 'passed' && (counts.scenariosTotal === null || counts.scenariosFailed !== 0)) {
      return res.status(400).json({ error: 'passed requires scenarios_total and scenarios_failed = 0' });
    }
    const gitSha = optText(body.git_sha, 40);
    const resultUrl = optText(body.result_url, 500);
    const error = optText(body.error, 2000);
    if (gitSha === undefined || (gitSha && !GIT_SHA_RE.test(gitSha))) {
      return res.status(400).json({ error: 'git_sha must be a hex commit id' });
    }
    if (resultUrl === undefined || (resultUrl && !RESULT_URL_RE.test(resultUrl))) {
      return res.status(400).json({ error: 'result_url must be a GitHub Actions run URL' });
    }
    try {
      const row = await finishConfigEvaluation(id, {
        status: status as 'passed' | 'failed' | 'error',
        scenariosTotal: counts.scenariosTotal as number | null,
        scenariosPassed: counts.scenariosPassed as number | null,
        scenariosFailed: counts.scenariosFailed as number | null,
        knownGaps: counts.knownGaps as number | null,
        estCostUsd: typeof cost === 'number' ? cost : null,
        gitSha,
        resultUrl,
        error: error ?? null,
      });
      if (!row) return res.status(404).json({ error: 'No running evaluation with that id' });
      res.json({ evaluation: row });
    } catch (err) {
      log.error({ err }, 'config-eval finish failed');
      res.status(500).json({ error: 'Failed to record result' });
    }
  });

  return router;
}
