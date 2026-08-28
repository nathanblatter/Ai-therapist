// Care notes API (caseworker portal, docs/caseworker-portal.md sections 1-3).
// One table backs therapist progress notes (SOAP) and caseworker case notes
// (note_type discriminator). Lifecycle: draft (author edits/deletes freely)
// -> sign (sign_hash, DB-trigger immutability) -> amend (new linked draft;
// signing it flips the original to 'amended').
//
// Visibility is enforced by requireNoteAccess (404-over-403): therapists see
// all care-team notes for their caseload clients; caseworkers see case notes,
// progress notes only when shared_with_care_team, and their own drafts.
// Caseworkers author case notes only (400 + DB CHECK).
import { Router } from 'express';
import { requireRole } from '../../middleware/auth.js';
import {
  requireClientAccess,
  requireNoteAccess,
  requireSessionClientAccess,
} from '../../middleware/caseload.js';
import { resolveClientOrgId } from '../../middleware/org.js';
import {
  createCareNote,
  listCareNotesForClient,
  updateCareNoteDraft,
  deleteCareNoteDraft,
  signCareNote,
  createCareNoteAmendment,
  setCareNoteShared,
  getLiveProgressNoteForSession,
  getSessionInsights,
  getSessionAccessInfo,
  getUserById,
  markSoapReviewed,
  expireWorkItemsBySource,
  type CareNoteRow,
  type CareNoteType,
  type CaseNoteKind,
} from '../../db/index.js';
import { emitSummaryEvent } from '../../utils/adminBroadcast.js';
import { enqueueWorkItem } from '../../services/workQueue.service.js';
import type { CareTeamRole } from '../../../shared/roles.js';

const CASE_NOTE_KINDS: readonly CaseNoteKind[] = [
  'contact',
  'referral',
  'coordination',
  'safety_check',
  'other',
];
const SOAP_FIELDS = ['subjective', 'objective', 'assessment', 'plan'] as const;
const MAX_FIELD = 8000;

function cleanString(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, max) : null;
}

/**
 * Validate + whitelist note content by type. Returns the sanitized content
 * object, or null when the shape is invalid (route 400s).
 * progress: {subjective?, objective?, assessment?, plan?} — at least one.
 * case: {narrative, contact_method?, referral_to?, outcome?}.
 */
function sanitizeContent(noteType: CareNoteType, raw: unknown): Record<string, unknown> | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const body = raw as Record<string, unknown>;
  if (noteType === 'progress') {
    const content: Record<string, string> = {};
    for (const field of SOAP_FIELDS) {
      const value = cleanString(body[field], MAX_FIELD);
      if (value !== null) content[field] = value;
    }
    return Object.keys(content).length > 0 ? content : null;
  }
  const narrative = cleanString(body.narrative, MAX_FIELD);
  if (narrative === null) return null;
  const content: Record<string, string> = { narrative };
  for (const field of ['contact_method', 'referral_to', 'outcome'] as const) {
    const value = cleanString(body[field], 500);
    if (value !== null) content[field] = value;
  }
  return content;
}

/** Emit note:signed to the care-team rooms only when the note is visible to
 *  the whole team (case notes always; progress notes when shared). */
function emitNoteSigned(note: CareNoteRow): void {
  if (note.note_type === 'progress' && !note.shared_with_care_team) return;
  emitSummaryEvent('note:signed', note.client_id, {
    note_id: note.note_id,
    client_id: note.client_id,
    note_type: note.note_type,
    shared: note.shared_with_care_team,
  });
}

