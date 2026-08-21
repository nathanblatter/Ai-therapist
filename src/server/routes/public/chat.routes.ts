// Chat-only therapy endpoints (no auth required; anonymous users keyed by
// session id). Used when voice is disabled — routes to the GPT chat-completions
// flow instead of the Realtime API. Conversation state lives in
// services/chatTherapy.service.ts; persistence/redaction go through the db
// layer and the redaction queue.
import { Router } from 'express';
import {
  createSession,
  insertMessagesBatch,
  updateSessionStatus,
  getActiveSessionForUser,
  getSessionAccessInfo,
  isDemoAccountSession,
  getRecentSessionMessages,
  getUserPreferredLanguage,
  setUserPreferredLanguage,
  recordConsent,
} from '../../db/index.js';
import { checkSessionLimits, getSystemPrompt, getSystemConfig } from '../../utils/sessionHelpers.js';
import { sanitizeCheckin, buildCheckinBlock, buildMemoryBlock } from '../../utils/promptContext.js';
import { generateSessionNameAsync } from '../../services/sessionName.service.js';
import { canAccessSession, recordSessionOwnership } from '../../utils/sessionOwnership.js';
import { requireConsent } from '../../middleware/consent.js';
import { broadcastAdminEvent, broadcastAdminEventForSession } from '../../utils/adminBroadcast.js';

