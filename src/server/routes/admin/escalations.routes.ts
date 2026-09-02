// Escalations API (caseworker portal, docs/caseworker-portal.md sections 2-3).
// A caseworker (or therapist) raises a structured escalation about a client on
// their caseload; it lands with the client's therapist (or the org unassigned
// queue). Lifecycle: open -> acknowledged -> resolved (direct resolve allowed;
// resolved -> open reopen). Every transition is a guarded UPDATE (409 on a
// lost race) and appends an escalation_events row.
//
// Work-queue coupling: escalation create enqueues an 'escalation_inbound'
// item for the target therapist (or pool); ack/resolve/comment enqueue an
// 'escalation_response' item for the raising member. Items go through
// workQueue.service.enqueueWorkItem — the single choke point that inserts
// idempotently, fans out sockets, and drives notifications/email policy.
import { Router } from 'express';
import { requireRole } from '../../middleware/auth.js';
import { requireBodyClientAccess, requireEscalationAccess, careNoteBelongsToClient } from '../../middleware/caseload.js';
import { orgIdFor, resolveClientOrgId } from '../../middleware/org.js';
import {
  createEscalation,
  listEscalations,
  countOpenEscalationsForMember,
  listEscalationEvents,
  insertEscalationEvent,
  acknowledgeEscalation,
  resolveEscalation,
  reopenEscalation,
  claimEscalation,
  expireWorkItemsBySource,
  getUserById,
  getTherapistIdsForClient,
  getCrisisEventClientInfo,
  getSessionAccessInfo,
  assignClientAudited,
  CaseloadRoleError,
  type EscalationRow,
  type EscalationStatus,
  type EscalationUrgency,
  type WorkItemSeverity,
} from '../../db/index.js';
import { emitSummaryEvent } from '../../utils/adminBroadcast.js';
import { enqueueWorkItem } from '../../services/workQueue.service.js';
import { isCareTeamRole, type CareTeamRole } from '../../../shared/roles.js';

const URGENCIES: readonly EscalationUrgency[] = ['routine', 'urgent', 'emergency'];
const STATUSES: readonly EscalationStatus[] = ['open', 'acknowledged', 'resolved'];

/** Work-item severity for an escalation urgency (section 5 delivery policy). */
function severityFor(urgency: EscalationUrgency): WorkItemSeverity {
  if (urgency === 'emergency') return 'urgent';
  if (urgency === 'urgent') return 'warning';
  return 'info';
}

/** Transcript-free socket payload for escalation:created / escalation:updated. */
function socketPayload(escalation: EscalationRow): Record<string, unknown> {
  return {
    escalation_id: escalation.escalation_id,
    client_id: escalation.client_id,
    status: escalation.status,
    urgency: escalation.urgency,
    assigned_to: escalation.assigned_to,
    raised_by: escalation.raised_by,
  };
}

function emitEscalationEvent(event: string, escalation: EscalationRow): void {
  // Summary tier: reaches researchers + the client's therapists + caseworkers.
  // Payload is ids/status/urgency only — no clinical content.
  emitSummaryEvent(event, escalation.client_id, socketPayload(escalation));
}

/** Best-effort escalation_response work item for the raising member.
 *  enqueueWorkItem never throws into the route (queue drift is repaired by
 *  the daily sweep) and handles sandbox stamping + notifications itself. */
async function enqueueResponseItem(
  escalation: EscalationRow,
  eventId: number,
  action: string,
  actorUserId: number
): Promise<void> {
  if (escalation.raised_by === null || escalation.raised_by === actorUserId) return;
  await enqueueWorkItem({
    orgId: escalation.org_id,
    clientId: escalation.client_id,
    assigneeId: escalation.raised_by,
    assigneeRole: escalation.raised_by_role,
    itemType: 'escalation_response',
    severity: 'info',
    title: `Escalation ${action}`,
    detail: { escalation_id: escalation.escalation_id, action },
    sourceTable: 'escalation_events',
    sourceId: String(eventId),
  });
}

