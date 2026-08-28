// Clinician-facing async messaging routes (caseworker portal,
// docs/caseworker-portal.md section 3). One thread per (client, clinician)
// pair, structurally enforcing the caseworker tier: a clinician only ever
// sees their OWN correspondence with a client (requireThreadClinician,
// 404-over-403), never another clinician's thread. Researchers are blocked
// v1 (clinical correspondence, not study data — Nathan decision 7).
//
// Thread creation verifies an active care-team assignment
// (requireBodyClientAccess: 404 for non-assigned care-team members) and is
// get-or-create — re-assignment of the same pair unfreezes the same thread.
import { Router } from 'express';
import { requireRole } from '../../middleware/auth.js';
import { requireClientAccess, requireBodyClientAccess } from '../../middleware/caseload.js';
import { requireThreadClinician, messagingRateLimit } from '../../middleware/messaging.js';
import { orgIdFor } from '../../middleware/org.js';
import {
  getOrCreateThread,
  getThreadForPair,
  listThreadsForClinician,
  listThreadMessages,
  insertThreadMessage,
  markThreadRead,
  countUnreadForUser,
  isSandboxAccount,
  listMessageOriginCrisisEvents,
  type MessageThreadRow,
  type ThreadMessageRow,
} from '../../db/index.js';
import { userRoom } from '../../services/messageSafety.service.js';
import { isCareTeamRole, type CareTeamRole } from '../../../shared/roles.js';
import { createLogger } from '../../utils/logger.js';
import { parsePagination } from '../../utils/pagination.js';

const log = createLogger('messagingAdmin');

const MAX_BODY_LENGTH = 4000;

/** Participant-facing echo of a clinician send: no scan internals. */
function participantMessageView(m: ThreadMessageRow) {
  return {
    message_id: m.message_id,
    thread_id: m.thread_id,
    sender_id: m.sender_id,
    sender_role: m.sender_role,
    body: m.body,
    created_at: m.created_at,
    flagged: m.scan_status === 'flagged',
  };
}

