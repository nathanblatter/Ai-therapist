// Chat-only therapy endpoints (no auth required; anonymous users keyed by
// session id). Used when voice is disabled — routes to the GPT chat-completions
// flow instead of the Realtime API. Conversation state lives in
// services/chatTherapy.service.ts; persistence/redaction go through the db
// layer and the redaction queue.
import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import {
  createSession,
  insertMessagesBatch,
  updateSessionStatus,
  getActiveSessionForUser,
  getSessionAccessInfo,
  isDemoAccountSession,
  isSandboxAccountSession,
  getRecentSessionMessages,
  getUserPreferredLanguage,
  setUserPreferredLanguage,
  recordConsent,
  upsertSessionConfig,
} from '../../db/index.js';
import {
  checkSessionLimits,
  getSystemPrompt,
  getSystemConfig,
  resolveProactiveOffering,
  resolvePsychoeducationCue,
  resolveLeadConversation,
} from '../../utils/sessionHelpers.js';
import {
  buildChatOpeningLine,
  CHAT_OPENING_FRAMING_GUIDANCE,
  OPENING_LINE_MESSAGE_TYPE,
  OPENING_LINE_METADATA,
} from '../../utils/openingLine.js';
import {
  sanitizeCheckin,
  buildCheckinBlock,
  buildMemoryBlock,
  buildToolGuidanceBlock,
  buildLeadConversationBlock,
} from '../../utils/promptContext.js';
import { generateSessionNameAsync } from '../../services/sessionName.service.js';
import { canAccessSession, recordSessionOwnership } from '../../utils/sessionOwnership.js';
import { requireConsent } from '../../middleware/consent.js';
import { requireOutsideQuietHours } from '../../middleware/quietHours.js';
import { requireActiveStudyStatus } from '../../middleware/studyStatus.js';
import { broadcastAdminEvent, broadcastAdminEventForSession } from '../../utils/adminBroadcast.js';
import type { HandoffStartPayload } from '../../../shared/textHandoff.js';
import type { RecoveryCrisisContact } from '../../../shared/recoveryPrompt.js';

import { createLogger } from '../../utils/logger.js';

const log = createLogger('chatRoutes');

/** Longest a chat reply waits for a context assessment of a keyword-free turn
 *  (ai-therapist-299). Measured live on 2026-11-18 the moderation screen plus
 *  the assessor took 2 to 3.5 seconds, with an occasional call over 5; this
 *  leaves room for those without ever tying the participant's reply to an
 *  assessor that is timing out (10s per attempt) or being retried. */
const CHAT_CONTEXT_ASSESS_DEADLINE_MS = 6000;

/** On the first turn after a crisis text hand-off the reply is not held for
 *  the risk assessor (it runs alongside the model call). Once the reply is
 *  ready, this is how long the response waits for a score that is still
 *  outstanding before answering "voice return: not yet". The reply is usually
 *  the slower of the two, so this rarely adds anything. */
const HANDOFF_FIRST_TURN_SCORE_WAIT_MS = 400;

/**
 * Synthetic-account gate (caseworker portal, spec section 7 item 6): demo-role
 * magic-link accounts AND sandbox-org accounts both get behavioral safety
 * skips (no minor-gate LLM confirm / auto-end for invented dialogue). Keyed on
 * account identity, not the session's is_demo analytics flag — eval-harness
 * sessions are is_demo but must exercise the REAL pipelines.
 */
async function isSyntheticAccountSession(sessionId: string): Promise<boolean> {
  return (await isDemoAccountSession(sessionId)) || (await isSandboxAccountSession(sessionId));
}

