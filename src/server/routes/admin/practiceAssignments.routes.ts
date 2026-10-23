// Clinician homework API (ai-therapist-200): the writer half of
// practice_assignments that the AI's assign_practice tool never covered.
// Therapists and researchers list, create, edit, cancel and re-issue a
// client's between-session practice from the participant profile.
//
// Access: requireRole('therapist','researcher') (caseworkers 403 — practice
// is clinical content they never author), then requireClientAccess (a
// therapist acts only on caseload clients, 404 otherwise). Researchers are
// org-scoped the way the AE register is (C13): a client outside the caller's
// organization reads as 404, never 403. Every write appends a
// caseload_audit_log row (migration 109 admits the four assignment actions)
// so the trail lives in the existing audit table.
//
// Routes never touch the pool; everything goes through the db barrel.
import { Router, type Request, type Response } from 'express';
import { requireRole } from '../../middleware/auth.js';
import { requireClientAccess } from '../../middleware/caseload.js';
import { orgIdFor, resolveClientOrgId } from '../../middleware/org.js';
import { isCareTeamRole } from '../../../shared/roles.js';
import {
  PRACTICE_CANCEL_REASON_MAX,
  PRACTICE_DESCRIPTION_MAX,
  PRACTICE_FREQUENCIES,
  PRACTICE_KINDS,
  PRACTICE_TITLE_MAX,
  isPracticeFrequency,
  isPracticeKind,
} from '../../../shared/practice.js';
import {
  getUserById,
  insertCaseloadAudit,
  listAssignmentsForClient,
  createAssignment,
  updateAssignment,
  cancelAssignment,
  reissueAssignment,
  type CaseloadAuditAction,
  type PracticeAssignment,
  type UpdateAssignmentFields,
} from '../../db/index.js';

const BASE = '/admin/api/clients/:userId/assignments';

function parseId(raw: string): number | null {
  const id = parseInt(raw, 10);
  return Number.isInteger(id) && id > 0 ? id : null;
}

/** Trimmed string or null; `undefined` when the field was not supplied. */
function textField(value: unknown): string | null | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

/**
 * Resolve the target client for an already role+caseload-gated request.
 * Returns the client id, or null after writing the 404 itself:
 *   - no such user, or not a participant -> 404;
 *   - researcher (non care-team) whose org differs from the client's -> 404.
 * orgIdFor's fail-closed contract applies (throws -> route catch -> 500).
 */
async function resolveClient(req: Request, res: Response): Promise<number | null> {
  const clientId = parseId(req.params.userId);
  if (clientId === null) {
    res.status(400).json({ error: 'Invalid user id' });
    return null;
  }
  const client = await getUserById(clientId);
  if (!client || client.role !== 'participant') {
    res.status(404).json({ error: 'Not found' });
    return null;
  }
  if (!isCareTeamRole(req.session.userRole)) {
    const callerOrg = await orgIdFor(req);
    const clientOrg = await resolveClientOrgId(client, req);
    if (callerOrg === null || clientOrg !== callerOrg) {
      res.status(404).json({ error: 'Not found' });
      return null;
    }
  }
  return clientId;
}

/** Audit one clinician write. Best-effort, never throws (workQueue precedent). */
function audit(req: Request, action: CaseloadAuditAction, clientId: number, detail: Record<string, unknown>): void {
  const actorId = req.session.userId ?? null;
  void insertCaseloadAudit({
    action,
    // therapist_id is the care-team member acting on their caseload; a
    // researcher write carries the actor columns only.
    therapistId: isCareTeamRole(req.session.userRole) ? actorId : null,
    clientId,
    actorUserId: actorId,
    actorUsername: req.session.username ?? null,
    detail,
  });
}

type ValidationResult<T> = { ok: true; value: T } | { ok: false; error: string };

/** Validate create/edit content. `partial` lets PATCH omit fields. */
function validateContent(body: unknown, partial: boolean): ValidationResult<UpdateAssignmentFields> {
  const raw = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
  const fields: UpdateAssignmentFields = {};

  const title = textField(raw.title);
  if (title === null || (!partial && title === undefined)) return { ok: false, error: 'title is required' };
  if (title !== undefined) {
    if (title.length > PRACTICE_TITLE_MAX) return { ok: false, error: `title must be at most ${PRACTICE_TITLE_MAX} characters` };
    fields.title = title;
  }

  const description = textField(raw.description);
  if (description === null || (!partial && description === undefined)) return { ok: false, error: 'description is required' };
  if (description !== undefined) {
    if (description.length > PRACTICE_DESCRIPTION_MAX) {
      return { ok: false, error: `description must be at most ${PRACTICE_DESCRIPTION_MAX} characters` };
    }
    fields.description = description;
  }

  if (raw.kind !== undefined) {
    if (!isPracticeKind(raw.kind)) return { ok: false, error: `kind must be one of: ${PRACTICE_KINDS.join(', ')}` };
    fields.kind = raw.kind;
  } else if (!partial) {
    fields.kind = 'custom';
  }

  if (raw.suggested_frequency !== undefined) {
    if (raw.suggested_frequency === null || raw.suggested_frequency === '') {
      fields.suggestedFrequency = null;
    } else if (isPracticeFrequency(raw.suggested_frequency)) {
      fields.suggestedFrequency = raw.suggested_frequency;
    } else {
      return { ok: false, error: `suggested_frequency must be one of: ${PRACTICE_FREQUENCIES.join(', ')}` };
    }
  } else if (!partial) {
    fields.suggestedFrequency = null;
  }

  if (partial && Object.keys(fields).length === 0) return { ok: false, error: 'no editable fields supplied' };
  return { ok: true, value: fields };
}