export default function adminMessagingRoutes(): Router {
  const router = Router();

  const requireClinician = requireRole('therapist', 'caseworker');

  // GET /api/admin/messaging/inbox - the clinician's threads + unread total
  router.get('/api/admin/messaging/inbox', requireClinician, async (req, res) => {
    try {
      const clinicianId = req.session.userId!;
      const [threads, unreadTotal] = await Promise.all([
        listThreadsForClinician(clinicianId),
        countUnreadForUser(clinicianId),
      ]);
      res.json({ threads, unread_total: unreadTotal });
    } catch (err) {
      log.error({ err }, 'Failed to load messaging inbox');
      res.status(500).json({ error: 'Failed to load inbox' });
    }
  });

  // POST /api/admin/messaging/threads - get-or-create own thread with an
  // assigned client (body: { client_id }). 404 when not on the caseload.
  router.post(
    '/api/admin/messaging/threads',
    requireClinician,
    requireBodyClientAccess('client_id'),
    async (req, res) => {
      try {
        const clientId = Number(req.body.client_id);
        const clinicianId = req.session.userId!;
        const role = req.session.userRole;
        if (!isCareTeamRole(role)) {
          // requireRole already guarantees this; belt for the type system.
          return res.status(403).json({ error: 'Insufficient permissions' });
        }
        const orgId = await orgIdFor(req);
        if (orgId === null) {
          log.error(`Could not resolve org for clinician ${clinicianId}; refusing thread create`);
          return res.status(500).json({ error: 'Failed to create thread' });
        }
        const isSandbox = await isSandboxAccount(clientId);
        const thread = await getOrCreateThread({
          clientId,
          clinicianId,
          clinicianRole: role as CareTeamRole,
          orgId,
          isSandbox,
        });
        res.status(201).json({ thread });
      } catch (err) {
        log.error({ err }, 'Failed to create thread');
        res.status(500).json({ error: 'Failed to create thread' });
      }
    }
  );

  // GET /api/admin/messaging/threads/:threadId/messages - own thread only.
  // Clinician view keeps scan fields (risk_score/risk_severity/scan_status):
  // this is the clinician's own correspondence, and the scan verdict is a
  // safety signal, not transcript content from elsewhere.
  router.get(
    '/api/admin/messaging/threads/:threadId/messages',
    requireClinician,
    requireThreadClinician(),
    async (req, res) => {
      try {
        const thread = res.locals.thread as MessageThreadRow;
        const before = Number(req.query.before);
        const { limit } = parsePagination(req.query, { defaultLimit: 50, maxLimit: 200 });
        const messages = await listThreadMessages(thread.thread_id, {
          beforeMessageId: Number.isInteger(before) ? before : null,
          limit,
        });
        res.json({ thread, messages });
      } catch (err) {
        log.error({ err }, 'Failed to list thread messages');
        res.status(500).json({ error: 'Failed to load messages' });
      }
    }
  );

  // POST /api/admin/messaging/threads/:threadId/messages - send (active only).
  // Clinician messages are never scanned: scan_status stays 'not_applicable'.
  router.post(
    '/api/admin/messaging/threads/:threadId/messages',
    requireClinician,
    messagingRateLimit,
    requireThreadClinician({ requireActive: true }),
    async (req, res) => {
      const body = typeof req.body?.body === 'string' ? req.body.body.trim() : '';
      if (!body) {
        return res.status(400).json({ error: 'Message body is required' });
      }
      if (body.length > MAX_BODY_LENGTH) {
        return res.status(400).json({ error: `Message is too long (max ${MAX_BODY_LENGTH} characters)` });
      }
      try {
        const thread = res.locals.thread as MessageThreadRow;
        const role = req.session.userRole as CareTeamRole;
        const message = await insertThreadMessage({
          threadId: thread.thread_id,
          senderId: req.session.userId!,
          senderRole: role,
          body,
          scanStatus: 'not_applicable',
        });

        if (global.io) {
          global.io.to(userRoom(thread.client_id)).emit('messaging:new-message', {
            threadId: thread.thread_id,
            message: participantMessageView(message),
          });
        }

        res.status(201).json({ message });
      } catch (err) {
        log.error({ err }, 'Failed to send message');
        res.status(500).json({ error: 'Failed to send message' });
      }
    }
  );

  // POST /api/admin/messaging/threads/:threadId/read - advance read pointer
  router.post(
    '/api/admin/messaging/threads/:threadId/read',
    requireClinician,
    requireThreadClinician(),
    async (req, res) => {
      const lastReadMessageId = Number(req.body?.last_read_message_id);
      if (!Number.isInteger(lastReadMessageId) || lastReadMessageId < 0) {
        return res.status(400).json({ error: 'Invalid last_read_message_id' });
      }
      try {
        const thread = res.locals.thread as MessageThreadRow;
        await markThreadRead(thread.thread_id, req.session.userId!, lastReadMessageId);
        if (global.io) {
          global.io.to(userRoom(thread.client_id)).emit('messaging:read', {
            threadId: thread.thread_id,
            lastReadMessageId,
            readerId: req.session.userId,
          });
        }
        res.json({ success: true });
      } catch (err) {
        log.error({ err }, 'Failed to mark thread read');
        res.status(500).json({ error: 'Failed to mark thread read' });
      }
    }
  );

  // GET /api/admin/messaging/clients/:userId/threads - the caller's own
  // thread with this client (ParticipantProfile Messages tab). Care-team
  // members 404 off-caseload via requireClientAccess; the response only ever
  // contains the CALLER's thread — never another clinician's.
  router.get(
    '/api/admin/messaging/clients/:userId/threads',
    requireClinician,
    requireClientAccess(),
    async (req, res) => {
      try {
        const clientId = Number(req.params.userId);
        if (!Number.isInteger(clientId)) {
          return res.status(400).json({ error: 'Invalid user id' });
        }
        const thread = await getThreadForPair(clientId, req.session.userId!);
        res.json({ threads: thread ? [thread] : [] });
      } catch (err) {
        log.error({ err }, 'Failed to load client threads');
        res.status(500).json({ error: 'Failed to load threads' });
      }
    }
  );

  // GET /api/admin/messaging/flagged - message-origin crisis events
  // (origin='thread_message', migration 076) for the CrisisManagement embed.
  // Care-team members are scoped to their caseload; researchers are scoped to
  // their organization (C13). orgIdFor THROWS on a failed lookup (-> 500 via
  // the catch below, never an unscoped read); the null guard is belt — null
  // only means unauthenticated, which requireRole already rejects. Payload is
  // summary metadata only (no message bodies; risk_factors are short labels).
  router.get(
    '/api/admin/messaging/flagged',
    requireRole('therapist', 'caseworker', 'researcher'),
    async (req, res) => {
      try {
        const scopeMemberId = isCareTeamRole(req.session.userRole) ? req.session.userId! : null;
        let events: Record<string, unknown>[];
        if (scopeMemberId !== null) {
          events = await listMessageOriginCrisisEvents(scopeMemberId);
        } else {
          const orgId = await orgIdFor(req);
          events = orgId === null ? [] : await listMessageOriginCrisisEvents(null, orgId);
        }
        res.json({ events });
      } catch (err) {
        log.error({ err }, 'Failed to list flagged message events');
        res.status(500).json({ error: 'Failed to load flagged messages' });
      }
    }
  );

  return router;
}
