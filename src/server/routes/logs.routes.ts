import { Router } from 'express';
import { pool } from '../config/db.js';
import { getSession, insertMessagesBatch, upsertSessionConfig } from '../models/dbQueries.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { sessionConfigDefault } from '../utils/sessionHelpers.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('logs');

export default function logsRoutes() {
  const router = Router();

  // POST /logs/batch
  router.post("/logs/batch", asyncHandler(async (req, res) => {
    const { records } = req.body;
    const io = req.app.locals.io;

    if (!Array.isArray(records) || records.length === 0) {
      return res.status(400).send("No records provided");
    }

    const messages = [];
    const sessionIds = new Set();

    for (const record of records) {
      const { timestamp, sessionId, role, type, message, extras } = record;
      if (!timestamp || !sessionId || !role || !type) continue;

      sessionIds.add(sessionId);

      messages.push({
        session_id: sessionId,
        role,
        message_type: type,
        content: message,
        content_redacted: null,
        metadata: extras || null,
        created_at: new Date(timestamp)
      });
    }

    if (messages.length === 0) {
      return res.status(400).send("No valid records to insert");
    }

    const userId = req.session?.userId || null;

    if (sessionIds.size > 0) {
      log.debug({ userId, username: req.session?.username, sessionCount: sessionIds.size }, 'Processing batch logs');
    }

    for (const sessionId of sessionIds) {
      const existingSession = await getSession(sessionId);
      if (!existingSession) {
        await pool.query(
          `INSERT INTO therapy_sessions (session_id, user_id, status, created_at, updated_at)
           VALUES ($1, $2, 'active', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
           ON CONFLICT (session_id) DO NOTHING`,
          [sessionId, userId]
        );
        log.info({ sessionId: sessionId.substring(0, 12) + '...', userId }, 'Created session');

        try {
          const sessionConfigObj = sessionConfigDefault;
          await upsertSessionConfig(sessionId, {
            voice: sessionConfigObj.session?.audio?.output?.voice || 'cedar',
            modalities: ['text', 'audio'],
            instructions: sessionConfigObj.session?.instructions || null,
            turn_detection: sessionConfigObj.session?.turn_detection || null,
            tools: sessionConfigObj.session?.tools || null,
            temperature: sessionConfigObj.session?.temperature || 0.8,
            max_response_output_tokens: sessionConfigObj.session?.max_response_output_tokens || 4096
          });
          log.info({ sessionId: sessionId.substring(0, 12) + '...' }, 'Session configuration created');
        } catch (configError) {
          log.error({ err: configError, sessionId }, 'Failed to create session configuration');
        }
      }
    }

    const insertedMessages = await insertMessagesBatch(messages);

    // Queue async redaction
    const { queueRedactionBatch } = await import('../services/redactionQueue.service.js');
    const redactionJobs = insertedMessages.map(msg => ({
      messageId: msg.message_id, content: msg.content, sessionId: msg.session_id
    }));
    queueRedactionBatch(redactionJobs);
    log.info({ count: redactionJobs.length }, 'Queued messages for async redaction');

    // Multi-layered crisis detection
    const { analyzeMessageRisk, flagSessionCrisis, logInterventionAction } = await import('../services/crisisDetection.service.js');
    const { executeGraduatedResponse } = await import('../services/crisisIntervention.service.js');

    for (const msg of insertedMessages) {
      if (msg.role === 'user' || msg.role === 'assistant') {
        const historyResult = await pool.query(
          `SELECT role, content, created_at FROM messages
           WHERE session_id = $1
           ORDER BY created_at DESC
           LIMIT 10`,
          [msg.session_id]
        );

        const conversationHistory = historyResult.rows.reverse();
        const riskAnalysis = await analyzeMessageRisk(msg, conversationHistory);

        if (riskAnalysis.riskScore > 0) {
          log.info({
            sessionId: msg.session_id,
            score: riskAnalysis.riskScore,
            severity: riskAnalysis.severity,
            factors: riskAnalysis.factors
          }, 'Risk detected');

          const sessionCheck = await pool.query(
            `SELECT crisis_flagged, crisis_severity, crisis_risk_score
             FROM therapy_sessions
             WHERE session_id = $1`,
            [msg.session_id]
          );

          const session = sessionCheck.rows[0];
          const currentScore = session?.crisis_risk_score || 0;

          const shouldFlag = riskAnalysis.riskScore > 30 &&
            (!session.crisis_flagged || riskAnalysis.riskScore > currentScore + 10);

          if (shouldFlag) {
            await flagSessionCrisis(
              msg.session_id, riskAnalysis.severity, riskAnalysis.riskScore,
              'system', 'auto', msg.message_id, riskAnalysis.factors,
              `Risk score: ${riskAnalysis.riskScore} - Factors: ${riskAnalysis.factors.join(', ')}`
            );

            await logInterventionAction(msg.session_id, 'auto_flag', {
              riskScore: riskAnalysis.riskScore,
              severity: riskAnalysis.severity,
              messageId: msg.message_id,
              factors: riskAnalysis.factors
            });

            io.to('admin-broadcast').emit('session:crisis-detected', {
              sessionId: msg.session_id,
              severity: riskAnalysis.severity,
              riskScore: riskAnalysis.riskScore,
              factors: riskAnalysis.factors,
              messageId: msg.message_id,
              detectedAt: new Date(),
              message: `${riskAnalysis.severity.toUpperCase()} risk detected (score: ${riskAnalysis.riskScore})`
            });

            await executeGraduatedResponse(msg.session_id, riskAnalysis.severity, riskAnalysis.riskScore);

            log.info({ sessionId: msg.session_id, severity: riskAnalysis.severity, score: riskAnalysis.riskScore }, 'Session flagged');
          }
        }
      }
    }

    // Socket.io event emission
    const sessionGroups = {};
    insertedMessages.forEach(msg => {
      if (!sessionGroups[msg.session_id]) sessionGroups[msg.session_id] = [];
      sessionGroups[msg.session_id].push({
        message_id: msg.message_id,
        role: msg.role,
        message_type: msg.message_type,
        content: msg.content,
        content_redacted: msg.content_redacted,
        created_at: msg.created_at
      });
    });

    Object.entries(sessionGroups).forEach(([sessionId, msgs]) => {
      io.to(`session:${sessionId}`).emit('messages:new', { sessionId, messages: msgs });
      io.to('admin-broadcast').emit('session:activity', {
        sessionId, messageCount: msgs.length, lastActivity: new Date()
      });
    });

    res.sendStatus(200);
  }));

  return router;
}
