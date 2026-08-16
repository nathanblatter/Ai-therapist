// Realtime session token endpoint. Mints an OpenAI Realtime client secret with
// the user's voice/language/prompt, creates the backing therapy session, and
// schedules auto-termination when a max duration is configured. Anonymous users
// are allowed; rate limits are enforced via checkSessionLimits.
import { Router, type Request, type Response } from 'express';
import { createHash, randomUUID } from 'node:crypto';
import { getOpenAIKey } from '../../config/secrets.js';
import {
  getActiveSessionForUser,
  updateSessionStatus,
  upsertSessionConfig,
  getAiModel,
  getTranscriptionModel,
  getUserPreferences,
  updateUserPreferences,
  getSessionAccessInfo,
  createActiveRealtimeSession,
  recordConsent,
} from '../../db/index.js';
import { checkSessionLimits, getSystemPrompt, getActiveModality, getSystemConfig, resolveProactiveOffering } from '../../utils/sessionHelpers.js';
import { recordSessionOwnership } from '../../utils/sessionOwnership.js';
import { sanitizeCheckin, buildCheckinBlock, buildMemoryBlock, buildToolGuidanceBlock } from '../../utils/promptContext.js';
import { setSessionCheckin } from '../../db/index.js';
import { requireConsent } from '../../middleware/consent.js';

// ---- OpenAI safety identifier (ai-therapist-63) ----
// OpenAI recommends sending a stable, non-PII `OpenAI-Safety-Identifier` per
// end user so abuse enforcement targets the individual, not our whole API key.
// Logged-in users: sha256 of their user id. Anonymous participants: sha256 of
// a long-lived random participant cookie (NOT the therapy session id, which is
// per-session, and NOT anything identifying).

const PARTICIPANT_COOKIE = 'att_pid';
const PARTICIPANT_COOKIE_MAX_AGE_MS = 400 * 24 * 60 * 60 * 1000; // ~13 months (browser cap)

/** Read the participant cookie without cookie-parser (only one we need). */
function readParticipantCookie(req: Request): string | null {
  const header = req.headers.cookie;
  if (!header) return null;
  for (const part of header.split(';')) {
    const [name, ...rest] = part.trim().split('=');
    if (name === PARTICIPANT_COOKIE) {
      const value = rest.join('=');
      // Defensive: only accept our own UUID format.
      if (/^[0-9a-f-]{36}$/i.test(value)) return value;
    }
  }
  return null;
}

/**
 * Stable hashed identifier for the requesting end user. Sets the participant
 * cookie as a side effect for anonymous requesters that don't have one yet.
 */
function getSafetyIdentifier(req: Request, res: Response, userId: number | string | null): string {
  let seed: string;
  if (userId) {
    seed = `user:${userId}`;
  } else {
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
    seed = `participant:${pid}`;
  }
  return createHash('sha256').update(seed).digest('hex');
}

