// Admin API for IRB adverse-event reports (ai-therapist-95). Reads are
// therapist/researcher; edits + sign-off are therapist+researcher (sign-off is
// clinical + study staff). Lifecycle transitions that don't apply return 409.
// Caseworker AE filing (docs/caseworker-portal.md section 10 item 6):
// caseworkers can FILE a report for a caseload client and view ONLY their own
// filed reports (list/detail filtered to reporter); review, triage, and
// lifecycle management stay therapist+researcher.
import { Router } from 'express';
import { requireRole } from '../../middleware/auth.js';
import { requireClientAccess } from '../../middleware/caseload.js';
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
  type UpdateAdverseEventFields,
  type AdverseEventRowWithFlags,
  type AdverseEventActionEntry,
  type AdverseEventCounts,
} from '../../db/index.js';
import { enqueueWorkItem } from '../../services/workQueue.service.js';
import { renderAdverseEventPrintHtml } from '../../utils/aePrintView.js';

/** Summaries-tier projection for caseworker reads: a reviewer may attach a
 *  (redacted) transcript excerpt to a caseworker-filed draft, and caseworkers
 *  never see transcript content — not even content_redacted. */
function scrubForCaseworker(row: AdverseEventRowWithFlags): AdverseEventRowWithFlags {
  return { ...row, transcript_excerpt: null };
}

/** Counts strip for a caseworker's own-reports slice (the global SQL counts
 *  would leak other reporters' queue state). Mirrors getAdverseEventCounts. */
function countsFor(rows: AdverseEventRowWithFlags[]): AdverseEventCounts {
  const now = Date.now();
  const drafts = rows.filter((r) => r.status === 'draft');
  return {
    draft: drafts.length,
    submitted: rows.filter((r) => r.status === 'submitted').length,
    overdue: drafts.filter((r) => r.overdue).length,
    due_soon: drafts.filter((r) => {
      const due = new Date(r.due_at).getTime();
      return due >= now && due < now + 48 * 3_600_000;
    }).length,
  };
}