export default function notesRoutes(): Router {
  const router = Router();

  // POST /admin/api/users/:userId/notes - create a draft note for a client
  router.post(
    '/admin/api/users/:userId/notes',
    requireRole('therapist', 'caseworker'),
    requireClientAccess(),
    async (req, res) => {
      try {
        const clientId = parseInt(req.params.userId, 10);
        if (!Number.isInteger(clientId)) return res.status(400).json({ error: 'Invalid user id' });

        const authorRole = req.session.userRole as CareTeamRole;
        const noteType = req.body?.note_type as CareNoteType;
        if (noteType !== 'progress' && noteType !== 'case') {
          return res.status(400).json({ error: "note_type must be 'progress' or 'case'" });
        }
        if (authorRole === 'caseworker' && noteType !== 'case') {
          return res.status(400).json({ error: 'Caseworkers author case notes only' });
        }

        let caseNoteKind: CaseNoteKind | null = null;
        if (noteType === 'case') {
          caseNoteKind = req.body?.case_note_kind ?? 'other';
          if (!CASE_NOTE_KINDS.includes(caseNoteKind as CaseNoteKind)) {
            return res.status(400).json({ error: `case_note_kind must be one of: ${CASE_NOTE_KINDS.join(', ')}` });
          }
        }

        const content = sanitizeContent(noteType, req.body?.content);
        if (!content) return res.status(400).json({ error: 'Invalid note content' });

        const client = await getUserById(clientId);
        if (!client) return res.status(404).json({ error: 'Not found' });
        const orgId = await resolveClientOrgId(client, req);
        if (typeof orgId !== 'number') {
          return res.status(500).json({ error: 'Could not resolve organization' });
        }

        // A linked session must belong to THIS client — otherwise a note
        // could be attached to another client's session (cross-client leak
        // in every session-scoped notes surface).
        const sessionId = typeof req.body?.session_id === 'string' ? req.body.session_id : null;
        if (sessionId !== null) {
          const sessionInfo = await getSessionAccessInfo(sessionId);
          const sessionOwner =
            sessionInfo?.user_id === null || sessionInfo?.user_id === undefined
              ? null
              : Number(sessionInfo.user_id);
          if (sessionOwner === null || sessionOwner !== clientId) {
            return res.status(400).json({ error: 'session_id does not belong to this client' });
          }
        }

        let note: CareNoteRow;
        try {
          note = await createCareNote({
            orgId,
            clientId,
            authorId: req.session.userId!,
            authorName: req.session.username ?? 'unknown',
            authorRole,
            noteType,
            caseNoteKind,
            sessionId,
            content,
          });
        } catch (err) {
          // idx_care_notes_session_progress: one live progress note per
          // session. A duplicate is a client-resolvable conflict, not a 500.
          if ((err as { code?: string })?.code === '23505') {
            return res.status(409).json({ error: 'A live progress note already exists for this session' });
          }
          throw err;
        }
        res.status(201).json({ note });
      } catch (err) {
        console.error('[Notes] create failed:', err);
        res.status(500).json({ error: 'Failed to create note' });
      }
    }
  );

  // GET /admin/api/users/:userId/notes - the client's notes visible to me
  router.get(
    '/admin/api/users/:userId/notes',
    requireRole('therapist', 'caseworker'),
    requireClientAccess(),
    async (req, res) => {
      try {
        const clientId = parseInt(req.params.userId, 10);
        if (!Number.isInteger(clientId)) return res.status(400).json({ error: 'Invalid user id' });
        const notes = await listCareNotesForClient(clientId, {
          userId: req.session.userId!,
          role: req.session.userRole as CareTeamRole,
        });
        res.json({ notes });
      } catch (err) {
        console.error('[Notes] list failed:', err);
        res.status(500).json({ error: 'Failed to list notes' });
      }
    }
  );

  // GET /admin/api/notes/:noteId - one note (visibility via requireNoteAccess)
  router.get('/admin/api/notes/:noteId', requireNoteAccess(), (_req, res) => {
    res.json({ note: res.locals.careNote as CareNoteRow });
  });

  // PUT /admin/api/notes/:noteId - author edits their own draft
  router.put('/admin/api/notes/:noteId', requireNoteAccess(), async (req, res) => {
    try {
      const note = res.locals.careNote as CareNoteRow;
      if (note.author_id !== req.session.userId) {
        return res.status(403).json({ error: 'Only the author can edit a note' });
      }
      if (note.status !== 'draft') {
        return res.status(409).json({ error: 'Signed notes are immutable; amend instead' });
      }

      let content: Record<string, unknown> | undefined;
      if (req.body?.content !== undefined) {
        const sanitized = sanitizeContent(note.note_type, req.body.content);
        if (!sanitized) return res.status(400).json({ error: 'Invalid note content' });
        content = sanitized;
      }
      // undefined = leave unchanged; explicit null = clear the kind.
      let caseNoteKind: CaseNoteKind | null | undefined;
      if (req.body?.case_note_kind !== undefined) {
        const rawKind = req.body.case_note_kind;
        if (note.note_type !== 'case' || (rawKind !== null && !CASE_NOTE_KINDS.includes(rawKind))) {
          return res.status(400).json({ error: 'Invalid case_note_kind' });
        }
        caseNoteKind = rawKind as CaseNoteKind | null;
      }

      const updated = await updateCareNoteDraft(note.note_id, req.session.userId!, {
        content,
        ...(caseNoteKind !== undefined ? { caseNoteKind } : {}),
      });
      if (!updated) return res.status(409).json({ error: 'Note is no longer an editable draft' });
      res.json({ note: updated });
    } catch (err) {
      console.error('[Notes] update failed:', err);
      res.status(500).json({ error: 'Failed to update note' });
    }
  });

  // DELETE /admin/api/notes/:noteId - author deletes their own draft
  router.delete('/admin/api/notes/:noteId', requireNoteAccess(), async (req, res) => {
    try {
      const note = res.locals.careNote as CareNoteRow;
      if (note.author_id !== req.session.userId) {
        return res.status(403).json({ error: 'Only the author can delete a note' });
      }
      if (note.status !== 'draft') {
        return res.status(409).json({ error: 'Signed notes cannot be deleted' });
      }
      const deleted = await deleteCareNoteDraft(note.note_id, req.session.userId!);
      if (!deleted) return res.status(409).json({ error: 'Note is no longer a draft' });
      res.json({ success: true });
    } catch (err) {
      console.error('[Notes] delete failed:', err);
      res.status(500).json({ error: 'Failed to delete note' });
    }
  });

  // POST /admin/api/notes/:noteId/sign - author signs their draft (immutable
  // from here; signing an AI-seeded note also marks the SOAP draft reviewed)
  router.post('/admin/api/notes/:noteId/sign', requireNoteAccess(), async (req, res) => {
    try {
      const note = res.locals.careNote as CareNoteRow;
      if (note.author_id !== req.session.userId) {
        return res.status(403).json({ error: 'Only the author can sign a note' });
      }
      if (note.status !== 'draft') {
        return res.status(409).json({ error: 'Only drafts can be signed' });
      }
      const signed = await signCareNote(note.note_id, req.session.userId!);
      if (!signed) return res.status(409).json({ error: 'Note is no longer a signable draft' });

      if (signed.seed_source === 'ai_soap' && signed.session_id) {
        try {
          await markSoapReviewed(signed.session_id, req.session.username ?? 'unknown');
        } catch (err) {
          console.error('[Notes] markSoapReviewed after sign failed:', err);
        }
      }
      try {
        await expireWorkItemsBySource('note_awaiting_signature', 'care_notes', [String(signed.note_id)]);
      } catch (err) {
        console.error('[Notes] expiring note_awaiting_signature work item failed:', err);
      }
      emitNoteSigned(signed);
      res.json({ note: signed });
    } catch (err) {
      console.error('[Notes] sign failed:', err);
      res.status(500).json({ error: 'Failed to sign note' });
    }
  });

  // POST /admin/api/notes/:noteId/amend - start an amendment draft of a
  // signed note (author only; content copied, linked via amends_note_id)
  router.post('/admin/api/notes/:noteId/amend', requireNoteAccess(), async (req, res) => {
    try {
      const note = res.locals.careNote as CareNoteRow;
      if (note.author_id !== req.session.userId) {
        return res.status(403).json({ error: 'Only the author can amend a note' });
      }
      if (note.status !== 'signed') {
        return res.status(409).json({ error: 'Only signed notes can be amended' });
      }
      const amendment = await createCareNoteAmendment(note.note_id, req.session.userId!);
      if (!amendment) return res.status(409).json({ error: 'Note is not amendable' });
      res.status(201).json({ note: amendment });
    } catch (err) {
      console.error('[Notes] amend failed:', err);
      res.status(500).json({ error: 'Failed to amend note' });
    }
  });

  // POST /admin/api/notes/:noteId/share - author toggles care-team sharing on
  // a progress note (case notes are always care-team visible)
  router.post('/admin/api/notes/:noteId/share', requireNoteAccess(), async (req, res) => {
    try {
      const note = res.locals.careNote as CareNoteRow;
      if (note.author_id !== req.session.userId) {
        return res.status(403).json({ error: 'Only the author can change sharing' });
      }
      if (note.note_type !== 'progress') {
        return res.status(400).json({ error: 'Case notes are always visible to the care team' });
      }
      const shared = req.body?.shared === true;
      const updated = await setCareNoteShared(note.note_id, req.session.userId!, shared);
      if (!updated) return res.status(404).json({ error: 'Not found' });
      res.json({ note: updated });
    } catch (err) {
      console.error('[Notes] share failed:', err);
      res.status(500).json({ error: 'Failed to update sharing' });
    }
  });

  // POST /admin/api/sessions/:sessionId/notes/from-insights - seed a progress
  // note draft from the session's AI SOAP draft. Idempotent per session via
  // the unique partial index (live progress note per session).
  router.post(
    '/admin/api/sessions/:sessionId/notes/from-insights',
    requireRole('therapist'),
    requireSessionClientAccess(),
    async (req, res) => {
      try {
        const sessionId = req.params.sessionId;

        const existing = await getLiveProgressNoteForSession(sessionId);
        if (existing) return res.json({ note: existing, existing: true });

        const insights = await getSessionInsights(sessionId);
        if (!insights?.soap_note) {
          return res.status(422).json({ error: 'No AI SOAP draft for this session' });
        }
        const info = await getSessionAccessInfo(sessionId);
        const clientId = info?.user_id === null || info?.user_id === undefined ? null : Number(info.user_id);
        if (clientId === null || !Number.isInteger(clientId)) {
          return res.status(422).json({ error: 'Session has no logged-in participant' });
        }
        const client = await getUserById(clientId);
        if (!client) return res.status(404).json({ error: 'Not found' });
        const orgId = await resolveClientOrgId(client, req);
        if (typeof orgId !== 'number') {
          return res.status(500).json({ error: 'Could not resolve organization' });
        }

        const content: Record<string, string> = {};
        for (const field of SOAP_FIELDS) {
          const value = cleanString(insights.soap_note[field], MAX_FIELD);
          if (value !== null) content[field] = value;
        }
        if (Object.keys(content).length === 0) {
          return res.status(422).json({ error: 'AI SOAP draft is empty' });
        }

        let note: CareNoteRow;
        try {
          note = await createCareNote({
            orgId,
            clientId,
            authorId: req.session.userId!,
            authorName: req.session.username ?? 'unknown',
            authorRole: 'therapist',
            noteType: 'progress',
            sessionId,
            seedSource: 'ai_soap',
            seedModel: insights.model ?? null,
            content,
          });
        } catch (err) {
          // Unique partial index race: someone else seeded first — return theirs.
          if ((err as { code?: string })?.code === '23505') {
            const raced = await getLiveProgressNoteForSession(sessionId);
            if (raced) return res.json({ note: raced, existing: true });
          }
          throw err;
        }

        // Single choke point: inserts the item, fans out sockets, and drives
        // notifications/email policy. Never throws into this route.
        await enqueueWorkItem({
          orgId,
          clientId,
          assigneeId: req.session.userId!,
          assigneeRole: 'therapist',
          itemType: 'note_awaiting_signature',
          severity: 'info',
          title: 'Progress note draft awaiting signature',
          detail: { note_id: note.note_id, session_id: sessionId },
          sourceTable: 'care_notes',
          sourceId: String(note.note_id),
          isSandbox: client.is_sandbox === true,
        });

        res.status(201).json({ note, existing: false });
      } catch (err) {
        console.error('[Notes] from-insights seed failed:', err);
        res.status(500).json({ error: 'Failed to seed note from insights' });
      }
    }
  );

  return router;
}
