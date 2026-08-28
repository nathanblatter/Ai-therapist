// Participant-facing async messaging routes (caseworker portal,
// docs/caseworker-portal.md section 3). Participants read and write ONLY
// their own threads (requireThreadParticipant: 404-over-403, thread
// existence never confirmed to a non-party) and cannot create threads —
// threads are created clinician-side against an active care-team assignment.
//
// Not for emergencies: messages are scanned asynchronously and answered on a
// 1-2 business day cadence; the UI carries the crisis-resources disclaimer.
// Participant payloads NEVER include risk_score/risk_severity — only a
// boolean `flagged` (drives the supportive-resources banner client-side).
import { Router } from 'express';
import { requireAuth } from '../../middleware/auth.js';
import { requireThreadParticipant, messagingRateLimit } from '../../middleware/messaging.js';
import {
  listThreadsForClient,
  listThreadMessages,
  insertThreadMessage,
  markThreadRead,
  countUnreadForUser,
  type MessageThreadRow,
  type ThreadMessageRow,
} from '../../db/index.js';
import { scanThreadMessage, userRoom } from '../../services/messageSafety.service.js';
import { createLogger } from '../../utils/logger.js';

const log = createLogger('messagingPublic');

const MAX_BODY_LENGTH = 4000;

/** Participant view of a message: scan verdict as a boolean, no scores. */
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

/** Participant view of a thread: no org/sandbox internals. */
function participantThreadView(t: MessageThreadRow & { counterpart_username?: string | null; unread_count?: number; last_message_preview?: string | null }) {
  return {
    thread_id: t.thread_id,
    clinician_id: t.clinician_id,
    clinician_role: t.clinician_role,
    status: t.status,
    frozen_reason: t.frozen_reason,
    created_at: t.created_at,
    last_message_at: t.last_message_at,
    ...(t.counterpart_username !== undefined ? { counterpart_username: t.counterpart_username } : {}),
    ...(t.unread_count !== undefined ? { unread_count: t.unread_count } : {}),
    ...(t.last_message_preview !== undefined ? { last_message_preview: t.last_message_preview } : {}),
  };
}

export default function publicMessagingRoutes(): Router {
  const router = Router();

  // GET /api/messaging/threads - the caller's threads + total unread badge count
  router.get('/api/messaging/threads', requireAuth, async (req, res) => {
    try {
      const userId = req.session.userId!;
      const [threads, unreadTotal] = await Promise.all([
        listThreadsForClient(userId),
        countUnreadForUser(userId),
      ]);
      res.json({ threads: threads.map(participantThreadView), unread_total: unreadTotal });
    } catch (err) {
      log.error({ err }, 'Failed to list participant threads');
      res.status(500).json({ error: 'Failed to load messages' });
    }
  });

  // GET /api/messaging/threads/:threadId/messages - a thread's messages
  // (oldest first; ?before=<messageId>&limit=<n> keyset pagination)
  router.get(
    '/api/messaging/threads/:threadId/messages',
    requireAuth,
    requireThreadParticipant(),
    async (req, res) => {
      try {
        const thread = res.locals.thread as MessageThreadRow;
        const before = Number(req.query.before);
        const limit = Number(req.query.limit);
        const messages = await listThreadMessages(thread.thread_id, {
          beforeMessageId: Number.isInteger(before) ? before : null,
          limit: Number.isInteger(limit) && limit > 0 && limit <= 200 ? limit : 50,
        });
        res.json({
          thread: participantThreadView(thread),
          messages: messages.map(participantMessageView),
        });
      } catch (err) {
        log.error({ err }, 'Failed to list thread messages');
        res.status(500).json({ error: 'Failed to load messages' });
      }
    }
  );

  // POST /api/messaging/threads/:threadId/messages - send (active threads only;
  // frozen -> 409 thread_frozen from the gate). Fires the safety scan
  // fire-and-forget: delivery never waits on (or breaks from) the scanner.
  router.post(
    '/api/messaging/threads/:threadId/messages',
    requireAuth,
    messagingRateLimit,
    requireThreadParticipant({ requireActive: true }),
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
        const message = await insertThreadMessage({
          threadId: thread.thread_id,
          senderId: req.session.userId!,
          senderRole: 'participant',
          body,
          scanStatus: 'pending',
        });

        void scanThreadMessage(message, thread);

        if (global.io) {
          global.io.to(userRoom(thread.clinician_id)).emit('messaging:new-message', {
            threadId: thread.thread_id,
            message: participantMessageView(message),
          });
        }

        res.status(201).json({ message: participantMessageView(message) });
      } catch (err) {
        log.error({ err }, 'Failed to send message');
        res.status(500).json({ error: 'Failed to send message' });
      }
    }
  );

  // POST /api/messaging/threads/:threadId/read - advance the read pointer
  router.post(
    '/api/messaging/threads/:threadId/read',
    requireAuth,
    requireThreadParticipant(),
    async (req, res) => {
      const lastReadMessageId = Number(req.body?.last_read_message_id);
      if (!Number.isInteger(lastReadMessageId) || lastReadMessageId < 0) {
        return res.status(400).json({ error: 'Invalid last_read_message_id' });
      }
      try {
        const thread = res.locals.thread as MessageThreadRow;
        await markThreadRead(thread.thread_id, req.session.userId!, lastReadMessageId);
        if (global.io) {
          global.io.to(userRoom(thread.clinician_id)).emit('messaging:read', {
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

  return router;
}
