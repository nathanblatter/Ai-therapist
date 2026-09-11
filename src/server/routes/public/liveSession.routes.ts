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
} from '../../db/index.js';
import {
  checkSessionLimits,
  getSystemPrompt,
  getActiveModality,
  getSystemConfig,
  resolveProactiveOffering,
  getLanguageName,
} from '../../utils/sessionHelpers.js';
import { recordSessionOwnership } from '../../utils/sessionOwnership.js';
import { sanitizeCheckin, buildCheckinBlock, buildMemoryBlock, buildToolGuidanceBlock } from '../../utils/promptContext.js';
import { requireConsent } from '../../middleware/consent.js';
import { requireOutsideQuietHours } from '../../middleware/quietHours.js';
import { requireActiveStudyStatus } from '../../middleware/studyStatus.js';
import { broadcastAdminEvent } from '../../utils/adminBroadcast.js';
import { scheduleAutoTermination } from '../../utils/sessionAutoTerminate.js';
import {
  buildLiveSessionConfig,
  isLiveModel,
  resolveLiveVoice,
  LIVE_DEFAULT_BACKEND_MODEL,
} from '../../utils/liveSessionConfig.js';
import { sidebandManager } from '../../services/sidebandManager.service.js';


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
          console.error(
            `[Live] system_config.ai_model is '${aiModel}', which is not a GPT-Live model. ` +
            'Voice sessions cannot start until it is set to a gpt-live-* id.',
          );
          return res.status(409).json({
            error: 'live_not_active',
            message: 'The voice backend is misconfigured. Please contact the research team.',
          });
        }

        const userId = req.session?.userId || null;
        const userRole = req.session?.userRole || null;

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

        // Idempotency: one active session per user. Checked before the OpenAI
        // call so a double-click can't bill two session initializations.
        if (userId) {
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
            console.error('[Live] Failed to load user preferences, using defaults:', err);
          }
        }
        userVoice = resolveLiveVoice(userVoice);
        userLanguage = userLanguage || 'en';

        if (userId) {
          updateUserPreferences(userId, userVoice, userLanguage).catch(err =>
            console.error('[Live] Failed to save user preferences:', err));
        }

        // Assemble the clinical prompt exactly as the Realtime path does, so the
        // two backends run identical therapeutic content and remain comparable
        // as study conditions. buildLiveSessionConfig routes it to the DELEGATED
        // BACKEND rather than the voice model; see liveSessionConfig.ts.
        const { toolRegistry } = await import('../../services/toolRegistry.service.js');
        const toolDefs = await toolRegistry.getEnabledToolDefinitions();
        const checkin = sanitizeCheckin(req.body?.checkin);
        const memoryBlock = await buildMemoryBlock(userId);
        const toolGuidance = buildToolGuidanceBlock(toolDefs.map(t => t.name));
        const proactiveOffering = await resolveProactiveOffering();
        const systemPrompt =
          (await getSystemPrompt(userLanguage, 'realtime', proactiveOffering)) +
          toolGuidance + memoryBlock + buildCheckinBlock(checkin);
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
        const isDemoSession =
          isNonStudyUser(userRole, req.session?.username) || req.session?.isSandbox === true;

        // RECOVERY START. Set when the previous voice session was terminated by
        // OpenAI's content filter (session.closed reason 'content') and the
        // client is bringing the participant straight back rather than leaving
        // them alone. See buildLiveRecoveryInstructions for why the prompt is
        // narrower and why NO prior conversation is replayed.
        const isRecovery = req.body?.recovery === true;
        const crisisContact = (systemConfig.crisis_contact ?? {}) as { phone?: string; text?: string };
        const crisisLine = [
          crisisContact.phone ? `${crisisContact.phone}` : '988',
          crisisContact.text ? `or text ${crisisContact.text}` : '',
        ].filter(Boolean).join(' ');

        if (isRecovery) {
          console.warn(
            `[Live] RECOVERY session start for user ${userId ?? 'anonymous'} — the previous voice ` +
            'session was terminated by the content filter. Resuming in crisis-support mode.',
          );
        }

        const sessionConfig = buildLiveSessionConfig({
          model: aiModel,
          voice: userVoice,
          languageName: await getLanguageName(userLanguage),
          systemPrompt,
          toolDefs,
          backendModel,
          storable: isDemoSession,
          recovery: isRecovery ? { crisisLine } : undefined,
        });

        const apiKey = await getOpenAIKey();
        const safetyIdentifier = getSafetyIdentifier(req, res, userId);

        const response = await fetch('https://api.openai.com/v1/live/sessions', {
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
        });

        if (!response.ok) {
          const errorText = await response.text();
          console.error('[Live] OpenAI session creation failed:', response.status, errorText);

          const { isIdentifierBlockedError } = await import('../../utils/safetyIdentifier.js');
          if (isIdentifierBlockedError(null, errorText)) {
            console.error(
              `[Live] BLOCKED SAFETY IDENTIFIER for user ${userId ?? 'anonymous'} — ` +
              'participant cannot start sessions; study team must re-enroll or contact OpenAI.',
            );
            return res.status(403).json({ error: 'identifier_blocked' });
          }
          throw new Error(`OpenAI Live API error: ${response.status} ${errorText}`);
        }

        const data = await response.json();
        const liveSessionId: string | undefined = data?.session?.id;
        const sdpAnswer: string | undefined = data?.transport?.sdp;
        if (!liveSessionId || !sdpAnswer) {
          console.error('[Live] Invalid session response structure:', data);
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

          if (checkin) {
            setSessionCheckin(sessionId, checkin).catch(err =>
              console.error('[Live] Failed to store check-in:', err));
          }

          recordConsent({
            sessionId,
            userId,
            consentVersion: req.session!.consentVersion!,
            recordingEnabled: (systemConfig.features?.session_recording_enabled as boolean | undefined) ?? false,
          }).catch(err => console.error('[Consent] Failed to record per-session consent:', err));

          void broadcastAdminEvent(global.io, 'session:created', {
            sessionId, userId, username, status: 'active', created_at: new Date(),
          }, userId, 'summary');

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
          });
        } catch (dbError) {
          console.error('[Live] Failed to create session in database:', dbError);
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
        const sidebandEnabled = process.env.SIDEBAND_ENABLED !== 'false';
        if (!sidebandEnabled) {
          // Explicitly loud. This kill switch now disables crisis detection on
          // the voice path, which it did not under Realtime.
          console.warn(
            '[Live] SIDEBAND_ENABLED=false — starting a voice session with NO crisis detection. ' +
            'This switch is far more dangerous under GPT-Live than it was under Realtime.',
          );
        } else {
          try {
            await sidebandManager.connectAndWait(sessionId, liveSessionId, apiKey, {
              model: aiModel, backendModel,
            });
          } catch (err) {
            console.error(
              `[Live] Sideband attach FAILED for ${sessionId} — refusing to start an unmonitored ` +
              'voice session:', err instanceof Error ? err.message : err,
            );

            // Hang up the OpenAI side so the participant's browser cannot keep
            // talking to a session we are not watching, and so we stop paying
            // for it.
            await fetch(
              `https://api.openai.com/v1/live/sessions/${encodeURIComponent(liveSessionId)}/hangup`,
              { method: 'POST', headers: { Authorization: `Bearer ${apiKey}` } },
            ).catch((e: unknown) => console.error('[Live] hangup after failed attach also failed:', e));

            await updateSessionStatus(sessionId, 'ended', 'system')
              .catch((e: unknown) => console.error('[Live] Failed to mark unmonitored session ended:', e));

            return res.status(503).json({
              error: 'monitoring_unavailable',
              message:
                'We could not start your session right now. Please try again in a moment.',
            });
          }
        }

        if (limitCheck.limits?.max_duration_minutes && !limitCheck.bypass) {
          scheduleAutoTermination({
            sessionId,
            maxDurationMinutes: limitCheck.limits.max_duration_minutes,
            steer: (id, text, respond) => sidebandManager.tryInject(id, 'system', text, respond),
            teardown: id => sidebandManager.disconnect(id),
          });
        }

        res.status(201).json({
          session_id: sessionId,
          sdp: sdpAnswer,
          voice: userVoice,
          language: userLanguage,
          session_limits: limitCheck.limits || null,
        });
      } catch (error) {
        console.error('[Live] Session creation error:', error);
        res.status(500).json({ error: 'Failed to create Live session' });
      }
    },
  );

  return router;
}
