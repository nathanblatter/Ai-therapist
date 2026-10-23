// Audit-trail read API (ai-therapist-197). The append-only accountability
// tables were write-only; this is the read side the IRB was told exists.
//
//   GET /admin/api/audit/data-access                   researcher, org-scoped
//   GET /admin/api/audit/data-access/participant/:id   therapist (caseload-
//       scoped, 404-over-403) or researcher (org-scoped); self-audited with an
//       'audit_log_view' data_access_log row
//   GET /admin/api/audit/redaction-review              researcher
//   GET /admin/api/audit/assistant                     researcher, org-scoped
//
// The two older audit reads stay where they are (GET /admin/api/caseload/audit,
// GET /admin/api/content-retention/log); the Data Access admin view tabs them
// in alongside these.
import { Router } from 'express';
import { requireRole } from '../../middleware/auth.js';
import { requireClientAccess } from '../../middleware/caseload.js';
import { orgIdFor } from '../../middleware/org.js';
import { parsePagination } from '../../utils/pagination.js';
import {
  listDataAccessLog,
  getParticipantAccessHistory,
  listRedactionReviewLog,
  listAssistantAudit,
  logDataAccess,
  isDataAccessAction,
  getOrganizationIdForUser,
} from '../../db/index.js';

const PAGING = { defaultLimit: 50, maxLimit: 500 };

/** Optional non-empty query string, else null. */
function optString(raw: unknown): string | null {
  return typeof raw === 'string' && raw.trim() !== '' ? raw.trim() : null;
}

/** Optional positive-integer query param: null when absent, undefined when malformed. */
function optInt(raw: unknown): number | null | undefined {
  const value = optString(raw);
  if (value === null) return null;
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : undefined;
}

/** Optional ISO date/timestamp query param: null when absent, undefined when unparseable. */
function optDate(raw: unknown): string | null | undefined {
  const value = optString(raw);
  if (value === null) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}

export default function auditRoutes(): Router {
  const router = Router();

  // GET /admin/api/audit/data-access - filtered, paginated global log
  router.get('/admin/api/audit/data-access', requireRole('researcher'), async (req, res) => {
    const { limit, offset } = parsePagination(req.query, PAGING);
    const participantUserId = optInt(req.query.participantUserId);
    const since = optDate(req.query.since);
    const until = optDate(req.query.until);
    const action = optString(req.query.action);
    if (participantUserId === undefined) return res.status(400).json({ error: 'Invalid participantUserId' });
    if (since === undefined || until === undefined) return res.status(400).json({ error: 'Invalid since/until' });
    if (action !== null && !isDataAccessAction(action)) return res.status(400).json({ error: 'Invalid action' });

    try {
      const page = await listDataAccessLog(
        {
          participantUserId,
          sessionId: optString(req.query.sessionId),
          actorUsername: optString(req.query.actorUsername),
          action,
          since,
          until,
          limit,
          offset,
        },
        await orgIdFor(req)
      );
      res.json({ ...page, limit, offset });
    } catch (err) {
      console.error('Failed to fetch data access log:', err);
      res.status(500).json({ error: 'Failed to fetch data access log' });
    }
  });

  // GET /admin/api/audit/data-access/participant/:userId - one participant's
  // access history. Therapists are caseload-scoped by requireClientAccess;
  // researchers are org-scoped here (C13, 404-over-403 like the caseload
  // routes). Reading the history is itself an access and is logged.
  router.get(
    '/admin/api/audit/data-access/participant/:userId',
    requireRole('therapist', 'researcher'),
    requireClientAccess(),
    async (req, res) => {
      const userId = Number(req.params.userId);
      if (!Number.isInteger(userId)) return res.status(400).json({ error: 'Invalid user id' });
      const { limit, offset } = parsePagination(req.query, PAGING);

      try {
        if (req.session.userRole === 'researcher') {
          const [callerOrg, participantOrg] = await Promise.all([
            orgIdFor(req),
            getOrganizationIdForUser(userId),
          ]);
          if (callerOrg === null || participantOrg !== callerOrg) {
            return res.status(404).json({ error: 'Not found' });
          }
        }

        const history = await getParticipantAccessHistory(userId, { limit, offset });

        // Self-audit (fire-and-forget): the per-participant read is recorded,
        // the global list is not, so the log never recurses on itself.
        void logDataAccess({
          accessedBy: req.session.userId ?? null,
          role: req.session.userRole ?? null,
          action: 'audit_log_view',
          userId,
          detail: { scope: 'participant', limit, offset },
        });

        res.json({ ...history, limit, offset });
      } catch (err) {
        console.error('Failed to fetch participant access history:', err);
        res.status(500).json({ error: 'Failed to fetch participant access history' });
      }
    }
  );

  // GET /admin/api/audit/redaction-review - who approved/corrected what
  router.get('/admin/api/audit/redaction-review', requireRole('researcher'), async (req, res) => {
    const { limit, offset } = parsePagination(req.query, PAGING);
    const reviewedBy = optInt(req.query.reviewedBy);
    const action = optString(req.query.action);
    if (reviewedBy === undefined) return res.status(400).json({ error: 'Invalid reviewedBy' });
    if (action !== null && action !== 'approved' && action !== 'corrected') {
      return res.status(400).json({ error: 'Invalid action' });
    }
    try {
      const page = await listRedactionReviewLog({ reviewedBy, action, limit, offset });
      res.json({ ...page, limit, offset });
    } catch (err) {
      console.error('Failed to fetch redaction review log:', err);
      res.status(500).json({ error: 'Failed to fetch redaction review log' });
    }
  });

  // GET /admin/api/audit/assistant - admin-assistant turns (org-scoped)
  router.get('/admin/api/audit/assistant', requireRole('researcher'), async (req, res) => {
    const { limit, offset } = parsePagination(req.query, PAGING);
    const userId = optInt(req.query.userId);
    const since = optDate(req.query.since);
    const until = optDate(req.query.until);
    if (userId === undefined) return res.status(400).json({ error: 'Invalid userId' });
    if (since === undefined || until === undefined) return res.status(400).json({ error: 'Invalid since/until' });
    try {
      const page = await listAssistantAudit(
        { userId, username: optString(req.query.username), since, until, limit, offset },
        await orgIdFor(req)
      );
      res.json({ ...page, limit, offset });
    } catch (err) {
      console.error('Failed to fetch assistant audit log:', err);
      res.status(500).json({ error: 'Failed to fetch assistant audit log' });
    }
  });

  return router;
}