export default function tokenRoutes(): Router {
  const router = Router();

  // Accepts GET (legacy) and POST (with voice/language settings). Blocked
  // until the participant has accepted the current consent screen — see
  // routes/public/consent.routes.ts.
  router.all('/token', requireConsent, async (req, res) => {
    try {
      const userId = req.session?.userId || null;
      const userRole = req.session?.userRole || null;

      // Rate limiting (researchers exempt).
      const limitCheck = await checkSessionLimits(userId, userRole);
      if (!limitCheck.allowed) {
        console.log(`Session limit exceeded for user ${userId}:`, limitCheck.reason);
        return res.status(429).json({
          error: 'rate_limit_exceeded',
          reason: limitCheck.reason,
          message: limitCheck.message,
          details: {
            limit: limitCheck.reason === 'daily_limit' ? limitCheck.limit : undefined,
            current: limitCheck.reason === 'daily_limit' ? limitCheck.current : undefined,
            cooldown_minutes: limitCheck.reason === 'cooldown' ? limitCheck.cooldown_minutes : undefined,
            minutes_remaining: limitCheck.reason === 'cooldown' ? limitCheck.minutes_remaining : undefined,
          },
        });
      }

      // Idempotency: one active session per user.
      if (userId) {
        const existingSession = await getActiveSessionForUser(userId);
        if (existingSession) {
          console.log(`Returning existing active session for user ${userId}`);
          return res.status(200).json({
            session: { id: existingSession.session_id, exists: true, created_at: existingSession.created_at },
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
          userVoice = userVoice || prefs?.preferred_voice || 'cedar';
          userLanguage = userLanguage || prefs?.preferred_language || 'en';
        } catch (err) {
          console.error('[Token] Failed to load user preferences, using defaults:', err);
        }
      }
      userVoice = userVoice || 'cedar';
      userLanguage = userLanguage || 'en';

      // Persist preferences for next time (fire-and-forget).
      if (userId) {
        updateUserPreferences(userId, userVoice, userLanguage).catch(err =>
          console.error('[Token] Failed to save user preferences:', err));
      }

      const temperature = 0.8;
      const aiModel = await getAiModel();
      const transcriptionModel = await getTranscriptionModel();

      const { toolRegistry, toRealtimeTools } = await import('../../services/toolRegistry.service.js');
      // toRealtimeTools projects to the exact OpenAI shape: registry metadata
      // (channel) sent verbatim is rejected as an unknown parameter and 400s
      // the whole session mint (ai-therapist-124 regression fix).
      const toolDefs = await toolRegistry.getEnabledToolDefinitions();
      const tools = toRealtimeTools(toolDefs);

      // Assemble instructions: base prompt (with active modality + language
      // additions) + when-to-call-tools guidance + returning-participant
      // memory (opt-in, logged-in only) + today's pre-session check-in.
      const checkin = sanitizeCheckin(req.body?.checkin);
      const memoryBlock = await buildMemoryBlock(userId);
      const toolGuidance = buildToolGuidanceBlock(toolDefs.map(t => t.name));
      // Resolved once per session (ai-therapist-74 A/B condition) and persisted
      // below so the steering baked into `instructions` matches what's recorded.
      const proactiveOffering = await resolveProactiveOffering();
      const instructions =
        (await getSystemPrompt(userLanguage, 'realtime', proactiveOffering)) + toolGuidance + memoryBlock + buildCheckinBlock(checkin);
      const activeModality = await getActiveModality();

      const dynamicSessionConfig = JSON.stringify({
        session: {
          type: 'realtime',
          tools,
          tool_choice: 'auto',
          model: aiModel,
          instructions,
          audio: {
            input: {
              transcription: { model: transcriptionModel },
              // Semantic VAD (low eagerness): decide the participant is done by
              // their words, not just silence — far less likely to treat
              // background noise as a turn, and won't cut them off mid-thought.
              turn_detection: { type: 'semantic_vad', eagerness: 'low' },
            },
            output: { voice: userVoice },
          },
        },
      });

      const apiKey = await getOpenAIKey();
      const safetyIdentifier = getSafetyIdentifier(req, res, userId);
      const response = await fetch('https://api.openai.com/v1/realtime/client_secrets', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          'OpenAI-Safety-Identifier': safetyIdentifier,
        },
        body: dynamicSessionConfig,
      });

      if (!response.ok) {
        const errorText = await response.text();
        console.error('OpenAI API error:', response.status, errorText);
        throw new Error(`OpenAI API error: ${response.status} ${errorText}`);
      }

      const data = await response.json();
      if (!data || !data.session || !data.session.id) {
        console.error('Invalid OpenAI response structure:', data);
        throw new Error('Invalid response from OpenAI API - missing session.id');
      }

      const sessionId = data.session.id;
      const username = req.session?.username || null;

      // Model pinning (ai-therapist-61): record the EXACT model strings this
      // session runs on. If OpenAI's response reports a resolved model (e.g. a
      // dated snapshot behind the alias), store that; otherwise the alias we
      // requested. Enables per-session reproducibility even when the alias
      // moves under us mid-study.
      const resolvedModel: string =
        (typeof data.session?.model === 'string' && data.session.model) || aiModel;
      if (resolvedModel !== aiModel) {
        console.log(`[Token] OpenAI resolved model '${aiModel}' -> '${resolvedModel}' for session ${sessionId.substring(0, 12)}...`);
      }

      // Remember ownership in the requester's cookie session so later requests
      // (/logs/batch, session:join, audio upload, end) can be authorized even
      // for anonymous participants. Recorded before the DB insert on purpose:
      // if the insert fails, /logs/batch lazily creates the session and still
      // needs to know this browser owns it.
      recordSessionOwnership(req, sessionId);

      try {
        const { isNonStudyUser } = await import('../../utils/harness.js');
        await createActiveRealtimeSession(sessionId, userId, isNonStudyUser(userRole, req.session?.username));
        console.log(`Therapy session created with user_id: ${userId}`);

        if (checkin) {
          setSessionCheckin(sessionId, checkin).catch(err =>
            console.error('[Token] Failed to store check-in:', err));
        }

        // Durable per-session consent record, linked to the consent this
        // browser session already accepted (requireConsent guarantees it's
        // present and current by this point).
        getSystemConfig()
          .then(cfg => recordConsent({
            sessionId,
            userId,
            consentVersion: req.session!.consentVersion!,
            recordingEnabled: (cfg.features?.session_recording_enabled as boolean | undefined) ?? false,
          }))
          .catch(err => console.error('[Consent] Failed to record per-session consent:', err));

        global.io.to('admin-broadcast').emit('session:created', {
          sessionId,
          userId,
          username,
          status: 'active',
          created_at: new Date(),
        });

        // Schedule auto-termination when a max duration applies (not researchers).
        // Two phases, because the participant's Socket.io channel is unreliable
        // through the tunnel: ending the session server-side is invisible to
        // them, their WebRTC conversation keeps going, and the recording ends
        // up covering only the first N minutes of a much longer conversation.
        // Phase 1 (at the limit) asks the MODEL — over the sideband — to say
        // goodbye and call end_session, which reaches the client on the WebRTC
        // data channel (reliable) and closes the session through the normal
        // user path with the recording intact. Phase 2 (grace elapsed, still
        // active) is the old hard server-side end as a backstop.
        if (limitCheck.limits && limitCheck.limits.max_duration_minutes && !limitCheck.bypass) {
          const maxDurationMinutes = limitCheck.limits.max_duration_minutes;
          const durationMs = maxDurationMinutes * 60 * 1000;
          const graceMs = 75 * 1000;

          const hardEnd = async () => {
            console.log(`⏰ Auto-terminating session ${sessionId} after ${maxDurationMinutes} minutes (+grace)`);
            await updateSessionStatus(sessionId, 'ended', 'system');

            try {
              const { sidebandManager } = await import('../../services/sidebandManager.service.js');
              await sidebandManager.disconnect(sessionId);
            } catch (e) {
              console.error('[Sideband] cleanup on auto-terminate failed:', e);
            }

            // Redact the whole session in one batched job (fire-and-forget).
            import('../../services/sessionRedaction.service.js')
              .then(m => m.redactSession(sessionId))
              .catch(e => console.error('[Redaction] session redaction failed:', e));

            // Finalize the audio recording (buffered PCM → WAV → object storage).
            import('../../services/recorder.service.js')
              .then(m => m.finalize(sessionId))
              .catch(e => console.error('[Recorder] finalize failed:', e));

            // Memory summary + draft SOAP note (fire-and-forget).
            import('../../services/sessionInsights.service.js')
              .then(m => m.generateSessionInsightsAsync(sessionId))
              .catch(e => console.error('[Insights] generation failed:', e));

            // Quality eval (LLM judge) — no-op unless system_config.evals.auto_run_enabled.
            import('../../services/sessionEval.service.js')
              .then(m => m.maybeAutoEvalSession(sessionId))
              .catch(e => console.error('[Evals] auto-eval failed:', e));

            global.io.to(`session:${sessionId}`).emit('session:status', {
              status: 'ended',
              endedBy: 'system',
              reason: 'duration_limit',
              message: `Your session has ended after ${maxDurationMinutes} minutes (maximum session duration).`,
              remoteTermination: true,
            });
            global.io.to('admin-broadcast').emit('session:ended', {
              sessionId,
              endedAt: new Date(),
              endedBy: 'system',
              reason: 'duration_limit',
            });
          };

          // T-60s pacing nudge (ai-therapist-112): the model used to learn
          // about time only at the hard limit (or by calling
          // get_time_remaining), so closings were rushed or cut off. One
          // minute of runway lets it consolidate and land the recap naturally.
          if (durationMs > 90 * 1000) {
            setTimeout(async () => {
              try {
                const current = await getSessionAccessInfo(sessionId);
                if (!current || current.status !== 'active') return;
                const { sidebandManager } = await import('../../services/sidebandManager.service.js');
                await sidebandManager.tryInject(
                  sessionId,
                  'system',
                  '[About one minute remains in this session. Begin wrapping up naturally — consolidate one takeaway, no new topics. If it fits, call display_session_recap now.]',
                  false,
                );
              } catch (err) {
                console.error(`[Token] T-60s wrap-up nudge failed for ${sessionId}:`, err);
              }
            }, durationMs - 60 * 1000);
          }

          setTimeout(async () => {
            try {
              const current = await getSessionAccessInfo(sessionId);
              if (!current || current.status !== 'active') return;

              // Phase 1: tell the model to close out and end the session itself.
              try {
                const { sidebandManager } = await import('../../services/sidebandManager.service.js');
                await sidebandManager.injectMessage(
                  sessionId,
                  'system',
                  'TIME LIMIT REACHED: this session has hit its maximum duration. In your next reply, give a brief, warm closing (2-3 sentences, no new topics), then immediately call the end_session tool.',
                  true,
                );
                console.log(`⏰ Session ${sessionId} hit ${maxDurationMinutes}min limit — asked model to wrap up (${graceMs / 1000}s grace)`);
              } catch (e) {
                console.error('[Sideband] wrap-up injection failed, will hard-end after grace:', e);
              }

              // Phase 2: backstop if the model/client didn't end it in time.
              setTimeout(async () => {
                try {
                  const after = await getSessionAccessInfo(sessionId);
                  if (after && after.status === 'active') await hardEnd();
                } catch (err) {
                  console.error(`Failed to hard-end session ${sessionId}:`, err);
                }
              }, graceMs);
            } catch (err) {
              console.error(`Failed to auto-terminate session ${sessionId}:`, err);
            }
          }, durationMs);

          console.log(`Session ${sessionId} will auto-terminate in ${maxDurationMinutes} minutes (+${graceMs / 1000}s grace)`);
        }

        // Persist the session configuration alongside the session.
        const sessionConfigObj = JSON.parse(dynamicSessionConfig);
        await upsertSessionConfig(sessionId, {
          voice: userVoice,
          modalities: ['text', 'audio'],
          instructions: sessionConfigObj.session?.instructions || null,
          turn_detection: sessionConfigObj.session?.audio?.input?.turn_detection || null,
          tools: sessionConfigObj.session?.tools || null,
          temperature,
          max_response_output_tokens: sessionConfigObj.session?.max_response_output_tokens || 4096,
          language: userLanguage,
          modality: activeModality?.key ?? null,
          ai_model: resolvedModel,
          transcription_model: transcriptionModel,
          proactive_offering: proactiveOffering,
        });
        console.log(`Session configuration created for session: ${sessionId.substring(0, 12)}... (voice: ${userVoice}, language: ${userLanguage})`);
      } catch (dbError) {
        console.error('Failed to create session in database:', dbError);
        // Continue anyway - session will be created by the logs/batch endpoint.
      }

      res.json({ ...data, session_limits: limitCheck.limits || null });
    } catch (error) {
      console.error('Token generation error:', error);
      res.status(500).json({ error: 'Failed to generate token' });
    }
  });

  return router;
}
