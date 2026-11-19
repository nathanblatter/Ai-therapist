// GPT-Live session creation. The Live counterpart to token.routes.ts.
//
// The connection handshake is materially different from Realtime, and the
// difference is an improvement worth calling out. Realtime mints an ephemeral
// client secret, the browser POSTs its SDP straight to OpenAI, and the server
// only learns the call id when the browser scrapes it out of a `Location`
// response header — a step that silently fails whenever CORS hides the header,
// which is exactly what the `sideband_no_location` beacon in App.tsx exists to
// report.
//
// GPT-Live inverts it: the browser sends its SDP offer to US, we create the
// session with the project API key, and the session id comes back in the JSON
// body. No ephemeral key ever reaches the browser, no header scraping, and the
// sideband can attach before the answer is even returned to the client.
//
// Note the billing consequence, from the cost guide: POST /v1/live/sessions
// bills 15 seconds of voice duration at initialization, credited back against
// the running session. A created-but-abandoned session therefore costs real
// money, so this endpoint runs every gate (consent, quiet hours, study status,
// rate limits) BEFORE calling OpenAI.

import { Router, type Request, type Response } from 'express';
import { randomUUID } from 'node:crypto';
import { hashToken } from '../../utils/crypto.js';
import { getOpenAIKey } from '../../config/secrets.js';
import {
  getActiveSessionForUser,
  upsertSessionConfig,
  getAiModel,
  getUserPreferences,
  updateUserPreferences,
  createActiveRealtimeSession,
  recordConsent,
  setSessionCheckin,
  updateSessionStatus,
  setLiveSessionId,
  markSidebandUnmonitored,
} from '../../db/index.js';
import {
  checkSessionLimits,
  getSystemPrompt,
  getActiveModality,
  getSystemConfig,
  resolveProactiveOffering,
  resolvePsychoeducationCue,
  resolveLeadConversation,
  getLanguageName,
} from '../../utils/sessionHelpers.js';
import { recordSessionOwnership } from '../../utils/sessionOwnership.js';
import {
  sanitizeCheckin,
  buildCheckinBlock,
  buildParticipantContextBlock,
  buildToolGuidanceBlock,
  buildLeadConversationBlock,
} from '../../utils/promptContext.js';
import { requireConsent } from '../../middleware/consent.js';
import { requireOutsideQuietHours } from '../../middleware/quietHours.js';
import { requireActiveStudyStatus } from '../../middleware/studyStatus.js';
import { sessionLimitRefusalFor } from '../../utils/sessionLimitRefusal.js';
import { broadcastAdminEvent } from '../../utils/adminBroadcast.js';
import { scheduleAutoTermination } from '../../utils/sessionAutoTerminate.js';
import {
  buildLiveSessionConfig,
  isLiveModel,
  resolveLiveVoice,
  LIVE_DEFAULT_BACKEND_MODEL,
  resolveBackendReasoningEffort,
  hasStudyContact,
} from '../../utils/liveSessionConfig.js';
import {
  DEFAULT_CRISIS_CONTACT,
  LIVE_RECOVERY_NUDGE_LOG,
  liveOpeningInstruction,
  type OpeningCrisisContact,
} from '../../../shared/openingPrompt.js';
import { sidebandManager } from '../../services/sidebandManager.service.js';
import { buildRecoverySpeakFirstNudge, type RecoveryCrisisContact } from '../../../shared/recoveryPrompt.js';
import { registerLiveOpening, scheduleLiveOpeningFallback } from '../../services/liveOpening.service.js';

import { createLogger } from '../../utils/logger.js';
import { classifyOpenAIError, classifyOpenAIResponse } from '../../utils/openaiErrors.js';

const log = createLogger('liveSessionRoutes');

// Upper bound on the OpenAI session mint. A healthy mint is an SDP exchange
// that returns in a couple of seconds; 20s is generous for a slow one while
// still ending the participant's "Connecting..." state in bounded time (the
// client does not time this request out itself).
const LIVE_MINT_TIMEOUT_MS = 20_000;

/**
 * What the participant is told when the voice provider cannot start a session
 * (billing ceiling, rate limit, overload, timeout). Honest that it is our
 * side, deliberately free of provider/billing detail, and not alarming.
 */
export const PROVIDER_UNAVAILABLE_BODY = {
  error: 'provider_unavailable',
  message:
    'Voice sessions are temporarily unavailable. This is a problem on our side, not with your connection. ' +
    'Please try again a little later.',
} as const;