export default function chatRoutes(): Router {
  const router = Router();

  // Per-IP backstops. checkSessionLimits only constrains logged-in users, and
  // every /api/chat/message turn is a paid model call, so without these an
  // anonymous script could mint sessions and burn OpenAI spend without bound.
  // Generous enough that a real participant never sees them.
  const chatStartLimiter = rateLimit({ windowMs: 15 * 60_000, limit: 20, standardHeaders: true, legacyHeaders: false });
  const chatMessageLimiter = rateLimit({ windowMs: 60_000, limit: 30, standardHeaders: true, legacyHeaders: false });

  // POST /api/chat/start - start a chat-only therapy session. Blocked until
  // the participant has accepted the current consent screen.
  router.post(
    '/api/chat/start',
    chatStartLimiter,
    requireConsent,
    requireOutsideQuietHours,
    requireActiveStudyStatus,
    async (req, res) => {
      const userId: number | string = req.session?.userId ?? req.sessionID;
      const numericUserId: number | null = typeof userId === 'number' ? userId : null;

      try {
        // Enforce session limits (mirrors the /token endpoint). MUST use the
        // numeric id: therapy_sessions.user_id is INTEGER, and passing an
        // anonymous express-session id string made the limit/idempotency
        // queries throw a pg cast error and 500 every anonymous chat start.
        const userRole = req.session?.userRole || 'participant';
        // A continuation of a content-filter-terminated session is not a new
        // session. The terminated session's own POST /end has just reset the
        // cooldown clock, so without this the text fallback 429s exactly when it
        // is needed — see the same exemption in liveSession.routes.ts.
        const isContinuation = typeof req.body?.continued_from === 'string';
        const limitCheck = await checkSessionLimits(numericUserId, userRole);
        if (!limitCheck.allowed && !isContinuation) {
          return res.status(429).json({
            error: 'Session limit exceeded',
            reason: limitCheck.reason,
            minutes_remaining: limitCheck.reason === 'cooldown' ? limitCheck.minutes_remaining : undefined,
          });
        }

        // One active session per user at a time (logged-in users only — the
        // integer user_id column cannot key anonymous browsers).
        // A continuation must not be turned away as "you already have a session":
        // the terminated voice session may still be finishing its teardown, and
        // the client treats alreadyActive as a failure and strands the
        // participant on the crisis screen.
        const existingSession = numericUserId && !isContinuation ? await getActiveSessionForUser(numericUserId) : null;
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
          setUserPreferredLanguage(userId, userLanguage).catch((err) =>
            log.error({ err }, '[ChatStart] Failed to save user language preference'),
          );
        }

        const sessionId = `chat_${Date.now()}_${Math.random().toString(36).substring(7)}`;
        recordSessionOwnership(req, sessionId);

        // Base prompt + returning-participant memory (opt-in) + today's check-in.
        // The proactive-offering A/B condition (ai-therapist-74) is resolved ONCE
        // here and persisted below, mirroring /token — previously the chat path
        // let getSystemPrompt re-roll internally and never recorded the arm, so
        // chat sessions could not be assigned to a condition for analysis.
        const checkin = sanitizeCheckin(req.body?.checkin);
        const memoryBlock = await buildMemoryBlock(numericUserId);
        const proactiveOffering = await resolveProactiveOffering();
        // Psychoeducation retrieval cue (ai-therapist-202): resolved once and
        // persisted like proactive_offering. Typed chat has no general tool
        // guidance block, so the cue arm gets only the retrieve_psychoeducation
        // line; NULL (experiment off) and FALSE (control) get nothing.
        const psychoeducationCue = await resolvePsychoeducationCue();
        let psychoeducationGuidance = '';
        if (psychoeducationCue === true) {
          const { toolRegistry } = await import('../../services/toolRegistry.service.js');
          const chatToolNames = (await toolRegistry.getEnabledToolDefinitions({ channel: 'chat' })).map((t) => t.name);
          psychoeducationGuidance = buildToolGuidanceBlock(
            chatToolNames.filter((name) => name === 'retrieve_psychoeducation'),
            { psychoeducationCue: true },
          );
        }
        // Lead-conversation steering (features.lead_conversation_enabled,
        // default off). Same block and position as the voice routes.
        const leadConversation = await resolveLeadConversation();
        const systemPrompt =
          (await getSystemPrompt(userLanguage, 'chat', proactiveOffering)) +
          psychoeducationGuidance +
          buildLeadConversationBlock(leadConversation) +
          memoryBlock +
          buildCheckinBlock(checkin);

        // system_config.chat_model, resolved once here and held for the whole
        // session; stamped into session_configurations.ai_model below so the
        // analysis record says which model produced this session's replies.
        const { resolveChatModel } = await import('../../utils/chatModel.js');
        const chatModel = await resolveChatModel();
        const { initializeChatSession } = await import('../../services/chatTherapy.service.js');
        initializeChatSession(sessionId, systemPrompt, chatModel);

        const username = req.session?.username || null;
        const { isNonStudyUser } = await import('../../utils/harness.js');
        await createSession({
          sessionId,
          userId: numericUserId,
          sessionName: null, // generated from the conversation when the session ends
          status: 'active',
          sessionType: 'chat',
          // Demo viewers, the eval-harness participant AND sandbox accounts
          // (C3/s7: sandbox owners' sessions are is_demo): non-study data,
          // excluded from every real analytics/export surface.
          isDemo: isNonStudyUser(userRole, username) || req.session?.isSandbox === true,
        });

        // Persist the resolved research condition + assembled instructions to
        // session_configurations, same as the voice path — this row is the
        // analysis source of truth for which arm the session ran under. A fresh
        // sessionId is minted above, so there is never an existing row to
        // clobber; the resume path (alreadyActive, earlier) never re-rolls.
        await upsertSessionConfig(sessionId, {
          modalities: ['text'],
          ai_model: chatModel,
          instructions: systemPrompt,
          language: userLanguage,
          proactive_offering: proactiveOffering,
          psychoeducation_cue: psychoeducationCue,
        });

        if (checkin) {
          const { setSessionCheckin } = await import('../../db/index.js');
          setSessionCheckin(sessionId, checkin).catch((err) =>
            log.error({ err }, '[ChatStart] Failed to store check-in'),
          );
        }

        // Durable per-session consent record, linked to the consent this
        // browser session already accepted (requireConsent guarantees it's
        // present and current by this point).
        getSystemConfig()
          .then((cfg) =>
            recordConsent({
              sessionId,
              userId: numericUserId,
              consentVersion: req.session!.consentVersion!,
              recordingEnabled: (cfg.features?.session_recording_enabled as boolean | undefined) ?? false,
            }),
          )
          .catch((err) => log.error({ err }, '[Consent] Failed to record per-session consent'));

        void broadcastAdminEvent(
          global.io,
          'session:started',
          {
            sessionId,
            userId,
            username,
            sessionType: 'chat',
            startedAt: new Date(),
          },
          numericUserId,
        );

        // CONTINUATION FROM A TERMINATED VOICE SESSION.
        //
        // OpenAI's safety filter can end a GPT-Live session outright
        // (session.closed reason 'content'), and it does so disproportionately at
        // crisis disclosure — observed 2026-09-11: a participant said "I wanna
        // kill myself", the assistant began "Hey, I'm really glad you told me",
        // and the platform cut the session mid-sentence.
        //
        // Restarting VOICE would re-seed a new session with the very content that
        // tripped the filter and would very likely hang up on them a second time.
        // The chat pipeline is structurally different: it runs through the
        // Responses API with our own moderation, which is built to engage with
        // crisis rather than terminate. So a terminated voice session continues
        // here, carrying the conversation so the participant never has to repeat
        // a disclosure they just made.
        const continuedFrom = typeof req.body?.continued_from === 'string' ? req.body.continued_from : null;

        // Server-authored opening line (utils/openingLine.ts): persisted as the
        // first assistant turn and seeded into the model history, so the AI
        // disclosure is guaranteed by construction and the model does not
        // disclaim a second time. A continuation of a terminated voice session
        // skips it — the participant already heard it and must not be greeted
        // as if starting over.
        let opening: string | null = null;
        if (!continuedFrom) {
          try {
            const cfg = await getSystemConfig();
            opening = buildChatOpeningLine(cfg.crisis_contact as Parameters<typeof buildChatOpeningLine>[0], {
              leadConversation,
            });
            const { seedAssistantOpening, injectGuidance } = await import('../../services/chatTherapy.service.js');
            seedAssistantOpening(sessionId, opening);
            // Session steering, same mechanism as the continuation recap below
            // (not a change to the stored system prompt): the prompt's "once, at
            // the start" disclaimer rule has already been satisfied by the
            // opening above, and without saying so the model repeats it in its
            // first reply (nightly 2026-10-22, diagnosis-seeking turn 1).
            injectGuidance(sessionId, CHAT_OPENING_FRAMING_GUIDANCE);
            // content_redacted is pre-filled: the text is machine-authored and
            // PHI-free, so the redaction job must not spend a model call on it.
            await insertMessagesBatch([
              {
                session_id: sessionId,
                role: 'assistant',
                message_type: OPENING_LINE_MESSAGE_TYPE,
                content: opening,
                content_redacted: opening,
                metadata: { ...OPENING_LINE_METADATA },
              },
            ]);
            if (global.io) {
              global.io
                .to(`session:${sessionId}`)
                .emit('message:new', { sessionId, role: 'assistant', message: opening, timestamp: new Date() });
            }
          } catch (err) {
            // The session must still start; the client falls back to its own
            // copy of the preamble when `opening` is absent.
            log.error({ err }, '[ChatStart] Failed to persist opening line (non-fatal)');
            opening = null;
          }
        }

        // TEXT HAND-OFF (ai-therapist-356). The voice vendor ended a session
        // and the browser came straight here, in parallel with tearing the
        // dead call down. services/textHandoff.service decides the wording
        // from the participant's real risk in the incident, flags this session
        // as its continuation and seeds it from every session of the incident;
        // the first assistant message is authored HERE, persisted like any
        // opening line and returned in this response, so it is on screen
        // before any model call.
        let handoff: HandoffStartPayload | null = null;
        if (continuedFrom) {
          try {
            const { prepareTextHandoff } = await import('../../services/textHandoff.service.js');
            const cfg = await getSystemConfig();
            const prepared = await prepareTextHandoff({
              chatSessionId: sessionId,
              continuedFrom,
              reason: req.body?.handoff_reason === 'expired' ? 'expired' : 'content',
              // Ownership is required: this seeds one session's transcript into
              // another, so it must never be reachable with someone else's id.
              canAccess: (row, id) => canAccessSession(req, row, id),
              crisisContact: cfg.crisis_contact as RecoveryCrisisContact | undefined,
              voiceEnabled: (cfg.features as { voice_enabled?: boolean } | undefined)?.voice_enabled !== false,
            });
            if (prepared) {
              const { seedAssistantOpening, injectGuidance } = await import('../../services/chatTherapy.service.js');
              // Transcript first, then the message that follows it: the model
              // reads the incident, then its own first words in writing.
              if (prepared.guidance) injectGuidance(sessionId, prepared.guidance);
              seedAssistantOpening(sessionId, prepared.firstMessage);
              opening = prepared.firstMessage;
              handoff = prepared.payload;
              await insertMessagesBatch([
                {
                  session_id: sessionId,
                  role: 'assistant',
                  message_type: OPENING_LINE_MESSAGE_TYPE,
                  content: prepared.firstMessage,
                  // Machine-authored and PHI-free: no redaction call needed.
                  content_redacted: prepared.firstMessage,
                  metadata: { ...OPENING_LINE_METADATA, text_handoff: prepared.payload.kind },
                },
              ]).catch((err) => log.error({ err }, '[ChatStart] Failed to persist the hand-off first message'));
              if (global.io) {
                global.io.to(`session:${sessionId}`).emit('message:new', {
                  sessionId,
                  role: 'assistant',
                  message: prepared.firstMessage,
                  timestamp: new Date(),
                });
              }
            } else {
              log.warn(`[ChatStart] continued_from ${continuedFrom} not accessible; starting fresh.`);
            }
          } catch (err) {
            // A failure here must still leave the participant with a working
            // chat session rather than no session.
            log.error({ err }, '[ChatStart] Failed to prepare the text hand-off');
          }
        }

        log.info(`Chat-only session started: ${sessionId.substring(0, 12)}... for user ${userId}`);

        res.json({
          success: true,
          sessionId,
          sessionType: 'chat',
          continuedFrom: continuedFrom ?? null,
          opening,
          handoff,
          message: 'Chat therapy session started',
        });
      } catch (error: unknown) {
        log.error({ err: error }, 'Failed to start chat session');
        res.status(500).json({
          error: 'Failed to start chat session',
          details: error instanceof Error ? error.message : String(error),
        });
      }
    },
  );

  // POST /api/chat/message - send a message and get the AI response
  router.post('/api/chat/message', chatMessageLimiter, async (req, res) => {
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
      if (detectMinorDisclosurePatterns(message).matched && !(await isSyntheticAccountSession(sessionId))) {
        try {
          const { confirmMinorDisclosure, handleConfirmedMinor, MINOR_ELIGIBILITY_MESSAGE } = await import(
            '../../services/minorSafeguard.service.js'
          );
          const history = await getRecentSessionMessages(sessionId, 10);
          const verdict = await confirmMinorDisclosure(message, history, sessionId);
          if (verdict.isMinor && verdict.confidence !== 'low') {
            // Score the turn for crisis BEFORE ending the session.
            //
            // This branch returns, so without it the crisis screen below is
            // never reached and handleConfirmedMinor does not run the pipeline
            // itself — it only logs eligibility, drafts an ELIGIBILITY adverse
            // event and ends the session. A minor who disclosed suicidal intent
            // in the same message that revealed their age would get no risk
            // score, no crisis flag, no on-call page and no crisis AE.
            //
            // Detection must never depend on study eligibility. An ineligible
            // minor in crisis needs the on-call paged exactly as much — arguably
            // more. The realtime path already behaves this way: the sideband
            // runs runCrisisPipeline on every participant turn independently of
            // the minor gate, so the two channels disagreed on the single
            // highest-stakes case.
            try {
              const { runCrisisPipeline } = await import('../../services/crisisPipeline.service.js');
              await runCrisisPipeline({ sessionId, messageId: userMsg.message_id, content: message }, 'chat');
            } catch (crisisErr) {
              log.error({ err: crisisErr }, '[MinorSafeguard] crisis screen on the minor path failed');
            }

            await insertMessagesBatch([
              {
                session_id: sessionId,
                role: 'assistant',
                message_type: 'text',
                content: MINOR_ELIGIBILITY_MESSAGE,
                content_redacted: null,
              },
            ]);
            await handleConfirmedMinor({
              sessionId,
              messageId: userMsg.message_id,
              channel: 'chat',
              statedAge: verdict.statedAge,
            });
            global.io
              .to(`session:${sessionId}`)
              .emit('message:new', { sessionId, role: 'user', message, timestamp: new Date() });
            global.io.to(`session:${sessionId}`).emit('message:new', {
              sessionId,
              role: 'assistant',
              message: MINOR_ELIGIBILITY_MESSAGE,
              timestamp: new Date(),
            });
            return res.json({
              success: true,
              response: MINOR_ELIGIBILITY_MESSAGE,
              sessionId,
              sessionEnded: true,
              reason: 'eligibility',
            });
          }
          if (verdict.isMinor && verdict.confidence === 'low' && global.io) {
            // False-positive escape valve: flag for a human look, don't auto-end.
            void broadcastAdminEventForSession(
              global.io,
              'session:eligibility-review',
              {
                sessionId,
                statedAge: verdict.statedAge,
                reasoning: verdict.reasoning,
                channel: 'chat',
                at: new Date(),
              },
              sessionId,
            );
          }
        } catch (err) {
          log.error({ err }, '[MinorSafeguard] confirm failed (fail-open)');
        }
      }

      const { detectCrisisKeywords, needsContextAssessment } = await import(
        '../../services/crisisDetection.service.js'
      );
      const { runCrisisPipeline } = await import('../../services/crisisPipeline.service.js');
      const { sendMessage, injectGuidance } = await import('../../services/chatTherapy.service.js');

      // Crisis screen: run the cheap sync keyword screen pre-model. Only
      // keyword-hit turns pay for an inline LLM assessment — which buys
      // SAME-TURN steering. Clean turns defer everything (incl. the 8-turn LLM
      // sweep) to post-response, exactly like /logs/batch, so the happy path
      // adds no LLM call before the reply.
      //
      // In between (ai-therapist-299): a keyword-free turn that carries a
      // context-dependent signal, or that arrives in a session already flagged
      // or recently risk-bearing ("I'm going to do it tonight" after an
      // ideation turn). It is assessed before the reply too, so the steer
      // lands on THIS turn, but only up to CHAT_CONTEXT_ASSESS_DEADLINE_MS: the
      // reply is never held longer than that for an assessor that is slow or
      // down. Past the deadline the pipeline keeps running (it still flags and
      // pages when it finishes) and its steer lands on the next turn, exactly
      // like the deferred path.
      //
      // One exception (ai-therapist-356, step 1b): the first participant turn
      // after a crisis text hand-off. It answers a question the app itself
      // asked a moment ago, in a session that is already flagged and already
      // carries the safety-protocol steer (textHandoff.service), so waiting
      // two to three seconds for the assessor would buy no steering the model
      // does not have. The pipeline runs ALONGSIDE the model call instead: it
      // scores, flags and pages exactly as it would have, and any steer it
      // returns lands on the next turn.
      const { consumeNarrowFirstTurn, isHandoffSession, resolveVoiceReturn } = await import(
        '../../services/textHandoff.service.js'
      );
      const narrowFirstTurn = consumeNarrowFirstTurn(sessionId);
      let narrowPipeline: Promise<unknown> | null = null;

      let steering: string | null = null;
      try {
        if (narrowFirstTurn) {
          narrowPipeline = runCrisisPipeline({ sessionId, messageId: userMsg.message_id, content: message }, 'chat')
            .then((r) => {
              if (r.steeringGuidance) injectGuidance(sessionId, r.steeringGuidance);
            })
            .catch((err) => log.error({ err }, '[ChatCrisis] hand-off first-turn pipeline failed'));
        } else if (detectCrisisKeywords(message).keywordScore > 0) {
          const risk = await runCrisisPipeline({ sessionId, messageId: userMsg.message_id, content: message }, 'chat');
          steering = risk.steeringGuidance;
        } else if (
          // needsContextAssessment never throws; if it somehow does, assess the
          // turn (bounded below) rather than skip its detection altogether.
          await needsContextAssessment(sessionId, message).catch((err) => {
            log.error({ err }, '[ChatCrisis] context check failed; assessing the turn anyway');
            return true;
          })
        ) {
          let settled = false;
          let timer: NodeJS.Timeout | undefined;
          const pending = runCrisisPipeline({ sessionId, messageId: userMsg.message_id, content: message }, 'chat');
          const inTime = await Promise.race([
            pending.then((r) => {
              settled = true;
              return r;
            }),
            new Promise<null>((resolve) => {
              timer = setTimeout(() => resolve(null), CHAT_CONTEXT_ASSESS_DEADLINE_MS);
            }),
          ]);
          clearTimeout(timer);
          if (inTime) {
            steering = inTime.steeringGuidance;
          } else if (!settled) {
            log.warn(
              `[ChatCrisis] context assessment for session ${sessionId.substring(0, 12)}... passed ` +
                `${CHAT_CONTEXT_ASSESS_DEADLINE_MS}ms; replying now, detection continues in the background`,
            );
            void pending
              .then((r) => {
                if (r.steeringGuidance) injectGuidance(sessionId, r.steeringGuidance);
              })
              .catch((err) => log.error({ err }, '[ChatCrisis] late context pipeline failed'));
          }
        } else {
          // Clean turn: run the pipeline after the response ships (covers the
          // periodic sweep); any steering lands on the NEXT turn.
          res.on(
            'finish',
            () =>
              void runCrisisPipeline({ sessionId, messageId: userMsg.message_id, content: message }, 'chat')
                .then((r) => {
                  if (r.steeringGuidance) injectGuidance(sessionId, r.steeringGuidance);
                })
                .catch((err) => log.error({ err }, '[ChatCrisis] deferred pipeline failed')),
          );
        }
      } catch (err) {
        // A crisis-pipeline error must degrade to "reply without steering",
        // never a 500. analyzeMessageRisk already zeros on internal error.
        log.error({ err }, '[ChatCrisis] inline pipeline failed (fail-open, no steering)');
      }

      // Model call, with steering injected BEFORE the turn when present.
      if (steering) injectGuidance(sessionId, steering);
      const { text: aiResponse, toolEvents } = narrowFirstTurn
        ? await sendMessage(sessionId, message, { narrowCrisisTurn: true })
        : await sendMessage(sessionId, message);

      // Persist the assistant turn; content_redacted is filled in once per
      // session at session end (see sessionRedaction.service), not per message.
      await insertMessagesBatch([
        { session_id: sessionId, role: 'assistant', message_type: 'text', content: aiResponse, content_redacted: null },
      ]);

      // Live-monitoring events.
      global.io
        .to(`session:${sessionId}`)
        .emit('message:new', { sessionId, role: 'user', message, timestamp: new Date() });
      global.io
        .to(`session:${sessionId}`)
        .emit('message:new', { sessionId, role: 'assistant', message: aiResponse, timestamp: new Date() });

      log.info(`[ChatTherapy] Message exchanged for session ${sessionId.substring(0, 12)}...`);

      // toolEvents: overlay tools the model invoked this turn (resource card,
      // safety plan, thought record, ...). The chat client dispatches these
      // through the same fns map the realtime data channel drives, so tool
      // overlays render identically in both modes (ai-therapist-118).
      //
      // handoff.voiceReturnAllowed (hand-off sessions only): whether the
      // browser may offer a new voice call now. On the narrow first turn the
      // assessor is given a moment to finish, so a "yes" that scores high is
      // already counted; if it has not finished, the answer is no.
      let handoffState: { voiceReturnAllowed: boolean } | undefined;
      if (isHandoffSession(sessionId)) {
        let scored = true;
        if (narrowPipeline) {
          let timer: NodeJS.Timeout | undefined;
          scored = await Promise.race([
            narrowPipeline.then(() => true),
            new Promise<boolean>((resolve) => {
              timer = setTimeout(() => resolve(false), HANDOFF_FIRST_TURN_SCORE_WAIT_MS);
            }),
          ]);
          clearTimeout(timer);
        }
        handoffState = { voiceReturnAllowed: scored && (await resolveVoiceReturn(sessionId)) === true };
      }

      res.json({
        success: true,
        response: aiResponse,
        toolEvents,
        sessionId,
        ...(handoffState ? { handoff: handoffState } : {}),
      });
    } catch (error: unknown) {
      log.error({ err: error }, 'Failed to process chat message');

      // Blocked safety identifier (ai-therapist-186): permanent on the
      // provider's side, so answer with the dedicated code that drives the
      // supportive screen instead of a generic 500.
      // Unrehydratable session (ai-therapist-222): the process restarted and
      // the session's context could not be rebuilt from the database. That is
      // a client-actionable state ("start a new session"), not a server fault.
      const { isChatSessionUnavailableError } = await import('../../services/chatTherapy.service.js');
      if (isChatSessionUnavailableError(error)) {
        log.warn(`[Chat] Session ${sessionId} unavailable for this turn: ${error.message}`);
        return res.status(409).json({ error: 'session_unavailable', message: error.participantMessage });
      }

      const { isIdentifierBlockedError } = await import('../../utils/safetyIdentifier.js');
      if (isIdentifierBlockedError(error)) {
        log.error(
          '[Chat] BLOCKED SAFETY IDENTIFIER — participant cannot send messages; study team must re-enroll or contact OpenAI.',
        );
        return res.status(403).json({ error: 'identifier_blocked' });
      }

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
        log.info(`Chat session ${sessionId} already ended, returning existing data (idempotent)`);
        return res.status(200).json({ ...session, alreadyEnded: true, message: 'Session was already ended' });
      }

      const { endChatSession } = await import('../../services/chatTherapy.service.js');
      endChatSession(sessionId);

      // Drop the per-session steering cooldown entry (mirrors the opportunistic
      // in-memory cleanup on the realtime side).
      const { clearSteeringState } = await import('../../services/crisisIntervention.service.js');
      clearSteeringState(sessionId);
      // The hand-off's stored rows stay (a voice call started from this chat
      // is checked against them); only the in-process copy goes.
      const { clearHandoffState } = await import('../../services/textHandoff.service.js');
      clearHandoffState(sessionId);

      const updatedSession = await updateSessionStatus(sessionId, 'ended', 'user');

      // Redact the whole session in one batched job (fire-and-forget), THEN
      // auto-name from the redacted transcript — naming must run after redaction
      // populates content_redacted, or it names a blank transcript (wave1 bug 1).
      import('../../services/sessionRedaction.service.js')
        .then((m) => m.redactSession(sessionId))
        .then(() => generateSessionNameAsync(sessionId))
        .catch((e) => log.error({ err: e }, '[Redaction] session redaction/naming failed'));

      // Memory summary + draft SOAP note (fire-and-forget).
      import('../../services/sessionInsights.service.js')
        .then((m) => m.generateSessionInsightsAsync(sessionId))
        .catch((e) => log.error({ err: e }, '[Insights] generation failed'));

      void broadcastAdminEventForSession(
        global.io,
        'session:ended',
        { sessionId, endedBy: 'user', endedAt: new Date() },
        sessionId,
        'summary',
      );
      global.io.to(`session:${sessionId}`).emit('session:ended', { sessionId, endedAt: new Date() });

      log.info(`Chat session ${sessionId.substring(0, 12)}... ended by user`);

      res.json({ success: true, message: 'Chat session ended', session: updatedSession });
    } catch (error: unknown) {
      log.error({ err: error }, 'Failed to end chat session');
      res.status(500).json({
        error: 'Failed to end session',
        details: error instanceof Error ? error.message : String(error),
      });
    }
  });

  // POST /api/chat/voice-return - may a new voice call be started from this
  // text hand-off chat right now? (ai-therapist-356.) Asked by the browser
  // before it ends the chat to start the call, so a risk check that is no
  // longer clear costs the participant nothing: the chat simply continues.
  // POST /api/live/session checks again when the call is actually requested.
  router.post('/api/chat/voice-return', chatMessageLimiter, async (req, res) => {
    const sessionId: unknown = req.body?.sessionId;
    if (typeof sessionId !== 'string' || !sessionId) {
      return res.status(400).json({ error: 'sessionId is required' });
    }
    try {
      const { verifyVoiceReturn } = await import('../../services/textHandoff.service.js');
      const allowed = await verifyVoiceReturn(sessionId, (row, id) => canAccessSession(req, row, id));
      res.json({ allowed });
    } catch (error: unknown) {
      log.error({ err: error }, 'Failed to check voice return');
      res.json({ allowed: false });
    }
  });

  return router;
}