export default function adverseEventsRoutes(): Router {
  const router = Router();
  // Reads: caseworkers included, but row-filtered to their own filed reports.
  const canRead = requireRole('therapist', 'researcher', 'caseworker');
  // Review/triage/lifecycle stays full-tier (spec s10 item 6).
  const canReview = requireRole('therapist', 'researcher');
  const canWrite = requireRole('therapist', 'researcher');
  const VALID_SEVERITIES = ['low', 'medium', 'high'] as const;

  // List + counts (optional ?status= draft|submitted|closed|all).
  // Caseworkers see ONLY reports they filed (created_by = own username).
  router.get('/admin/api/adverse-events', canRead, async (req, res) => {
    const status = typeof req.query.status === 'string' ? req.query.status : null;
    try {
      if (req.session.userRole === 'caseworker') {
        const mine = (await listAdverseEvents({ status: 'all' }))
          .filter((r) => r.created_by === req.session.username);
        const wanted = status && status !== 'all' ? status : null;
        const reports = (wanted === null ? mine : mine.filter((r) => r.status === wanted)).map(scrubForCaseworker);
        return res.json({ counts: countsFor(mine), reports });
      }
      const [counts, reports] = await Promise.all([getAdverseEventCounts(), listAdverseEvents({ status })]);
      res.json({ counts, reports });
    } catch (err) {
      console.error('[AE] list failed:', err);
      res.status(500).json({ error: 'Failed to load adverse events' });
    }
  });

  // Single report (must precede the /:id/print route in matching order below is fine — distinct paths).
  // Caseworkers can load only reports they filed; anyone else's is 404 (never
  // 403 — existence must not be confirmable, matching the caseload middleware).
  router.get('/admin/api/adverse-events/:id', canRead, async (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'invalid id' });
    try {
      const row = await getAdverseEventById(id);
      if (!row) return res.status(404).json({ error: 'not found' });
      if (req.session.userRole === 'caseworker') {
        if (row.created_by !== req.session.username) {
          return res.status(404).json({ error: 'not found' });
        }
        return res.json(scrubForCaseworker(row));
      }
      res.json(row);
    } catch (err) {
      console.error('[AE] get failed:', err);
      res.status(500).json({ error: 'Failed to load adverse event' });
    }
  });

  // Print / export view (standalone HTML). Review surface: full tier only.
  router.get('/admin/api/adverse-events/:id/print', canReview, async (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id)) return res.status(400).send('invalid id');
    try {
      const row = await getAdverseEventById(id);
      if (!row) return res.status(404).send('not found');
      res.set('Content-Type', 'text/html; charset=utf-8').send(renderAdverseEventPrintHtml(row));
    } catch (err) {
      console.error('[AE] print failed:', err);
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
      const ok = await updateAdverseEventDraft(id, fields);
      if (!ok) {
        const row = await getAdverseEventById(id);
        if (!row) return res.status(404).json({ error: 'not found' });
        return res.status(409).json({ error: 'report is not a draft' });
      }
      res.json(await getAdverseEventById(id));
    } catch (err) {
      console.error('[AE] update failed:', err);
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
      const ok = await submitAdverseEvent(id, submittedBy);
      if (!ok) return await conflictOrNotFound(id, res, 'report is not a draft');
      res.json(await getAdverseEventById(id));
    } catch (err) {
      console.error('[AE] submit failed:', err);
      res.status(500).json({ error: 'Failed to submit adverse event' });
    }
  });

  // submitted -> draft (pre-close corrections).
  router.post('/admin/api/adverse-events/:id/reopen', canWrite, async (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'invalid id' });
    try {
      const ok = await reopenAdverseEvent(id);
      if (!ok) return await conflictOrNotFound(id, res, 'report is not submitted');
      res.json(await getAdverseEventById(id));
    } catch (err) {
      console.error('[AE] reopen failed:', err);
      res.status(500).json({ error: 'Failed to reopen adverse event' });
    }
  });

  // submitted -> closed.
  router.post('/admin/api/adverse-events/:id/close', canWrite, async (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'invalid id' });
    const closedBy = req.session.username ?? 'unknown-admin';
    try {
      const ok = await closeAdverseEvent(id, closedBy);
      if (!ok) return await conflictOrNotFound(id, res, 'report is not submitted');
      res.json(await getAdverseEventById(id));
    } catch (err) {
      console.error('[AE] close failed:', err);
      res.status(500).json({ error: 'Failed to close adverse event' });
    }
  });

  // Manually file an AE from a session (trigger_source='manual'); reuses the
  // draft assembler with crisis_event_id=null so it never collides with auto.
  router.post('/admin/api/sessions/:sessionId/adverse-events', canWrite, async (req, res) => {
    const createdBy = req.session.username ?? 'unknown-admin';
    try {
      const { draftAdverseEventFromCrisis } = await import('../../services/adverseEvent.service.js');
      const reportId = await draftAdverseEventFromCrisis(req.params.sessionId, { triggerSource: 'manual', createdBy });
      if (reportId == null) return res.status(422).json({ error: 'Could not draft an adverse event for this session' });
      res.status(201).json(await getAdverseEventById(reportId));
    } catch (err) {
      console.error('[AE] manual draft failed:', err);
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
        const created = await getAdverseEventById(reportId);
        res.status(201).json(
          created && req.session.userRole === 'caseworker' ? scrubForCaseworker(created) : created
        );
      } catch (err) {
        console.error('[AE] caseworker filing failed:', err);
        res.status(500).json({ error: 'Failed to file adverse event' });
      }
    }
  );

  return router;
}

/** 404 if the row is gone, else 409 with the given transition message. */
async function conflictOrNotFound(id: number, res: import('express').Response, message: string) {
  const row = await getAdverseEventById(id);
  if (!row) return res.status(404).json({ error: 'not found' });
  return res.status(409).json({ error: message });
}
