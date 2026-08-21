// Batch message-logging endpoint. Persists realtime conversation records,
// lazily creating their backing session (+ default config), queues async
// PHI/PII redaction, runs multi-layered crisis detection per message, and emits
// Socket.io activity to admins. The heavy lifting lives in the crisis-detection
// and redaction-queue services; this route orchestrates them.
import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import {
  getSession,
  insertMessagesBatch,
  upsertSessionConfig,
  createActiveRealtimeSession,
  getSessionMessageCount,
  type InsertMessageInput,
} from '../../db/index.js';
import { getSystemPrompt } from '../../utils/sessionHelpers.js';
import { canAccessSession, recordSessionOwnership } from '../../utils/sessionOwnership.js';
import { broadcastAdminEventForSession } from '../../utils/adminBroadcast.js';

export default function logsRoutes(): Router {
  const router = Router();

  // Generous per-IP throttle: the client flushes every ~15s, so a real
  // participant stays far below this even with the unload beacon.
  const logsLimiter = rateLimit({ windowMs: 60_000, limit: 120, standardHeaders: true, legacyHeaders: false });

  // POST /logs/batch - persist a batch of conversation records
  router.post('/logs/batch', logsLimiter, async (req, res) => {
    const { records } = req.body;
    if (!Array.isArray(records) || records.length === 0) {
      return res.status(400).send('No records provided');
    }

    try {
      const messages: InsertMessageInput[] = [];
      const sessionIds = new Set<string>();

      for (const record of records) {
        const { timestamp, sessionId, role, type, message, extras } = record;
        if (!timestamp || !sessionId || !role || !type) continue;

        sessionIds.add(sessionId);

        // Saved immediately; content_redacted is filled in by the async queue.
        messages.push({
          session_id: sessionId as string,
          role: role as string,
          message_type: type as string,
          content: (message as string | null) ?? null,
          content_redacted: null,
          metadata: (extras as Record<string, unknown> | null) || null,
          created_at: new Date(timestamp as string | number),
        });
      }

      if (messages.length === 0) {
        return res.status(400).send('No valid records to insert');
      }

      const userId = req.session?.userId || null;
      if (sessionIds.size > 0) {
        console.log('Processing batch logs with user context:', {
          userId,
          username: req.session?.username,
          sessionCount: sessionIds.size,
        });
      }

      // Ensure every referenced session exists (with a default configuration)
      // and that the requester is allowed to write to it: its owner (by cookie
      // or user_id) or an admin. Reject the whole batch on any foreign session
      // so unauthenticated callers can't inject messages into other people's
      // transcripts or spam crisis detection.
      for (const sessionId of sessionIds) {
        const existingSession = await getSession(sessionId);
        if (existingSession) {
          if (!canAccessSession(req, existingSession, sessionId)) {
            console.warn(`[Logs] Rejected batch write to session ${sessionId.substring(0, 12)}... (not owner)`);
            return res.status(403).json({ error: 'Access denied' });
          }
        } else {
          const { isNonStudyUser } = await import('../../utils/harness.js');
          await createActiveRealtimeSession(
            sessionId, userId,
            isNonStudyUser(req.session?.userRole, req.session?.username),
          );
          recordSessionOwnership(req, sessionId);
          console.log(`Created session ${sessionId.substring(0, 12)}... with user_id: ${userId}`);

          try {
            await upsertSessionConfig(sessionId, {
              voice: 'cedar',
              modalities: ['text', 'audio'],
              instructions: await getSystemPrompt('en', 'realtime'),
              turn_detection: null,
              tools: null,
              temperature: 0.8,
              max_response_output_tokens: 4096,
            });
            console.log(`Session configuration created for session: ${sessionId.substring(0, 12)}...`);
          } catch (configError) {
            console.error(`Failed to create session configuration for ${sessionId}:`, configError);
            // Configuration is not critical for message logging — continue.
          }
        }
      }

      const insertedMessages = await insertMessagesBatch(messages);

      // Redaction is no longer per-message — it runs once per session at session
      // end (see sessionRedaction.service). Messages persist with
      // content_redacted = NULL until then; live monitoring reads the unredacted
      // sideband transcript stream instead.

      // Ack now — the crisis analysis below makes an LLM call per message and
      // used to hold the participant's logging loop (and the unload beacon)
      // hostage. It runs after the response, like redaction does.
      res.sendStatus(200);

      setImmediate(() => {
        void processInsertedMessages(insertedMessages).catch(err =>
          console.error('[Logs] post-persist crisis/emission processing failed:', err));
      });
    } catch (err) {
      console.error('Failed to insert batch logs into DB:', err);
      res.sendStatus(500);
    }
  });

  // Crisis detection + admin socket fan-out for freshly persisted messages.
  // Runs off the request path (fire-and-forget).
  async function processInsertedMessages(
    insertedMessages: Awaited<ReturnType<typeof insertMessagesBatch>>
  ): Promise<void> {
    {
      // ========== MULTI-LAYERED CRISIS DETECTION ==========
      // The full per-turn pipeline (demo skip, risk scoring, steering, flagging,
      // paging, AE auto-draft) lives in crisisPipeline.service so /logs/batch
      // and /api/chat/message run identical logic. This route only fans out the
      // socket activity events below.
      const { runCrisisPipeline } = await import('../../services/crisisPipeline.service.js');

      for (const msg of insertedMessages) {
        // Only participant messages are scored: the assistant reciting crisis
        // resources ("988 Suicide & Crisis Lifeline") used to flag its own
        // session as a high-severity crisis. Assistant turns still reach the
        // stage-2 LLM as conversation context.
        if (msg.role === 'user') {
          await runCrisisPipeline(
            { sessionId: msg.session_id, messageId: msg.message_id, content: msg.content ?? '' },
            'realtime',
          );
        }
      }
      // ========== END CRISIS DETECTION ==========

      // ========== SOCKET.IO EVENT EMISSION ==========
      type MsgSummary = { message_id: number; role: string; message_type: string; content: string | null; content_redacted: string | null; created_at: Date };
      const sessionGroups: Record<string, MsgSummary[]> = {};
      insertedMessages.forEach(msg => {
        if (!sessionGroups[msg.session_id]) sessionGroups[msg.session_id] = [];
        sessionGroups[msg.session_id].push({
          message_id: msg.message_id,
          role: msg.role,
          message_type: msg.message_type,
          content: msg.content,                   // Original for therapists
          content_redacted: msg.content_redacted, // Redacted for researchers (may be null initially)
          created_at: msg.created_at,
        });
      });

      await Promise.all(Object.entries(sessionGroups).map(async ([sessionId, msgs]) => {
        global.io.to(`session:${sessionId}`).emit('messages:new', { sessionId, messages: msgs });
        // Emit the ABSOLUTE count (not a delta) so it reconciles the live count
        // the sideband has been incrementing between flushes — no double-counting.
        const totalMessages = await getSessionMessageCount(sessionId);
        void broadcastAdminEventForSession(global.io, 'session:activity', {
          sessionId,
          totalMessages,
          lastActivity: new Date(),
        }, sessionId);
      }));
      // ========== END SOCKET.IO EVENT EMISSION ==========
    }
  }

  return router;
}