export default function escalationsRoutes(): Router {
  const router = Router();

  // POST /admin/api/escalations - raise an escalation about a caseload client
  router.post(
    '/admin/api/escalations',
    requireRole('therapist', 'caseworker'),
    requireBodyClientAccess('client_id'),
    async (req, res) => {
      try {
        const clientId = Number(req.body.client_id);
        const reason = typeof req.body?.reason === 'string' ? req.body.reason.trim().slice(0, 2000) : '';
        if (!reason) return res.status(400).json({ error: 'A reason is required' });
        const urgency = req.body?.urgency as EscalationUrgency;
        if (!URGENCIES.includes(urgency)) {
          return res.status(400).json({ error: `urgency must be one of: ${URGENCIES.join(', ')}` });
        }

        const raisedBy = req.session.userId!;
        const raisedByRole = req.session.userRole as CareTeamRole;

        const client = await getUserById(clientId);
        if (!client) return res.status(404).json({ error: 'Not found' });
        const orgId = await resolveClientOrgId(client, req);
        if (typeof orgId !== 'number') {
          return res.status(500).json({ error: 'Could not resolve organization' });
        }

        // Target therapist: explicit assigned_to must be a therapist on the
        // client's care team; default is the client's first therapist
        // (excluding the raiser); none -> org unassigned queue.
        const therapistIds = await getTherapistIdsForClient(clientId);
        let assignedTo: number | null = null;
        if (req.body?.assigned_to !== undefined && req.body.assigned_to !== null) {
          const requested = Number(req.body.assigned_to);
          if (!Number.isInteger(requested) || !therapistIds.includes(requested)) {
            return res.status(400).json({ error: 'assigned_to must be a therapist on the client care team' });
          }
          assignedTo = requested;
        } else {
          assignedTo = therapistIds.find((id) => id !== raisedBy) ?? null;
        }

        const crisisEventId = Number.isInteger(Number(req.body?.crisis_event_id))
          ? Number(req.body.crisis_event_id)
          : null;
        const sessionId = typeof req.body?.session_id === 'string' ? req.body.session_id : null;
        const noteId = Number.isInteger(Number(req.body?.note_id)) ? Number(req.body.note_id) : null;

        // Linked context must belong to the escalated client: a crisis event
        // (or session) attached to the wrong client would hand the therapist
        // an urgent escalation about the wrong person.
        if (crisisEventId !== null) {
          const eventInfo = await getCrisisEventClientInfo(crisisEventId);
          const eventClientId =
            eventInfo === null
              ? null
              : eventInfo.client_user_id ?? (eventInfo.session_user_id === null ? null : Number(eventInfo.session_user_id));
          if (eventClientId === null || eventClientId !== clientId) {
            return res.status(400).json({ error: 'crisis_event_id does not belong to this client' });
          }
        }
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
        if (noteId !== null && !(await careNoteBelongsToClient(noteId, clientId))) {
          return res.status(400).json({ error: 'note_id does not belong to this client' });
        }

        const escalation = await createEscalation(
          {
            orgId,
            clientId,
            raisedBy,
            raisedByRole,
            assignedTo,
            reason,
            urgency,
            crisisEventId,
            sessionId,
            noteId,
          },
          req.session.username ?? null
        );

        // Single choke point: inserts the item, fans out sockets, and drives
        // notifications/email policy. Never throws into this route.
        await enqueueWorkItem({
          orgId,
          clientId,
          assigneeId: assignedTo,
          assigneeRole: assignedTo === null ? null : 'therapist',
          itemType: 'escalation_inbound',
          severity: severityFor(urgency),
          title: `Escalation (${urgency}) from ${req.session.username ?? 'a care-team member'}`,
          detail: { escalation_id: escalation.escalation_id, urgency, reason: reason.slice(0, 140) },
          sourceTable: 'escalations',
          sourceId: String(escalation.escalation_id),
          isSandbox: client.is_sandbox === true,
          // Spec 072: an EMERGENCY with no assignable therapist must not die
          // in the raiser's own pool — notify every org therapist.
          notifyOrgTherapists: urgency === 'emergency' && assignedTo === null,
        });

        emitEscalationEvent('escalation:created', escalation);
        res.status(201).json({ escalation });
      } catch (err) {
        console.error('[Escalations] create failed:', err);
        res.status(500).json({ error: 'Failed to create escalation' });
      }
    }
  );

  // GET /admin/api/escalations - visible escalations (care team: assignee /
  // raiser / caseload / org-unassigned; researcher: org-wide metadata).
  // ?count_only=1 -> { count } of open items (nav badge); ?mine=1 -> raised by me.
  router.get(
    '/admin/api/escalations',
    requireRole('therapist', 'caseworker', 'researcher'),
    async (req, res) => {
      try {
        const me = req.session.userId!;
        const careTeam = isCareTeamRole(req.session.userRole);

        if (req.query.count_only === '1') {
          if (careTeam) {
            const count = await countOpenEscalationsForMember(me, req.session.userRole as 'therapist' | 'caseworker');
            return res.json({ count });
          }
          const orgId = await orgIdFor(req);
          // Defense-in-depth: under the orgIdFor contract null now means
          // unauthenticated only, but never widen a researcher read to
          // unscoped — fail closed to an empty count.
          if (orgId === null) return res.json({ count: 0 });
          const rows = await listEscalations({ orgId, openOnly: true, limit: 500 });
          return res.json({ count: rows.length });
        }

        const status = typeof req.query.status === 'string' ? (req.query.status as EscalationStatus) : null;
        if (status !== null && !STATUSES.includes(status)) {
          return res.status(400).json({ error: `status must be one of: ${STATUSES.join(', ')}` });
        }
        const clientId = Number.isInteger(Number(req.query.client_id)) && req.query.client_id !== undefined
          ? Number(req.query.client_id)
          : null;

        // Researcher reads are org-scoped; fail closed to an empty list if
        // the org cannot be resolved (null = unauthenticated under the
        // orgIdFor contract — defense-in-depth, never widen to unscoped).
        const orgId = careTeam ? null : await orgIdFor(req);
        if (!careTeam && orgId === null) {
          return res.json({ escalations: [] });
        }
        let escalations = await listEscalations({
          status,
          clientId,
          openOnly: req.query.open_only === '1',
          memberId: careTeam ? me : null,
          memberRole: careTeam ? (req.session.userRole as 'therapist' | 'caseworker') : null,
          orgId,
        });
        if (req.query.mine === '1') {
          escalations = escalations.filter((e) => e.raised_by === me);
        }
        res.json({ escalations });
      } catch (err) {
        console.error('[Escalations] list failed:', err);
        res.status(500).json({ error: 'Failed to list escalations' });
      }
    }
  );

  // GET /admin/api/escalations/:escalationId - detail + event timeline
  router.get(
    '/admin/api/escalations/:escalationId',
    requireRole('therapist', 'caseworker', 'researcher'),
    requireEscalationAccess(),
    async (req, res) => {
      try {
        const escalation = res.locals.escalation as EscalationRow;
        const events = await listEscalationEvents(escalation.escalation_id);
        res.json({ escalation, events });
      } catch (err) {
        console.error('[Escalations] detail failed:', err);
        res.status(500).json({ error: 'Failed to fetch escalation' });
      }
    }
  );

  // POST /admin/api/escalations/:escalationId/acknowledge - assignee only
  router.post(
    '/admin/api/escalations/:escalationId/acknowledge',
    requireRole('therapist'),
    requireEscalationAccess(),
    async (req, res) => {
      try {
        const escalation = res.locals.escalation as EscalationRow;
        const me = req.session.userId!;
        if (escalation.assigned_to !== me) {
          return res.status(403).json({ error: 'Only the assigned therapist can acknowledge' });
        }
        const updated = await acknowledgeEscalation(escalation.escalation_id, me);
        if (!updated) return res.status(409).json({ error: 'Escalation is not open' });
        const event = await insertEscalationEvent({
          escalationId: escalation.escalation_id,
          eventType: 'acknowledged',
          actorUserId: me,
          actorUsername: req.session.username ?? null,
        });
        await enqueueResponseItem(updated, event.event_id, 'acknowledged', me);
        emitEscalationEvent('escalation:updated', updated);
        res.json({ escalation: updated });
      } catch (err) {
        console.error('[Escalations] acknowledge failed:', err);
        res.status(500).json({ error: 'Failed to acknowledge escalation' });
      }
    }
  );

  // POST /admin/api/escalations/:escalationId/resolve - assignee only
  router.post(
    '/admin/api/escalations/:escalationId/resolve',
    requireRole('therapist'),
    requireEscalationAccess(),
    async (req, res) => {
      try {
        const escalation = res.locals.escalation as EscalationRow;
        const me = req.session.userId!;
        if (escalation.assigned_to !== me) {
          return res.status(403).json({ error: 'Only the assigned therapist can resolve' });
        }
        const resolutionNote =
          typeof req.body?.resolution_note === 'string'
            ? req.body.resolution_note.trim().slice(0, 2000) || null
            : null;
        const updated = await resolveEscalation(escalation.escalation_id, me, resolutionNote);
        if (!updated) return res.status(409).json({ error: 'Escalation is already resolved' });
        const event = await insertEscalationEvent({
          escalationId: escalation.escalation_id,
          eventType: 'resolved',
          actorUserId: me,
          actorUsername: req.session.username ?? null,
          detail: resolutionNote ? { resolution_note: resolutionNote } : undefined,
        });
        await enqueueResponseItem(updated, event.event_id, 'resolved', me);
        try {
          await expireWorkItemsBySource('escalation_inbound', 'escalations', [
            String(escalation.escalation_id),
          ]);
        } catch (err) {
          console.error('[Escalations] expiring escalation_inbound work item failed:', err);
        }
        emitEscalationEvent('escalation:updated', updated);
        res.json({ escalation: updated });
      } catch (err) {
        console.error('[Escalations] resolve failed:', err);
        res.status(500).json({ error: 'Failed to resolve escalation' });
      }
    }
  );

  // POST /admin/api/escalations/:escalationId/reopen - raiser or care team
  router.post(
    '/admin/api/escalations/:escalationId/reopen',
    requireRole('therapist', 'caseworker'),
    requireEscalationAccess(),
    async (req, res) => {
      try {
        const escalation = res.locals.escalation as EscalationRow;
        const me = req.session.userId!;
        const updated = await reopenEscalation(escalation.escalation_id);
        if (!updated) return res.status(409).json({ error: 'Only resolved escalations can be reopened' });
        await insertEscalationEvent({
          escalationId: escalation.escalation_id,
          eventType: 'reopened',
          actorUserId: me,
          actorUsername: req.session.username ?? null,
        });
        // Re-surface the escalation in the work queue: resolving expired the
        // escalation_inbound item, so `reopen` reactivates that same row (the
        // UNIQUE source key blocks a plain re-insert) and re-notifies the
        // assignee (or the pool / all org therapists for an unassigned
        // emergency). Never throws into this route.
        await enqueueWorkItem({
          orgId: updated.org_id,
          clientId: updated.client_id,
          assigneeId: updated.assigned_to,
          assigneeRole: updated.assigned_to === null ? null : 'therapist',
          itemType: 'escalation_inbound',
          severity: severityFor(updated.urgency),
          title: `Escalation reopened (${updated.urgency}) by ${req.session.username ?? 'a care-team member'}`,
          detail: { escalation_id: updated.escalation_id, urgency: updated.urgency, reopened: true },
          sourceTable: 'escalations',
          sourceId: String(updated.escalation_id),
          reopen: true,
          notifyOrgTherapists: updated.urgency === 'emergency' && updated.assigned_to === null,
        });
        emitEscalationEvent('escalation:updated', updated);
        res.json({ escalation: updated });
      } catch (err) {
        console.error('[Escalations] reopen failed:', err);
        res.status(500).json({ error: 'Failed to reopen escalation' });
      }
    }
  );

  // POST /admin/api/escalations/:escalationId/comments - coordination timeline
  router.post(
    '/admin/api/escalations/:escalationId/comments',
    requireRole('therapist', 'caseworker', 'researcher'),
    requireEscalationAccess(),
    async (req, res) => {
      try {
        const escalation = res.locals.escalation as EscalationRow;
        const me = req.session.userId!;
        const comment = typeof req.body?.comment === 'string' ? req.body.comment.trim().slice(0, 2000) : '';
        if (!comment) return res.status(400).json({ error: 'A comment is required' });
        const event = await insertEscalationEvent({
          escalationId: escalation.escalation_id,
          eventType: 'comment',
          actorUserId: me,
          actorUsername: req.session.username ?? null,
          detail: { comment },
        });
        await enqueueResponseItem(escalation, event.event_id, 'commented on', me);
        emitEscalationEvent('escalation:updated', escalation);
        res.status(201).json({ event });
      } catch (err) {
        console.error('[Escalations] comment failed:', err);
        res.status(500).json({ error: 'Failed to add comment' });
      }
    }
  );

  // POST /admin/api/escalations/:escalationId/claim - any same-org therapist
  // claims an unassigned escalation; claiming auto-assigns the client to the
  // claimer's caseload (audited) so they can act — Q4, approved.
  router.post(
    '/admin/api/escalations/:escalationId/claim',
    requireRole('therapist'),
    requireEscalationAccess(),
    async (req, res) => {
      try {
        const escalation = res.locals.escalation as EscalationRow;
        const me = req.session.userId!;
        const orgId = await orgIdFor(req);
        if (orgId === null || orgId !== escalation.org_id) {
          return res.status(404).json({ error: 'Not found' });
        }
        const updated = await claimEscalation(escalation.escalation_id, me);
        if (!updated) return res.status(409).json({ error: 'Escalation is already assigned or resolved' });

        // Grant caseload access so the claimer can act. Grant + audit row are
        // ONE transaction (ai-therapist-145): this is a therapist gaining
        // access to a participant they had no prior caseload edge to, so an
        // unlogged grant must be impossible — if the audit insert fails, the
        // grant rolls back with it.
        try {
          await assignClientAudited(me, escalation.client_id, me, {
            actorUserId: me,
            actorUsername: req.session.username ?? null,
            detail: { via: 'escalation_claim', escalation_id: escalation.escalation_id },
          });
        } catch (err) {
          if (!(err instanceof CaseloadRoleError)) throw err;
          console.error('[Escalations] claim auto-assign rejected:', err.message);
        }

        await insertEscalationEvent({
          escalationId: escalation.escalation_id,
          eventType: 'claimed',
          actorUserId: me,
          actorUsername: req.session.username ?? null,
        });
        emitEscalationEvent('escalation:updated', updated);
        res.json({ escalation: updated });
      } catch (err) {
        console.error('[Escalations] claim failed:', err);
        res.status(500).json({ error: 'Failed to claim escalation' });
      }
    }
  );

  return router;
}