export default function chatRoutes(): Router {
  const router = Router();

  // POST /api/chat/start - start a chat-only therapy session. Blocked until
  // the participant has accepted the current consent screen.
  router.post('/api/chat/start', requireConsent, async (req, res) => {
    const userId: number | string = req.session?.userId ?? req.sessionID;
    const numericUserId: number | null = typeof userId === 'number' ? userId : null;

    try {
      // Enforce session limits (mirrors the /token endpoint).
      const userRole = req.session?.userRole || 'participant';
      const limitCheck = await checkSessionLimits(userId, userRole);
      if (!limitCheck.allowed) {
        return res.status(429).json({
          error: 'Session limit exceeded',
          reason: limitCheck.reason,
          minutes_remaining: limitCheck.reason === 'cooldown' ? limitCheck.minutes_remaining : undefined,
        });
      }

      // One active session per user at a time.
      const existingSession = await getActiveSessionForUser(userId);
      if (existingSession) {
        return res.status(200).json({
          message: 'Active session already exists',
          sessionId: existingSession.session_id,
          alreadyActive: true,
        });
      }

      // Language: request body wins, else the user's saved preference, else 'en'.
      let userLanguage = req.body?.language;
      if (!userLanguage && req.session?.userId) {
        userLanguage = (await getUserPreferredLanguage(userId)) || 'en';
      } else {
        userLanguage = userLanguage || 'en';
      }

      // Persist the language for next time (fire-and-forget).
      if (req.session?.userId) {
        setUserPreferredLanguage(userId, userLanguage).catch(err =>
          console.error('[ChatStart] Failed to save user language preference:', err));
      }

      const sessionId = `chat_${Date.now()}_${Math.random().toString(36).substring(7)}`;
      recordSessionOwnership(req, sessionId);

      // Base prompt + returning-participant memory (opt-in) + today's check-in.
      const checkin = sanitizeCheckin(req.body?.checkin);
      const memoryBlock = await buildMemoryBlock(numericUserId);
      const systemPrompt =
        (await getSystemPrompt(userLanguage, 'chat')) + memoryBlock + buildCheckinBlock(checkin);

      const { initializeChatSession } = await import('../../services/chatTherapy.service.js');
      initializeChatSession(sessionId, systemPrompt);

      const username = req.session?.username || null;
      const { isNonStudyUser } = await import('../../utils/harness.js');
      await createSession({
        sessionId,
        userId: numericUserId,
        sessionName: null, // generated from the conversation when the session ends
        status: 'active',
        sessionType: 'chat',
        // Demo viewers AND the eval-harness participant: non-study data,
        // excluded from every real analytics/export surface.
        isDemo: isNonStudyUser(userRole, username),
      });

      if (checkin) {
        const { setSessionCheckin } = await import('../../db/index.js');
        setSessionCheckin(sessionId, checkin).catch(err =>
          console.error('[ChatStart] Failed to store check-in:', err));
      }

      // Durable per-session consent record, linked to the consent this
      // browser session already accepted (requireConsent guarantees it's
      // present and current by this point).
      getSystemConfig()
        .then(cfg => recordConsent({
          sessionId,
          userId: numericUserId,
          consentVersion: req.session!.consentVersion!,
          recordingEnabled: (cfg.features?.session_recording_enabled as boolean | undefined) ?? false,
        }))
        .catch(err => console.error('[Consent] Failed to record per-session consent:', err));

      void broadcastAdminEvent(global.io, 'session:started', {
        sessionId,
        userId,
        username,
        sessionType: 'chat',
        startedAt: new Date(),
      }, numericUserId);

      console.log(`Chat-only session started: ${sessionId.substring(0, 12)}... for user ${userId}`);

      res.json({ success: true, sessionId, sessionType: 'chat', message: 'Chat therapy session started' });
    } catch (error: unknown) {
      console.error('Failed to start chat session:', error);
      res.status(500).json({
        error: 'Failed to start chat session',
        details: error instanceof Error ? error.message : String(error),
      });
    }
  });

  // POST /api/chat/message - send a message and get the AI response
  router.post('/api/chat/message', async (req, res) => {
    const { sessionId, message } = req.body;

    if (!sessionId || !message) {
      return res.status(400).json({ error: 'sessionId and message are required' });
    }

    try {
      const session = await getSessionAccessInfo(sessionId);
      if (!session) {
        return res.status(404).json({ error: 'Session not found' });
      }
      if (session.status !== 'active') {
        return res.status(400).json({ error: 'Session is not active' });
      }
      if (session.session_type !== 'chat') {
        return res.status(400).json({ error: 'Session is not a chat-only session' });
      }

      // Ownership check (cookie ownedSessions for anonymous users, user_id
      // for logged-in ones — the old `user_id !== req.sessionID` comparison
      // could never match for anonymous sessions).
      if (!canAccessSession(req, session, sessionId)) {
        return res.status(403).json({ error: 'Unauthorized: You do not own this session' });
      }

      // Persist the USER turn FIRST so crisis/eligibility detection has a real
      // message_id and a model failure no longer loses the participant's words
      // (they used to be inserted only after a successful model call).
      const [userMsg] = await insertMessagesBatch([
        { session_id: sessionId, role: 'user', message_type: 'text', content: message, content_redacted: null },
      ]);

      // Minor / age-eligibility gate (ai-therapist-106). Runs BEFORE the crisis
      // screen and the model call: on a first-person age-disclosure pattern hit
      // (non-demo), confirm with gpt-4o-mini and, if confirmed, return a
      // server-authored goodbye and end the session — the model is never called
      // on a confirmed turn, so the copy can't be paraphrased away. Fail-open:
      // any confirmation error degrades to normal handling.
      const { detectMinorDisclosurePatterns } = await import('../../services/minorSafeguard.service.js');
      if (detectMinorDisclosurePatterns(message).matched && !(await isDemoAccountSession(sessionId))) {
        try {
          const { confirmMinorDisclosure, handleConfirmedMinor, MINOR_ELIGIBILITY_MESSAGE } =
            await import('../../services/minorSafeguard.service.js');
          const history = await getRecentSessionMessages(sessionId, 10);
          const verdict = await confirmMinorDisclosure(message, history, sessionId);
          if (verdict.isMinor && verdict.confidence !== 'low') {
            await insertMessagesBatch([
              { session_id: sessionId, role: 'assistant', message_type: 'text', content: MINOR_ELIGIBILITY_MESSAGE, content_redacted: null },
            ]);
            await handleConfirmedMinor({ sessionId, messageId: userMsg.message_id, channel: 'chat', statedAge: verdict.statedAge });
            global.io.to(`session:${sessionId}`).emit('message:new', { sessionId, role: 'user', message, timestamp: new Date() });
            global.io.to(`session:${sessionId}`).emit('message:new', { sessionId, role: 'assistant', message: MINOR_ELIGIBILITY_MESSAGE, timestamp: new Date() });
            return res.json({ success: true, response: MINOR_ELIGIBILITY_MESSAGE, sessionId, sessionEnded: true, reason: 'eligibility' });
          }
          if (verdict.isMinor && verdict.confidence === 'low' && global.io) {
            // False-positive escape valve: flag for a human look, don't auto-end.
            void broadcastAdminEventForSession(global.io, 'session:eligibility-review', {
              sessionId, statedAge: verdict.statedAge, reasoning: verdict.reasoning, channel: 'chat', at: new Date(),
            }, sessionId);
          }
        } catch (err) {
          console.error('[MinorSafeguard] confirm failed (fail-open):', err);
        }
      }

      const { detectCrisisKeywords } = await import('../../services/crisisDetection.service.js');
      const { runCrisisPipeline } = await import('../../services/crisisPipeline.service.js');
      const { sendMessage, injectGuidance } = await import('../../services/chatTherapy.service.js');

      // Crisis screen: run the cheap sync keyword screen pre-model. Only
      // keyword-hit turns pay for an inline LLM assessment — which buys
      // SAME-TURN steering. Clean turns defer everything (incl. the 8-turn LLM
      // sweep) to post-response, exactly like /logs/batch, so the happy path
      // adds no LLM call before the reply.
      let steering: string | null = null;
      try {
        if (detectCrisisKeywords(message).keywordScore > 0) {
          const risk = await runCrisisPipeline(
            { sessionId, messageId: userMsg.message_id, content: message },
            'chat',
          );
          steering = risk.steeringGuidance;
        } else {
          // Clean turn: run the pipeline after the response ships (covers the
          // periodic sweep); any steering lands on the NEXT turn.
          res.on('finish', () => void runCrisisPipeline(
            { sessionId, messageId: userMsg.message_id, content: message },
            'chat',
          )
            .then(r => { if (r.steeringGuidance) injectGuidance(sessionId, r.steeringGuidance); })
            .catch(err => console.error('[ChatCrisis] deferred pipeline failed:', err)));
        }
      } catch (err) {
        // A crisis-pipeline error must degrade to "reply without steering",
        // never a 500. analyzeMessageRisk already zeros on internal error.
        console.error('[ChatCrisis] inline pipeline failed (fail-open, no steering):', err);
      }

      // Model call, with steering injected BEFORE the turn when present.
      if (steering) injectGuidance(sessionId, steering);
      const { text: aiResponse, toolEvents } = await sendMessage(sessionId, message);

      // Persist the assistant turn; content_redacted is filled in once per
      // session at session end (see sessionRedaction.service), not per message.
      await insertMessagesBatch([
        { session_id: sessionId, role: 'assistant', message_type: 'text', content: aiResponse, content_redacted: null },
      ]);

      // Live-monitoring events.
      global.io.to(`session:${sessionId}`).emit('message:new', { sessionId, role: 'user', message, timestamp: new Date() });
      global.io.to(`session:${sessionId}`).emit('message:new', { sessionId, role: 'assistant', message: aiResponse, timestamp: new Date() });

      console.log(`[ChatTherapy] Message exchanged for session ${sessionId.substring(0, 12)}...`);

      // toolEvents: overlay tools the model invoked this turn (resource card,
      // safety plan, thought record, ...). The chat client dispatches these
      // through the same fns map the realtime data channel drives, so tool
      // overlays render identically in both modes (ai-therapist-118).
      res.json({ success: true, response: aiResponse, toolEvents, sessionId });
    } catch (error: unknown) {
      console.error('Failed to process chat message:', error);
      res.status(500).json({
        error: 'Failed to process message',
        details: error instanceof Error ? error.message : String(error),
      });
    }
  });

  // POST /api/chat/end - end a chat therapy session
  router.post('/api/chat/end', async (req, res) => {
    const { sessionId } = req.body;

    if (!sessionId) {
      return res.status(400).json({ error: 'sessionId is required' });
    }

    try {
      const session = await getSessionAccessInfo(sessionId);
      if (!session) {
        return res.status(404).json({ error: 'Session not found' });
      }

      // Ownership check.
      if (!canAccessSession(req, session, sessionId)) {
        return res.status(403).json({ error: 'Unauthorized: You do not own this session' });
      }

      // Idempotent end.
      if (session.status === 'ended') {
        console.log(`Chat session ${sessionId} already ended, returning existing data (idempotent)`);
        return res.status(200).json({ ...session, alreadyEnded: true, message: 'Session was already ended' });
      }

      const { endChatSession } = await import('../../services/chatTherapy.service.js');
      endChatSession(sessionId);

      // Drop the per-session steering cooldown entry (mirrors the opportunistic
      // in-memory cleanup on the realtime side).
      const { clearSteeringState } = await import('../../services/crisisIntervention.service.js');
      clearSteeringState(sessionId);

      const updatedSession = await updateSessionStatus(sessionId, 'ended', 'user');

      // Redact the whole session in one batched job (fire-and-forget), THEN
      // auto-name from the redacted transcript — naming must run after redaction
      // populates content_redacted, or it names a blank transcript (wave1 bug 1).
      import('../../services/sessionRedaction.service.js')
        .then(m => m.redactSession(sessionId))
        .then(() => generateSessionNameAsync(sessionId))
        .catch(e => console.error('[Redaction] session redaction/naming failed:', e));

      // Memory summary + draft SOAP note (fire-and-forget).
      import('../../services/sessionInsights.service.js')
        .then(m => m.generateSessionInsightsAsync(sessionId))
        .catch(e => console.error('[Insights] generation failed:', e));

      void broadcastAdminEventForSession(global.io, 'session:ended', { sessionId, endedBy: 'user', endedAt: new Date() }, sessionId);
      global.io.to(`session:${sessionId}`).emit('session:ended', { sessionId, endedAt: new Date() });

      console.log(`Chat session ${sessionId.substring(0, 12)}... ended by user`);

      res.json({ success: true, message: 'Chat session ended', session: updatedSession });
    } catch (error: unknown) {
      console.error('Failed to end chat session:', error);
      res.status(500).json({
        error: 'Failed to end session',
        details: error instanceof Error ? error.message : String(error),
      });
    }
  });

  return router;
}
