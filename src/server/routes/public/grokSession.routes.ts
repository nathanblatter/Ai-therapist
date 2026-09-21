// Grok Voice session creation (docs/grok-voice.md). The Grok counterpart of
// liveSession.routes.ts, and deliberately a near-mirror of it: the same gates
// in the same order, the same clinical prompt assembly, the same DB rows. What
// differs is the transport handshake.
//
// There is no SDP exchange. The browser POSTs here first; the route runs every
// gate (consent, quiet hours, study status, rate limits, one-active-session),
// creates the therapy session row, assembles the session config, and registers
// it with the proxy manager as PENDING. Only when the browser then opens
// wss://<origin>/api/grok/voice/<session_id> does the server dial xAI. A start
// that dies client-side (mic permission denied, tab closed) therefore never
// opens a billable upstream session — the pending registration simply expires
// and the row is ended.
//
// Nothing about xAI reaches the browser: no key, no endpoint, no ephemeral
// token. The response is the session id, the resolved voice/language and the
// session limits — the same shape POST /api/live/session returns minus `sdp`.

import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import { getXaiKey, hasXaiKey } from '../../config/secrets.js';
import {
  getActiveSessionForUser,
  upsertSessionConfig,
  getAiModel,
  getUserPreferences,
  updateUserPreferences,
  createActiveRealtimeSession,
  recordConsent,
  setSessionCheckin,
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
  buildGrokSessionConfig,
  buildGrokOpeningPrompt,
  isGrokVoiceModel,
  resolveGrokVoice,
  type CrisisContactLike,
} from '../../utils/grokVoiceConfig.js';
import { grokVoiceManager } from '../../services/grokVoiceManager.service.js';
import { GROK_SAMPLE_RATE, GROK_VOICE_WS_PATH } from '../../../shared/grokVoiceProtocol.js';

export default function grokSessionRoutes(): Router {
  const router = Router();

  /**
   * POST /api/grok/session — create a Grok Voice therapy session.
   *
   * Body: { voice?, language?, checkin? }
   * Returns: { session_id, ws_path, sample_rate, voice, language, session_limits }
   */
  router.post(
    '/api/grok/session',
    requireConsent,
    requireOutsideQuietHours,
    requireActiveStudyStatus,
    async (req, res) => {
      try {
        // The admin switch. ai_model names the voice backend; anything else
        // means this route is not the active one and the client should not be
        // here (it asks /api/config/ai-model first, but the config can change
        // between page load and start).
        const aiModel = await getAiModel();
        if (!isGrokVoiceModel(aiModel)) {
          return res.status(409).json({
            error: 'grok_not_active',
            message: 'The voice backend changed. Please refresh the page and try again.',
          });
        }
        if (!hasXaiKey()) {
          console.error(
            `[Grok] system_config.ai_model is '${aiModel}' but XAI_API_KEY is not set. ` +
            'Voice sessions cannot start until the key is configured or the model is switched back.',
          );
          return res.status(409).json({
            error: 'grok_not_configured',
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

        // One active session per user (a double-click must not create two).
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
            console.error('[Grok] Failed to load user preferences, using defaults:', err);
          }
        }
        userVoice = resolveGrokVoice(userVoice);
        userLanguage = userLanguage || 'en';

        if (userId) {
          updateUserPreferences(userId, userVoice, userLanguage).catch(err =>
            console.error('[Grok] Failed to save user preferences:', err));
        }

        // The clinical prompt, assembled exactly as the GPT-Live route does so
        // the two backends are comparable study conditions. Under Grok it goes
        // to the ONE model rather than a delegated backend.
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

        const { isNonStudyUser } = await import('../../utils/harness.js');
        const isDemoSession =
          isNonStudyUser(userRole, req.session?.username) || req.session?.isSandbox === true;

        const sessionConfig = buildGrokSessionConfig({
          model: aiModel,
          voice: userVoice,
          language: userLanguage,
          languageName: await getLanguageName(userLanguage),
          systemPrompt,
          toolDefs,
        });

        // xAI issues no session id before the socket opens, and we need one
        // before the browser can connect. Prefixed so the two namespaces
        // (live_… from OpenAI, grok_… from us) never collide or get confused
        // by the re-attach sweep.
        const sessionId = `grok_${randomUUID()}`;
        const username = req.session?.username || null;
        recordSessionOwnership(req, sessionId);

        try {
          await createActiveRealtimeSession(sessionId, userId, isDemoSession);

          if (checkin) {
            setSessionCheckin(sessionId, checkin).catch(err =>
              console.error('[Grok] Failed to store check-in:', err));
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
            instructions: sessionConfig.instructions as string,
            turn_detection: { type: 'server_vad' },
            tools: toolDefs,
            language: userLanguage,
            modality: activeModality?.key ?? null,
            // Pinned to the alias now; the proxy overwrites it with the resolved
            // model id from session.created (ai-therapist-61).
            ai_model: aiModel,
            live_backend_model: null,
            transcription_model: null, // Grok transcribes internally.
            proactive_offering: proactiveOffering,
          });
        } catch (dbError) {
          // Unlike the GPT-Live route nothing is billing yet, so a DB failure
          // here can and should fail the start.
          console.error('[Grok] Failed to create session in database:', dbError);
          return res.status(500).json({ error: 'Failed to create session' });
        }

        grokVoiceManager.registerPending(sessionId, {
          model: aiModel,
          apiKey: await getXaiKey(),
          sessionConfig,
          openingPrompt: buildGrokOpeningPrompt(
            userLanguage,
            systemConfig.crisis_contact as CrisisContactLike | undefined,
          ),
        });

        if (limitCheck.limits?.max_duration_minutes && !limitCheck.bypass) {
          scheduleAutoTermination({
            sessionId,
            maxDurationMinutes: limitCheck.limits.max_duration_minutes,
            steer: (id, text, respond) => grokVoiceManager.tryInject(id, 'system', text, respond),
            teardown: id => grokVoiceManager.disconnect(id),
          });
        }

        res.status(201).json({
          session_id: sessionId,
          ws_path: `${GROK_VOICE_WS_PATH}${encodeURIComponent(sessionId)}`,
          sample_rate: GROK_SAMPLE_RATE,
          voice: userVoice,
          language: userLanguage,
          session_limits: limitCheck.limits || null,
        });
      } catch (error) {
        console.error('[Grok] Session creation error:', error);
        res.status(500).json({ error: 'Failed to create Grok session' });
      }
    },
  );

  return router;
}