function summarize(a: PracticeAssignment): Record<string, unknown> {
  return { assignment_id: a.id, title: a.title, kind: a.kind, suggested_frequency: a.suggested_frequency };
}

export default function practiceAssignmentsRoutes(): Router {
  const router = Router();
  const gate = [requireRole('therapist', 'researcher'), requireClientAccess()];

  // GET: every assignment for the client, all statuses, with completion notes.
  router.get(BASE, ...gate, async (req, res) => {
    try {
      const clientId = await resolveClient(req, res);
      if (clientId === null) return;
      res.json({ assignments: await listAssignmentsForClient(clientId) });
    } catch (err) {
      console.error('[homework] list failed:', err);
      res.status(500).json({ error: 'Failed to load assignments' });
    }
  });

  // POST: create a therapist-authored assignment.
  router.post(BASE, ...gate, async (req, res) => {
    try {
      const clientId = await resolveClient(req, res);
      if (clientId === null) return;
      const parsed = validateContent(req.body, false);
      if (!parsed.ok) return res.status(400).json({ error: parsed.error });
      const f = parsed.value;
      const assignment = await createAssignment({
        userId: clientId,
        authoredBy: req.session.userId as number,
        title: f.title as string,
        description: f.description as string,
        kind: f.kind ?? 'custom',
        suggestedFrequency: f.suggestedFrequency ?? null,
      });
      audit(req, 'assignment_created', clientId, summarize(assignment));
      res.status(201).json({ assignment });
    } catch (err) {
      console.error('[homework] create failed:', err);
      res.status(500).json({ error: 'Failed to create assignment' });
    }
  });

  // PATCH: edit an open assignment (409 once it is completed/cancelled).
  router.patch(`${BASE}/:id`, ...gate, async (req, res) => {
    try {
      const clientId = await resolveClient(req, res);
      if (clientId === null) return;
      const id = parseId(req.params.id);
      if (id === null) return res.status(400).json({ error: 'Invalid assignment id' });
      const parsed = validateContent(req.body, true);
      if (!parsed.ok) return res.status(400).json({ error: parsed.error });
      const assignment = await updateAssignment(id, clientId, parsed.value);
      if (!assignment) return res.status(409).json({ error: 'Assignment is not open for editing' });
      audit(req, 'assignment_updated', clientId, { ...summarize(assignment), fields: Object.keys(parsed.value) });
      res.json({ assignment });
    } catch (err) {
      console.error('[homework] update failed:', err);
      res.status(500).json({ error: 'Failed to update assignment' });
    }
  });

  // POST :id/cancel {reason}: open -> cancelled (never deleted).
  router.post(`${BASE}/:id/cancel`, ...gate, async (req, res) => {
    try {
      const clientId = await resolveClient(req, res);
      if (clientId === null) return;
      const id = parseId(req.params.id);
      if (id === null) return res.status(400).json({ error: 'Invalid assignment id' });
      const reason = textField(req.body?.reason);
      if (!reason) return res.status(400).json({ error: 'reason is required' });
      if (reason.length > PRACTICE_CANCEL_REASON_MAX) {
        return res.status(400).json({ error: `reason must be at most ${PRACTICE_CANCEL_REASON_MAX} characters` });
      }
      const assignment = await cancelAssignment(id, clientId, req.session.userId as number, reason);
      if (!assignment) return res.status(409).json({ error: 'Assignment is not open' });
      audit(req, 'assignment_cancelled', clientId, { ...summarize(assignment), reason });
      res.json({ assignment });
    } catch (err) {
      console.error('[homework] cancel failed:', err);
      res.status(500).json({ error: 'Failed to cancel assignment' });
    }
  });

  // POST :id/reissue: a closed assignment comes back as a new open row
  // linked through reissued_from (409 while the original is still open).
  router.post(`${BASE}/:id/reissue`, ...gate, async (req, res) => {
    try {
      const clientId = await resolveClient(req, res);
      if (clientId === null) return;
      const id = parseId(req.params.id);
      if (id === null) return res.status(400).json({ error: 'Invalid assignment id' });
      const assignment = await reissueAssignment(id, clientId, req.session.userId as number);
      if (!assignment) return res.status(409).json({ error: 'Only a completed, skipped or cancelled assignment can be re-issued' });
      audit(req, 'assignment_reissued', clientId, { ...summarize(assignment), reissued_from: id });
      res.status(201).json({ assignment });
    } catch (err) {
      console.error('[homework] reissue failed:', err);
      res.status(500).json({ error: 'Failed to re-issue assignment' });
    }
  });

  return router;
}
