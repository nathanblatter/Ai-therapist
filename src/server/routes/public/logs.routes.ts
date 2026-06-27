// Batch message-logging endpoint. Persists realtime conversation records,
// lazily creating their backing session (+ default config), queues async
// PHI/PII redaction, runs multi-layered crisis detection per message, and emits
// Socket.io activity to admins. The heavy lifting lives in the crisis-detection
// and redaction-queue services; this route orchestrates them.
import { Router } from 'express';
import {
  getSession,
  insertMessagesBatch,
  upsertSessionConfig,
  createActiveRealtimeSession,
  getRecentSessionMessages,
  getSessionCrisisState,
  type InsertMessageInput,
} from '../../db/index.js';
import { getSystemPrompt } from '../../utils/sessionHelpers.js';

export default function logsRoutes(): Router {
  const router = Router();

  // POST /logs/batch - persist a batch of conversation records
  router.post('/logs/batch', async (req, res) => {
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

      // Ensure every referenced session exists, with a default configuration.
      for (const sessionId of sessionIds) {
        const existingSession = await getSession(sessionId);
        if (!existingSession) {
          await createActiveRealtimeSession(sessionId, userId);
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

      // ========== QUEUE ASYNC REDACTION ==========
      const { queueRedactionBatch } = await import('../../services/redactionQueue.service.js');
      const redactionJobs = insertedMessages.map(msg => ({
        messageId: msg.message_id,
        content: msg.content,
        sessionId: msg.session_id,
      }));
      queueRedactionBatch(redactionJobs);
      console.log(`📋 Queued ${redactionJobs.length} messages for async redaction`);

      // ========== MULTI-LAYERED CRISIS DETECTION ==========
      const { analyzeMessageRisk, flagSessionCrisis, logInterventionAction } = await import('../../services/crisisDetection.service.js');
      const { executeGraduatedResponse } = await import('../../services/crisisIntervention.service.js');

      for (const msg of insertedMessages) {
        if (msg.role === 'user' || msg.role === 'assistant') {
          const conversationHistory = await getRecentSessionMessages(msg.session_id, 10);

          const riskAnalysis = await analyzeMessageRisk(
            { content: msg.content ?? '', session_id: msg.session_id, message_id: msg.message_id },
            conversationHistory
          );

          if (riskAnalysis.riskScore > 0) {
            console.log(` Risk detected in session ${msg.session_id}:
            Score=${riskAnalysis.riskScore},
            Severity=${riskAnalysis.severity},
            Factors=${JSON.stringify(riskAnalysis.factors)}`);

            const state = await getSessionCrisisState(msg.session_id);
            const currentScore = state?.crisis_risk_score || 0;

            // Flag only on imminent/explicit crisis keywords (severity === 'high').
            const shouldFlag = riskAnalysis.severity === 'high' &&
              (!state?.crisis_flagged || riskAnalysis.riskScore > currentScore + 10);

            if (shouldFlag) {
              await flagSessionCrisis(
                msg.session_id,
                riskAnalysis.severity,
                riskAnalysis.riskScore,
                'system',
                'auto',
                msg.message_id,
                riskAnalysis.factors,
                `Risk score: ${riskAnalysis.riskScore} - Factors: ${riskAnalysis.factors.join(', ')}`
              );

              await logInterventionAction(msg.session_id, 'auto_flag', {
                riskScore: riskAnalysis.riskScore,
                severity: riskAnalysis.severity,
                messageId: msg.message_id,
                factors: riskAnalysis.factors,
              });

              global.io.to('admin-broadcast').emit('session:crisis-detected', {
                sessionId: msg.session_id,
                severity: riskAnalysis.severity,
                riskScore: riskAnalysis.riskScore,
                factors: riskAnalysis.factors,
                messageId: msg.message_id,
                detectedAt: new Date(),
                message: `${riskAnalysis.severity.toUpperCase()} risk detected (score: ${riskAnalysis.riskScore})`,
              });

              await executeGraduatedResponse(msg.session_id, riskAnalysis.severity, riskAnalysis.riskScore);

              console.log(`Session ${msg.session_id} flagged as ${riskAnalysis.severity} risk (score: ${riskAnalysis.riskScore})`);
            }
          }
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

      Object.entries(sessionGroups).forEach(([sessionId, msgs]) => {
        global.io.to(`session:${sessionId}`).emit('messages:new', { sessionId, messages: msgs });
        global.io.to('admin-broadcast').emit('session:activity', {
          sessionId,
          messageCount: msgs.length,
          lastActivity: new Date(),
        });
      });
      // ========== END SOCKET.IO EVENT EMISSION ==========

      res.sendStatus(200);
    } catch (err) {
      console.error('Failed to insert batch logs into DB:', err);
      res.sendStatus(500);
    }
  });

  return router;
}
