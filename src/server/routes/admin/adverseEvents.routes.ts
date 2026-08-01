// Admin API for IRB adverse-event reports (ai-therapist-95). Reads are
// therapist/researcher; edits + sign-off are therapist+researcher (sign-off is
// clinical + study staff). Lifecycle transitions that don't apply return 409.
import { Router } from 'express';
import { requireRole } from '../../middleware/auth.js';
import {
  listAdverseEvents,
  getAdverseEventCounts,
  getAdverseEventById,
  updateAdverseEventDraft,
  submitAdverseEvent,
  closeAdverseEvent,
  reopenAdverseEvent,
  type UpdateAdverseEventFields,
} from '../../db/index.js';
import { renderAdverseEventPrintHtml } from '../../utils/aePrintView.js';

export default function adverseEventsRoutes(): Router {
  const router = Router();
  const canRead = requireRole('therapist', 'researcher');
  const canWrite = requireRole('therapist', 'researcher');

  // List + counts (optional ?status= draft|submitted|closed|all).
  router.get('/admin/api/adverse-events', canRead, async (req, res) => {
    const status = typeof req.query.status === 'string' ? req.query.status : null;
    try {
      const [counts, reports] = await Promise.all([getAdverseEventCounts(), listAdverseEvents({ status })]);
      res.json({ counts, reports });
    } catch (err) {
      console.error('[AE] list failed:', err);
      res.status(500).json({ error: 'Failed to load adverse events' });
    }
  });

  // Single report (must precede the /:id/print route in matching order below is fine — distinct paths).
  router.get('/admin/api/adverse-events/:id', canRead, async (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'invalid id' });
    try {
      const row = await getAdverseEventById(id);
      if (!row) return res.status(404).json({ error: 'not found' });
      res.json(row);
    } catch (err) {
      console.error('[AE] get failed:', err);
      res.status(500).json({ error: 'Failed to load adverse event' });
    }
  });

  // Print / export view (standalone HTML).
  router.get('/admin/api/adverse-events/:id/print', canRead, async (req, res) => {
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

  return router;
}

/** 404 if the row is gone, else 409 with the given transition message. */
async function conflictOrNotFound(id: number, res: import('express').Response, message: string) {
  const row = await getAdverseEventById(id);
  if (!row) return res.status(404).json({ error: 'not found' });
  return res.status(409).json({ error: message });
}
