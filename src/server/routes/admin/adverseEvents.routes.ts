// Admin API for IRB adverse-event reports (ai-therapist-95). Reads are
// therapist/researcher; edits + sign-off are therapist+researcher (sign-off is
// clinical + study staff). Lifecycle transitions that don't apply return 409.
// Caseworker AE filing (docs/caseworker-portal.md section 10 item 6):
// caseworkers can FILE a report for a caseload client and view ONLY their own
// filed reports (list/detail filtered to reporter); review, triage, and
// lifecycle management stay therapist+researcher.
//
// Organization scoping (ai-therapist-228, migration 108): every read and
// every lifecycle write resolves the row through an AdverseEventScope built
// from the caller's org + role (scopeFor below). A report outside the scope
// reads as 404 — never 403 — so cross-org existence is not confirmable.
import { Router, type Request, type Response, type NextFunction } from 'express';
import { requireRole } from '../../middleware/auth.js';
import { requireClientAccess, requireSessionClientAccess } from '../../middleware/caseload.js';
import { orgIdFor } from '../../middleware/org.js';
import { isCareTeamRole } from '../../../shared/roles.js';
import {
  listAdverseEvents,
  getAdverseEventCounts,
  getAdverseEventById,
  updateAdverseEventDraft,
  submitAdverseEvent,
  closeAdverseEvent,
  reopenAdverseEvent,
  insertAdverseEventDraft,
  insertCaseloadAudit,
  isSandboxAccount,
  getSessionAccessInfo,
  getOrganizationIdForUser,
  getIrbStudyOrgId,
  type UpdateAdverseEventFields,
  type AdverseEventRowWithFlags,
  type AdverseEventActionEntry,
  type AdverseEventScope,
} from '../../db/index.js';
import { enqueueWorkItem } from '../../services/workQueue.service.js';
import { renderAdverseEventPrintHtml } from '../../utils/aePrintView.js';

import { createLogger } from '../../utils/logger.js';

const log = createLogger('adverseEventsRoutes');

/** Summaries-tier projection for caseworker reads: a reviewer may attach a
 *  (redacted) transcript excerpt to a caseworker-filed draft, and caseworkers
 *  never see transcript content — not even content_redacted. */
function scrubForCaseworker(row: AdverseEventRowWithFlags): AdverseEventRowWithFlags {
  return { ...row, transcript_excerpt: null };
}

/**
 * The register scope for this caller (docs/caseworker-portal.md, "Adverse
 * events" scoping rule):
 *   - researcher: every report in their organization (+ unattributed
 *     NULL-org rows when their org is the irb-study org);
 *   - therapist: their organization's reports whose participant is on their
 *     caseload, or that they filed themselves;
 *   - caseworker: only reports they filed, within their organization.
 * Fail closed: orgIdFor THROWS on a failed lookup (-> 500 via the route's
 * catch), and a care-team session missing its identity also throws rather
 * than widening to an org-wide read.
 */
async function scopeFor(req: Request): Promise<AdverseEventScope> {
  const orgId = await orgIdFor(req);
  if (orgId === null) throw new Error('[AE] unauthenticated caller reached a scoped register read');
  const role = req.session.userRole;
  if (!isCareTeamRole(role)) return { orgId, careTeam: null };
  const memberId = req.session.userId;
  const username = req.session.username;
  if (typeof memberId !== 'number' || !username) {
    throw new Error('[AE] care-team session without userId/username cannot be scoped');
  }
  return { orgId, careTeam: { role, memberId, username } };
}