const PARTICIPANT_COOKIE = 'att_pid';
const PARTICIPANT_COOKIE_MAX_AGE_MS = 400 * 24 * 60 * 60 * 1000;

/** Read the participant cookie without cookie-parser (only one we need). */
function readParticipantCookie(req: Request): string | null {
  const header = req.headers.cookie;
  if (!header) return null;
  for (const part of header.split(';')) {
    const [name, ...rest] = part.trim().split('=');
    if (name === PARTICIPANT_COOKIE) {
      const value = rest.join('=');
      if (/^[0-9a-f-]{36}$/i.test(value)) return value;
    }
  }
  return null;
}

/** Stable, non-PII per-participant identifier for OpenAI abuse enforcement. */
function getSafetyIdentifier(req: Request, res: Response, userId: number | string | null): string {
  if (userId) return hashToken(`user:${userId}`);
  let pid = readParticipantCookie(req);
  if (!pid) {
    pid = randomUUID();
    res.cookie(PARTICIPANT_COOKIE, pid, {
      maxAge: PARTICIPANT_COOKIE_MAX_AGE_MS,
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
      path: '/',
    });
  }
  return hashToken(`participant:${pid}`);
}

export default function liveSessionRoutes(): Router {
  const router = Router();

  /**
   * POST /api/live/session — exchange an SDP offer for a GPT-Live session.
   *
   * Body: { sdp, voice?, language?, checkin? }
   * Returns: { session_id, sdp, session_limits, voice, language }
   */
  router.post(
    '/api/live/session',
    requireConsent,
    requireOutsideQuietHours,
    requireActiveStudyStatus,
    async (req, res) => {
      try {
        const sdpOffer = req.body?.sdp;
        if (typeof sdpOffer !== 'string' || !sdpOffer.trim()) {
          return res.status(400).json({ error: 'An SDP offer is required' });
        }

        // GPT-Live is the only voice backend, but ai_model remains admin-editable
        // and a typo there would otherwise be sent to OpenAI as a model id and
        // fail with an opaque 400 mid-handshake. Fail loudly and early instead.
        const aiModel = await getAiModel();
        if (!isLiveModel(aiModel)) {
          log.error(
            `system_config.ai_model is '${aiModel}', which is not a GPT-Live model. ` +
              'Voice sessions cannot start until it is set to a gpt-live-* id.',
          );
          return res.status(409).json({
            error: 'live_not_active',
            message: 'The voice backend is misconfigured. Please contact the research team.',
          });
        }

        const userId = req.session?.userId || null;
        const userRole = req.session?.userRole || null;

        // RECOVERY START — read BEFORE the limit gate, deliberately.
        //
        // When OpenAI's content filter terminates a session mid-crisis the
        // client brings the assistant straight back with recovery: true. That
        // continuation must not be rate limited, and the bug this guards
        // against was guaranteed rather than unlikely: handleModerationTermination
        // tears the old session down first, and POST /end stamps ended_at = now,
        // so the cooldown clock has JUST been reset by the very session the
        // filter killed. With the shipped default (cooldown_minutes: 30) every
        // logged-in participant's recovery 429'd — both voice attempts and the
        // text fallback — leaving someone who had just disclosed suicidal
        // intent looking at "I'm coming right back" forever.
        //
        // A filter-terminated session is a continuation of one the participant
        // already spent their quota on, not a new session.
        const isRecovery = req.body?.recovery === true;

        const limitCheck = await checkSessionLimits(userId, userRole);
        if (!limitCheck.allowed && !isRecovery) {
          log.info({ reason: limitCheck.reason }, `Session limit exceeded for user ${userId}`);
          return res.status(429).json(await sessionLimitRefusalFor(limitCheck));
        }

        // Idempotency: one active session per user. Checked before the OpenAI
        // call so a double-click can't bill two session initializations.
        // Recovery skips this too: the terminated session may not have finished
        // its teardown yet, and returning "you already have a session" would
        // block the assistant's return with a message about session hygiene.
        if (userId && !isRecovery) {
          const existing = await getActiveSessionForUser(userId);
          if (existing) {
            return res.status(200).json({
              session: { id: existing.session_id, exists: true, created_at: existing.created_at },
              message: 'Active session already exists. Please end current session before starting a new one.',
            });
          }
        }

        // Voice/language: request body wins, else saved preferences, else defaults.
        let userVoice = req.body?.voice;
        let userLanguage = req.body?.language;
        if ((!userVoice || !userLanguage) && userId) {
          try {
            const prefs = await getUserPreferences(userId);
            userVoice = userVoice || prefs?.preferred_voice;
            userLanguage = userLanguage || prefs?.preferred_language;
          } catch (err) {
            log.error({ err }, 'Failed to load user preferences, using defaults');
          }
        }
        userVoice = resolveLiveVoice(userVoice);
        userLanguage = userLanguage || 'en';

        if (userId) {
          updateUserPreferences(userId, userVoice, userLanguage).catch((err) =>
            log.error({ err }, 'Failed to save user preferences'),
          );
        }

        // Assemble the clinical prompt exactly as the Realtime path does, so the
        // two backends run identical therapeutic content and remain comparable
        // as study conditions. buildLiveSessionConfig routes it to the DELEGATED
        // BACKEND rather than the voice model; see liveSessionConfig.ts.
        const { toolRegistry } = await import('../../services/toolRegistry.service.js');
        const toolDefs = await toolRegistry.getEnabledToolDefinitions();
        const checkin = sanitizeCheckin(req.body?.checkin);
        // Memory block when opted in, else the screener cue alone (ai-therapist-345).
        const memoryBlock = await buildParticipantContextBlock(userId);
        // Psychoeducation retrieval cue (ai-therapist-202): resolved once per
        // session and persisted below, like proactive_offering. A crisis
        // recovery start is never enrolled: it runs with delegation off and
        // its own narrow prompt, so it is recorded as not in the experiment.
        const psychoeducationCue = isRecovery ? null : await resolvePsychoeducationCue();
        const toolGuidance = buildToolGuidanceBlock(
          toolDefs.map((t) => t.name),
          { psychoeducationCue: psychoeducationCue === true },
        );
        const proactiveOffering = await resolveProactiveOffering();
        // Lead-conversation steering (features.lead_conversation_enabled,
        // default off). A recovery start keeps its own narrow crisis prompt.
        const leadConversation = isRecovery ? false : await resolveLeadConversation();
        const systemPrompt =
          (await getSystemPrompt(userLanguage, 'realtime', proactiveOffering)) +
          toolGuidance +
          buildLeadConversationBlock(leadConversation) +
          memoryBlock +
          buildCheckinBlock(checkin);
        const activeModality = await getActiveModality();

        const systemConfig = await getSystemConfig();
        const backendModel =
          (typeof systemConfig.live_backend_model === 'string' && systemConfig.live_backend_model) ||
          LIVE_DEFAULT_BACKEND_MODEL;

        // Non-study determination is needed BEFORE the OpenAI call, because
        // `store` is a creation-time field. Storage is what makes a session
        // forkable for the counterfactual eval harness, and it means OpenAI
        // retains the audio for 30 days — so it is enabled for demo, sandbox
        // and simulated sessions only, never for a real participant.
        const { isNonStudyUser } = await import('../../utils/harness.js');
        const isDemoSession = isNonStudyUser(userRole, req.session?.username) || req.session?.isSandbox === true;

        // RECOVERY START. Set when the previous voice session was terminated by
        // OpenAI's content filter (session.closed reason 'content') and the
        // client is bringing the participant straight back rather than leaving
        // them alone. See buildLiveRecoveryInstructions for why the prompt is
        // narrower and why NO prior conversation is replayed.
        const crisisContact = (systemConfig.crisis_contact ?? {}) as { phone?: string; text?: string };
        const crisisLine = [
          crisisContact.phone ? `${crisisContact.phone}` : '988',
          crisisContact.text ? `or text ${crisisContact.text}` : '',
        ]
          .filter(Boolean)
          .join(' ');

        if (isRecovery && !limitCheck.allowed) {
          log.warn(
            `Session limits BYPASSED for a crisis recovery start (reason: ${limitCheck.reason}). ` +
              'A content-filter termination is a continuation, not a new session.',
          );
        }

        if (isRecovery) {
          log.warn(
            `RECOVERY session start for user ${userId ?? 'anonymous'} — the previous voice ` +
              'session was terminated by the content filter. Resuming in crisis-support mode.',
          );
        }

        // Decided before the OpenAI call because the data-channel permission
        // block is a creation-time field: with a sideband the browser's channel
        // is locked and the server does all steering; with the kill switch
        // thrown there is no server-side channel, so the browser keeps its old
        // allow-all channel or the opening disclosure could not be spoken.
        const sidebandEnabled = process.env.SIDEBAND_ENABLED !== 'false';

        const sessionConfig = buildLiveSessionConfig({
          model: aiModel,
          voice: userVoice,
          languageName: await getLanguageName(userLanguage),
          systemPrompt,
          toolDefs,
          backendModel,
          backendReasoningEffort: resolveBackendReasoningEffort(
            systemConfig.live_backend_reasoning_effort,
            backendModel,
          ),
          storable: isDemoSession,
          recovery: isRecovery
            ? {
                crisisLine,
                speakFirst: buildRecoverySpeakFirstNudge(crisisContact as RecoveryCrisisContact),
                // A demo, sandbox or clinical-deployment session has no research
                // team or consent form to point a factual question to.
                studyContact: hasStudyContact(systemConfig.deployment_mode, isDemoSession),
              }
            : undefined,
          psychoeducationCue: psychoeducationCue === true,
          leadConversation,
          allowClientSteering: !sidebandEnabled,
        });

        const apiKey = await getOpenAIKey();
        const safetyIdentifier = getSafetyIdentifier(req, res, userId);

        // Bounded, and never retried here: a mint that stalls (or that OpenAI
        // rejects for capacity or billing reasons) must come back to the
        // participant as a plain "not available right now", not as a spinner.
        // Without the timeout a stalled upstream held this request open for
        // the platform's default five minutes.
        let response: globalThis.Response;
        try {
          response = await fetch('https://api.openai.com/v1/live/sessions', {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${apiKey}`,
              'Content-Type': 'application/json',
              'OpenAI-Safety-Identifier': safetyIdentifier,
            },
            body: JSON.stringify({
              session: sessionConfig,
              transport: { type: 'webrtc', sdp: sdpOffer },
            }),
            signal: AbortSignal.timeout(LIVE_MINT_TIMEOUT_MS),
          });
        } catch (err) {
          log.error({ err, kind: classifyOpenAIError(err).kind }, 'OpenAI session creation did not complete');
          return res.status(503).json(PROVIDER_UNAVAILABLE_BODY);
        }

        if (!response.ok) {
          const errorText = await response.text();
          log.error({ status: response.status, body: errorText }, 'OpenAI session creation failed');

          const { isIdentifierBlockedError } = await import('../../utils/safetyIdentifier.js');
          if (isIdentifierBlockedError(null, errorText)) {
            log.error(
              `BLOCKED SAFETY IDENTIFIER for user ${userId ?? 'anonymous'} — ` +
                'participant cannot start sessions; study team must re-enroll or contact OpenAI.',
            );
            return res.status(403).json({ error: 'identifier_blocked' });
          }

          // Upstream is refusing for a reason the participant can do nothing
          // about: a billing/spend ceiling (ai-therapist-190), a rate limit,
          // or an overloaded/erroring provider. Say so honestly instead of
          // the generic 500 that the client renders as "check your
          // connection". A spend-limit rejection also pages the on-call: it
          // means every OpenAI call is failing, crisis assessor included.
          const failure = classifyOpenAIResponse(response.status, errorText, response.headers);
          if (failure.kind === 'quota') {
            const { reportOpenAIQuotaExhausted } = await import('../../services/crisisAlert.service.js');
            void reportOpenAIQuotaExhausted('voice_session_mint', failure.code);
          }
          if (failure.kind !== 'other') {
            return res.status(503).json(PROVIDER_UNAVAILABLE_BODY);
          }
          throw new Error(`OpenAI Live API error: ${response.status} ${errorText}`);
        }

        const data = await response.json();
        const liveSessionId: string | undefined = data?.session?.id;
        const sdpAnswer: string | undefined = data?.transport?.sdp;
        if (!liveSessionId || !sdpAnswer) {
          log.error({ data }, 'Invalid session response structure');
          throw new Error('Invalid response from OpenAI Live API — missing session.id or transport.sdp');
        }

        // The Live session id is also our therapy session id, mirroring how the
        // Realtime path uses the client-secret session id. Treated as opaque:
        // the prefix is preserved and never parsed.
        const sessionId = liveSessionId;
        const username = req.session?.username || null;

        recordSessionOwnership(req, sessionId);

        try {
          await createActiveRealtimeSession(sessionId, userId, isDemoSession);

          // Before the attach, deliberately. This column is what
          // reattachActiveSessions keys on after a deploy, and what says which
          // OpenAI session an attach failure belongs to. Writing it only from
          // handleOpen meant an attach that never opened — or a restart in the
          // window between creation and attach — left an active, unmonitored
          // session with no id to recover it by.
          await setLiveSessionId(sessionId, liveSessionId);

          if (checkin) {
            setSessionCheckin(sessionId, checkin).catch((err) => log.error({ err }, 'Failed to store check-in'));
          }

          recordConsent({
            sessionId,
            userId,
            consentVersion: req.session!.consentVersion!,
            recordingEnabled: (systemConfig.features?.session_recording_enabled as boolean | undefined) ?? false,
          }).catch((err) => log.error({ err }, '[Consent] Failed to record per-session consent'));

          void broadcastAdminEvent(
            global.io,
            'session:created',
            {
              sessionId,
              userId,
              username,
              status: 'active',
              created_at: new Date(),
            },
            userId,
            'summary',
          );

          await upsertSessionConfig(sessionId, {
            voice: userVoice,
            modalities: ['text', 'audio'],
            instructions: systemPrompt,
            // GPT-Live owns turn-taking, transcribes internally, and exposes no
            // temperature or output-token cap on the voice model. Left at the
            // column defaults rather than invented, so an analyst reading
            // session_configurations is not misled into thinking these were set.
            turn_detection: null,
            tools: toolDefs,
            language: userLanguage,
            modality: activeModality?.key ?? null,
            // Model pinning (ai-therapist-61): a GPT-Live voice session runs on
            // TWO models, and the delegated backend is the one that actually
            // produces the clinical content — so it is pinned per session
            // alongside the voice model, not just left to system_config.
            ai_model: aiModel,
            live_backend_model: backendModel,
            transcription_model: null, // GPT-Live transcribes internally.
            proactive_offering: proactiveOffering,
            psychoeducation_cue: psychoeducationCue,
          });
        } catch (dbError) {
          log.error({ err: dbError }, 'Failed to create session in database');
          // Continue: the voice session is already live and billing. Losing it
          // over a DB hiccup would be worse than running with a lazily-created row.
        }

        // The sideband must be OPEN before this route returns, and a failure to
        // attach must fail the session start.
        //
        // Under Realtime this was a best-effort side effect, and that was
        // defensible: participant speech also reached the server through the
        // client's /logs/batch transcript upload, so a dead sideband cost
        // steering and tool execution while detection kept running. GPT-Live
        // removed that second path — the client no longer logs transcripts, so
        // SidebandManager.onUserTurn is the ONLY writer and the only
        // runCrisisPipeline caller for voice. Starting a voice session whose
        // sideband never attached means a participant could disclose intent
        // and have it neither scored, flagged, paged, nor recorded.
        //
        // So: await the open, and on failure hang up the OpenAI session and
        // surface an error rather than handing back a live, unmonitored one.
        if (!sidebandEnabled) {
          // Explicitly loud. This kill switch now disables crisis detection on
          // the voice path, which it did not under Realtime.
          log.warn(
            'SIDEBAND_ENABLED=false — starting a voice session with NO crisis detection. ' +
              'This switch is far more dangerous under GPT-Live than it was under Realtime.',
          );
          // ...and queryable, not just loud in a log nobody reads. Without this
          // an intentionally unmonitored session is indistinguishable on the
          // row from one whose attach simply has not landed yet.
          await markSidebandUnmonitored(
            sessionId,
            'monitoring_disabled: SIDEBAND_ENABLED=false at session start',
          ).catch((e: unknown) => log.error({ err: e }, 'Failed to record the disabled sideband'));
        } else {
          try {
            await sidebandManager.connectAndWait(sessionId, liveSessionId, apiKey, {
              model: aiModel,
              backendModel,
              // Must match the delegation block buildLiveSessionConfig sent:
              // recovery runs client-delegated with no backend or tools.
              delegationMode: isRecovery ? 'client' : 'responses',
            });
          } catch (err) {
            log.error(
              { err },
              `Sideband attach FAILED for ${sessionId} — refusing to start an unmonitored ` + 'voice session',
            );

            // Hang up the OpenAI side so the participant's browser cannot keep
            // talking to a session we are not watching, and so we stop paying
            // for it.
            await fetch(`https://api.openai.com/v1/live/sessions/${encodeURIComponent(liveSessionId)}/hangup`, {
              method: 'POST',
              headers: { Authorization: `Bearer ${apiKey}` },
            }).catch((e: unknown) => log.error({ err: e }, 'hangup after failed attach also failed'));

            await updateSessionStatus(sessionId, 'ended', 'system').catch((e: unknown) =>
              log.error({ err: e }, 'Failed to mark unmonitored session ended'),
            );

            return res.status(503).json({
              error: 'monitoring_unavailable',
              message: 'We could not start your session right now. Please try again in a moment.',
            });
          }

          // The opening is authored here and held until the browser reports
          // `session.started` (POST /api/sessions/:id/opening). The browser's
          // data channel can no longer append instructions, so this is the only
          // way the disclosure preamble, or the recovery speak-first nudge, is
          // ever spoken. See liveOpening.service.ts for why it waits.
          // Same text the browser authored before the lock, from the same
          // builder: both opening variants (lead_conversation off and on) and
          // the crisis contact GET /api/config/crisis serves the browser.
          registerLiveOpening(
            sessionId,
            isRecovery
              ? {
                  // The same text is already in the session's startup input
                  // (recovery.speakFirst); delivered as commentary, the
                  // documented way to have GPT-Live open a conversation.
                  text: buildRecoverySpeakFirstNudge(crisisContact as RecoveryCrisisContact),
                  logMessage: LIVE_RECOVERY_NUDGE_LOG,
                  via: 'commentary' as const,
                }
              : liveOpeningInstruction(
                  userLanguage,
                  (systemConfig.crisis_contact as OpeningCrisisContact | undefined) || DEFAULT_CRISIS_CONTACT,
                  leadConversation,
                ),
          );
          scheduleLiveOpeningFallback(sessionId);
        }

        // `limitCheck.allowed` narrows the union: the denied variants carry no
        // limits/bypass. A recovery start can now proceed while denied, so this
        // must be guarded rather than assuming the allowed shape. A recovery
        // session still gets its duration cap when one applies.
        // A recovery session continues a crisis the platform cut. Its own row
        // must say so, or every server-side crisis path (vendor-ceiling
        // recovery, on-call wording, the end_session guard) runs blind on it.
        if (isRecovery) {
          try {
            const { markSessionCrisisContinuation } = await import('../../db/index.js');
            await markSessionCrisisContinuation(sessionId);
          } catch (err) {
            log.error({ err }, `failed to flag recovery session ${sessionId} as a crisis continuation`);
          }
        }

        if (limitCheck.allowed && limitCheck.limits?.max_duration_minutes && !limitCheck.bypass) {
          scheduleAutoTermination({
            sessionId,
            maxDurationMinutes: limitCheck.limits.max_duration_minutes,
            steer: (id, text, respond) => sidebandManager.tryInject(id, 'system', text, respond),
            teardown: (id) => sidebandManager.disconnect(id),
            backend: 'live',
          });
          // A recovery session IS a crisis session: it is a continuation of
          // one that was flagged and cut. Run it to the vendor ceiling, never
          // to the ordinary limit (ai-therapist-281).
          if (isRecovery) {
            const { liftLimitForCrisis } = await import('../../utils/sessionAutoTerminate.js');
            const { resolveVendorCeilingMinutes } = await import('../../utils/sessionHelpers.js');
            const ceiling = await resolveVendorCeilingMinutes();
            const lift = liftLimitForCrisis(sessionId, ceiling);
            if (lift.lifted) {
              import('../../services/crisisDetection.service.js')
                .then((m) =>
                  m.logInterventionAction(sessionId, 'crisis_timer_extended', {
                    trigger: 'recovery_continuation',
                    previousLimitMinutes: lift.previousLimitMinutes,
                    ceilingMinutes: lift.ceilingMinutes,
                  }),
                )
                .catch((err) => log.error({ err }, 'failed to log the recovery timer lift'));
            }
          }
        }

        res.status(201).json({
          session_id: sessionId,
          sdp: sdpAnswer,
          voice: userVoice,
          language: userLanguage,
          session_limits: limitCheck.allowed ? limitCheck.limits || null : null,
          // True when the browser's data channel is restricted to
          // LIVE_CLIENT_EVENTS: it must ask the server for the opening and must
          // not attempt an instructions append of its own.
          data_channel_locked: sidebandEnabled,
          // How the opening ends (shared/openingPrompt.ts). The server delivers
          // it; the browser needs this only for the unlocked fallback.
          lead_conversation: leadConversation,
        });
      } catch (error) {
        log.error({ err: error }, 'Session creation error');
        res.status(500).json({ error: 'Failed to create Live session' });
      }
    },
  );

  return router;
}
