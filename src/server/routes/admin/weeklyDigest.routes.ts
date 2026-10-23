// Weekly PI digest (eval spec WP7). Researcher-only, scoped to the caller's
// organization (orgIdFor, fail-closed); sandbox accounts get 404 like the IRB
// packet. Digests are aggregates only (counts, means, kappas) with no
// participant, session or staff identifiers, so generating or reading one
// does NOT write a data_access_log row: the audit log records access to
// participant data, and there is none here. The weekly_digests row itself
// (generated_by, generated_at) is the record of who produced each digest.
import { Router, type Request, type Response, type NextFunction } from 'express';
import { requireRole } from '../../middleware/auth.js';
import { orgIdFor } from '../../middleware/org.js';
import { parsePagination } from '../../utils/pagination.js';
import { listWeeklyDigests, getWeeklyDigest } from '../../db/index.js';
import {
  generateAndStoreWeeklyDigest,
  defaultWeekEnding,
  isValidWeekEnding,
  getDigestSchedule,
  setDigestSchedule,
} from '../../services/weeklyDigest.service.js';
import { createLogger } from '../../utils/logger.js';

const log = createLogger('weeklyDigestRoutes');

/** A digest may be generated for any complete week up to this long ago. */
const MAX_WEEKS_BACK = 104;

export default function weeklyDigestRoutes(): Router {
  const router = Router();

  const denySandbox = (req: Request, res: Response, next: NextFunction): void => {
    if (req.session?.isSandbox === true) {
      log.warn(`Blocked sandbox account '${req.session?.username ?? 'unknown'}' from the weekly digest.`);
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

  function parseId(raw: string, res: Response): number | null {
    const id = Number(raw);
    if (!Number.isInteger(id) || id <= 0) {
      res.status(400).json({ error: 'Invalid digest id' });
      return null;
    }
    return id;
  }

  // GET /admin/api/evals/digests - newest first, caller's org only.
  router.get('/admin/api/evals/digests', gate, async (req, res) => {
    try {
      const orgId = await scopedOrg(req, res);
      if (orgId === null) return;
      const { limit } = parsePagination(req.query as Record<string, unknown>, { defaultLimit: 26, maxLimit: 200 });
      const [digests, schedule] = await Promise.all([listWeeklyDigests(orgId, limit), getDigestSchedule()]);
      res.json({ digests, schedule, default_week_ending: defaultWeekEnding() });
    } catch (err) {
      log.error({ err }, 'Failed to list weekly digests');
      res.status(500).json({ error: 'Failed to list weekly digests' });
    }
  });

  // PUT /admin/api/evals/digests/schedule - evals.digest_schedule
  // ({enabled, weekday, hour_utc}); registered before /:id so it is not
  // mistaken for a digest id.
  router.put('/admin/api/evals/digests/schedule', gate, async (req, res) => {
    try {
      const schedule = await setDigestSchedule(req.body, req.session?.username ?? 'researcher');
      res.json({ schedule });
    } catch (err) {
      log.error({ err }, 'Failed to save digest schedule');
      res.status(500).json({ error: 'Failed to save digest schedule' });
    }
  });

  // POST /admin/api/evals/digests/generate - build + archive now for a week
  // ending (body.week_ending, YYYY-MM-DD; default = last complete week).
  router.post('/admin/api/evals/digests/generate', gate, async (req, res) => {
    try {
      const orgId = await scopedOrg(req, res);
      if (orgId === null) return;
      const raw = req.body?.week_ending;
      const weekEnding = raw === undefined || raw === null || raw === '' ? defaultWeekEnding() : raw;
      if (!isValidWeekEnding(weekEnding)) return res.status(400).json({ error: 'week_ending must be YYYY-MM-DD' });
      const ageDays = (Date.now() - new Date(`${weekEnding}T23:59:59.999Z`).getTime()) / 86_400_000;
      if (ageDays > MAX_WEEKS_BACK * 7) return res.status(400).json({ error: `week_ending may not be more than ${MAX_WEEKS_BACK} weeks ago` });
      if (ageDays < -7) return res.status(400).json({ error: 'week_ending may not be in the future' });
      const row = await generateAndStoreWeeklyDigest({ weekEnding, orgId, generatedBy: req.session?.username ?? 'researcher' });
      res.status(201).json({ digest: row });
    } catch (err) {
      log.error({ err }, 'Failed to generate weekly digest');
      res.status(500).json({ error: 'Failed to generate weekly digest' });
    }
  });

  // GET /admin/api/evals/digests/:id.md - markdown download.
  router.get('/admin/api/evals/digests/:id.md', gate, async (req, res) => {
    try {
      const orgId = await scopedOrg(req, res);
      if (orgId === null) return;
      const id = parseId(req.params.id, res);
      if (id === null) return;
      const row = await getWeeklyDigest(id, orgId);
      if (!row) return res.status(404).json({ error: 'Digest not found' });
      res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="weekly-digest-${row.week_ending}.md"`);
      res.send(row.markdown);
    } catch (err) {
      log.error({ err }, 'Failed to download weekly digest');
      res.status(500).json({ error: 'Failed to download weekly digest' });
    }
  });

  // GET /admin/api/evals/digests/:id - structured data + markdown.
  router.get('/admin/api/evals/digests/:id', gate, async (req, res) => {
    try {
      const orgId = await scopedOrg(req, res);
      if (orgId === null) return;
      const id = parseId(req.params.id, res);
      if (id === null) return;
      const row = await getWeeklyDigest(id, orgId);
      if (!row) return res.status(404).json({ error: 'Digest not found' });
      res.json({ digest: row });
    } catch (err) {
      log.error({ err }, 'Failed to fetch weekly digest');
      res.status(500).json({ error: 'Failed to fetch weekly digest' });
    }
  });

  return router;
}