export default function adverseEventsRoutes(): Router {
  const router = Router();
  // Reads: caseworkers included, but row-filtered to their own filed reports.
  /**
   * Sandbox accounts must never read the real adverse-event register.
   *
   * POST /join-sandbox/:token lets an outside party self-provision a real
   * account with role 'therapist' or 'caseworker' in a fresh sandbox org. The
   * AE read routes were gated on ROLE only, and adverse_event_reports has no
   * org column (migration 048), so listAdverseEvents returns every row in the
   * table for every organization. A self-provisioned sandbox therapist could
   * therefore read the real IRB register: participant_ref, user_id,
   * occurred_at, severity, narrative summaries and event timelines.
   *
   * Proper org scoping is the real fix and needs a schema change (filed
   * separately). This is the hard stop in the meantime, and it is the correct
   * behaviour regardless: a sandbox tester has no business reading real
   * participant adverse events.
   */
  const denySandbox = (req: Request, res: Response, next: NextFunction): void => {
    if (req.session?.isSandbox === true) {
      log.warn(
        `Blocked sandbox account '${req.session?.username ?? 'unknown'}' from reading the ` +
        'adverse-event register.',
      );
      // 404, not 403 — existence of the register must not be confirmable,
      // matching the caseload middleware's convention in this file.
      res.status(404).json({ error: 'not found' });
      return;
    }
    next();
  };

  /** Compose a role gate with the sandbox denial into one middleware. */
  const gated = (...roles: Parameters<typeof requireRole>) => {
    const role = requireRole(...roles);
    return (req: Request, res: Response, next: NextFunction): void => {
      role(req, res, (err?: unknown) => {
        if (err) return next(err);
        denySandbox(req, res, next);
      });
    };
  };

  const canRead = gated('therapist', 'researcher', 'caseworker');
  // Review/triage/lifecycle stays full-tier (spec s10 item 6).
  const canReview = gated('therapist', 'researcher');
  const canWrite = gated('therapist', 'researcher');
  const VALID_SEVERITIES = ['low', 'medium', 'high'] as const;

  // List + counts (optional ?status= draft|submitted|closed|all), SQL-scoped
  // to the caller (org + role; caseworkers see ONLY reports they filed).
  router.get('/admin/api/adverse-events', canRead, async (req, res) => {
    const status = typeof req.query.status === 'string' ? req.query.status : null;
    try {
      const scope = await scopeFor(req);
      const [counts, rows] = await Promise.all([getAdverseEventCounts(scope), listAdverseEvents({ status }, scope)]);
      const reports = req.session.userRole === 'caseworker' ? rows.map(scrubForCaseworker) : rows;
      res.json({ counts, reports });
    } catch (err) {
      log.error({ err }, 'list failed');
      res.status(500).json({ error: 'Failed to load adverse events' });
    }
  });

  // Single report. Anything outside the caller's scope (other org, other
  // reporter for a caseworker, off-caseload for a therapist) is 404 — never
  // 403 — matching the caseload middleware.
  router.get('/admin/api/adverse-events/:id', canRead, async (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'invalid id' });
    try {
      const row = await getAdverseEventById(id, await scopeFor(req));
      if (!row) return res.status(404).json({ error: 'not found' });
      res.json(req.session.userRole === 'caseworker' ? scrubForCaseworker(row) : row);
    } catch (err) {
      log.error({ err }, 'get failed');
      res.status(500).json({ error: 'Failed to load adverse event' });
    }
  });

  // Print / export view (standalone HTML). Review surface: full tier only.
  router.get('/admin/api/adverse-events/:id/print', canReview, async (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id)) return res.status(400).send('invalid id');
    try {
      const row = await getAdverseEventById(id, await scopeFor(req));
      if (!row) return res.status(404).send('not found');
      res.set('Content-Type', 'text/html; charset=utf-8').send(renderAdverseEventPrintHtml(row));
    } catch (err) {
      log.error({ err }, 'print failed');
      res.status(500).send('Failed to render report');
    }
  });

  // Edit draft fields (409 if not a draft).
  router.patch('/admin/api/adverse-events/:id', canWrite, async (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'invalid id' });
    const body = req.body ?? {};
    const fields: UpdateAdverseEventFields = {};
    if (typeof body.summary === 'string') fields.summary = body.summary;
    if (body.transcript_excerpt === null || typeof body.transcript_excerpt === 'string') fields.transcript_excerpt = body.transcript_excerpt;
    if (Array.isArray(body.actions_taken)) fields.actions_taken = body.actions_taken;
    if (Array.isArray(body.timeline)) fields.timeline = body.timeline;
    if (typeof body.due_at === 'string') {
      const d = new Date(body.due_at);
      if (Number.isNaN(d.getTime())) return res.status(400).json({ error: 'due_at is not a valid date' });
      fields.due_at = d;
    }
    if (body.severity === 'low' || body.severity === 'medium' || body.severity === 'high') fields.severity = body.severity;
    if (Object.keys(fields).length === 0) return res.status(400).json({ error: 'no editable fields supplied' });

    try {
      // Visibility first (404 outside scope), then the guarded transition.
      const scope = await scopeFor(req);
      if (!(await getAdverseEventById(id, scope))) return res.status(404).json({ error: 'not found' });
      const ok = await updateAdverseEventDraft(id, fields);
      if (!ok) return res.status(409).json({ error: 'report is not a draft' });
      res.json(await getAdverseEventById(id, scope));
    } catch (err) {
      log.error({ err }, 'update failed');
      res.status(500).json({ error: 'Failed to update adverse event' });
    }
  });

  // Sign-off: draft -> submitted.
  router.post('/admin/api/adverse-events/:id/submit', canWrite, async (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'invalid id' });
    const submittedBy = req.session.username;
    if (!submittedBy) return res.status(400).json({ error: 'sign-off requires an identified admin' });
    try {
      const scope = await scopeFor(req);
      if (!(await getAdverseEventById(id, scope))) return res.status(404).json({ error: 'not found' });
      const ok = await submitAdverseEvent(id, submittedBy);
      if (!ok) return res.status(409).json({ error: 'report is not a draft' });
      res.json(await getAdverseEventById(id, scope));
    } catch (err) {
      log.error({ err }, 'submit failed');
      res.status(500).json({ error: 'Failed to submit adverse event' });
    }
  });

  // submitted -> draft (pre-close corrections).
  router.post('/admin/api/adverse-events/:id/reopen', canWrite, async (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'invalid id' });
    try {
      const scope = await scopeFor(req);
      if (!(await getAdverseEventById(id, scope))) return res.status(404).json({ error: 'not found' });
      const ok = await reopenAdverseEvent(id);
      if (!ok) return res.status(409).json({ error: 'report is not submitted' });
      res.json(await getAdverseEventById(id, scope));
    } catch (err) {
      log.error({ err }, 'reopen failed');
      res.status(500).json({ error: 'Failed to reopen adverse event' });
    }
  });

  // submitted -> closed.
  router.post('/admin/api/adverse-events/:id/close', canWrite, async (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'invalid id' });
    const closedBy = req.session.username ?? 'unknown-admin';
    try {
      const scope = await scopeFor(req);
      if (!(await getAdverseEventById(id, scope))) return res.status(404).json({ error: 'not found' });
      const ok = await closeAdverseEvent(id, closedBy);
      if (!ok) return res.status(409).json({ error: 'report is not submitted' });
      res.json(await getAdverseEventById(id, scope));
    } catch (err) {
      log.error({ err }, 'close failed');
      res.status(500).json({ error: 'Failed to close adverse event' });
    }
  });

  // Manually file an AE from a session (trigger_source='manual'); reuses the
  // draft assembler with crisis_event_id=null so it never collides with auto.
  // requireSessionClientAccess row-scopes therapists to their caseload (404,
  // never 403) — without it an off-caseload therapist could draft an AE from
  // ANY session and read back its redacted transcript excerpt in the response.
  // Researchers pass the caseload gate (study staff) but are org-checked
  // here: the session's owner must belong to the caller's organization (an
  // anonymous session counts as irb-study custody). 404 otherwise.
  router.post('/admin/api/sessions/:sessionId/adverse-events', canWrite, requireSessionClientAccess(), async (req, res) => {
    const createdBy = req.session.username ?? 'unknown-admin';
    try {
      const scope = await scopeFor(req);
      if (!scope.careTeam && !(await sessionInOrg(req.params.sessionId, scope.orgId))) {
        return res.status(404).json({ error: 'Not found' });
      }
      const { draftAdverseEventFromCrisis } = await import('../../services/adverseEvent.service.js');
      const reportId = await draftAdverseEventFromCrisis(req.params.sessionId, { triggerSource: 'manual', createdBy });
      if (reportId == null) return res.status(422).json({ error: 'Could not draft an adverse event for this session' });
      res.status(201).json(await getAdverseEventById(reportId, scope));
    } catch (err) {
      log.error({ err }, 'manual draft failed');
      res.status(500).json({ error: 'Failed to file adverse event' });
    }
  });

  // Caseworker AE filing (spec s10 item 6): file a draft report for a
  // caseload client, outside any session. requireClientAccess gives the
  // 404-over-403 caseload row-scoping (therapists get the same check;
  // researchers are excluded — filing is a care-team act). The draft lands in
  // the therapist review queue via the existing adverse_event work item.
  router.post(
    '/admin/api/clients/:userId/adverse-events',
    requireRole('caseworker', 'therapist'),
    requireClientAccess(),
    async (req, res) => {
      const clientId = Number(req.params.userId);
      const username = req.session.username;
      if (!username) return res.status(400).json({ error: 'filing requires an identified admin' });

      const body = req.body ?? {};
      const summary = typeof body.summary === 'string' ? body.summary.trim() : '';
      if (!summary) return res.status(400).json({ error: 'summary is required' });
      const severity = body.severity as (typeof VALID_SEVERITIES)[number];
      if (!VALID_SEVERITIES.includes(severity)) {
        return res.status(400).json({ error: 'severity must be low, medium, or high' });
      }
      let occurredAt = new Date();
      if (body.occurred_at !== undefined) {
        occurredAt = new Date(body.occurred_at);
        if (Number.isNaN(occurredAt.getTime())) {
          return res.status(400).json({ error: 'occurred_at is not a valid date' });
        }
      }
      // Free-text action lines from the form; stamped with the reporter. A
      // caseworker filing NEVER carries transcript content (summaries tier).
      const actionsTaken: AdverseEventActionEntry[] = Array.isArray(body.actions_taken)
        ? (body.actions_taken as unknown[])
            .filter((a): a is string => typeof a === 'string' && a.trim() !== '')
            .map((a) => ({ at: new Date().toISOString(), action: a.trim(), by: username }))
        : [];

      try {
        // Mirror of the session-manual path's sandbox guard: sandbox clients
        // are synthetic, so a manually filed AE is queue noise, not an IRB
        // report. (Caseload scoping already passed, so 422 leaks nothing.)
        if (await isSandboxAccount(clientId)) {
          return res.status(422).json({ error: 'Adverse events cannot be filed for sandbox accounts' });
        }

        const reportId = await insertAdverseEventDraft({
          sessionId: null,
          crisisEventId: null, // never collides with the auto per-event unique index
          userId: clientId,
          sessionRef: 'out-of-session',
          participantRef: `user ${clientId}`,
          occurredAt,
          severity,
          triggerSource: 'manual',
          category: 'crisis',
          summary,
          timeline: [{ at: occurredAt.toISOString(), kind: 'report_filed', detail: `Filed by ${req.session.userRole} ${username}` }],
          transcriptExcerpt: null,
          actionsTaken,
          dueAt: new Date(occurredAt.getTime() + 7 * 24 * 3_600_000),
          createdBy: username,
        });
        if (reportId == null) {
          return res.status(422).json({ error: 'Could not file adverse event' });
        }

        // Caseload audit trail (spec s10 item 6: filing writes the audit log).
        // The caseload_audit_log action CHECK admits 'adverse_event_filed' as
        // of migration 080. Best-effort, never throws (workQueue precedent).
        void insertCaseloadAudit({
          action: 'adverse_event_filed',
          therapistId: req.session.userId ?? null,
          clientId,
          actorUserId: req.session.userId ?? null,
          actorUsername: username,
          detail: { report_id: reportId, severity },
        });

        // Pool work item for the client's care team so the treating therapist
        // sees the draft awaiting review (same shape as the auto-draft hooks;
        // enqueueWorkItem never throws, resolves org/sandbox from the client).
        void enqueueWorkItem({
          itemType: 'adverse_event',
          severity: 'warning',
          title: `Adverse event draft #${reportId} awaiting review`,
          detail: { report_id: reportId, trigger_source: 'manual', filed_by: username, filed_by_role: req.session.userRole },
          sourceTable: 'adverse_event_reports',
          sourceId: String(reportId),
          clientId,
        });

        // Same tier guard as the read routes: caseworker responses never
        // carry transcript_excerpt (null at creation, but keep the invariant).
        const created = await getAdverseEventById(reportId, await scopeFor(req));
        res.status(201).json(
          created && req.session.userRole === 'caseworker' ? scrubForCaseworker(created) : created
        );
      } catch (err) {
        log.error({ err }, 'caseworker filing failed');
        res.status(500).json({ error: 'Failed to file adverse event' });
      }
    }
  );

  return router;
}

/**
 * Does the session's owner belong to `orgId`? Anonymous sessions (no owner)
 * are irb-study custody, mirroring the NULL-org rule in the scope clause.
 * Missing session -> false (caller 404s).
 */
async function sessionInOrg(sessionId: string, orgId: number): Promise<boolean> {
  const info = await getSessionAccessInfo(String(sessionId));
  if (!info) return false;
  if (info.user_id === null || info.user_id === undefined) return (await getIrbStudyOrgId()) === orgId;
  return (await getOrganizationIdForUser(Number(info.user_id))) === orgId;
}
