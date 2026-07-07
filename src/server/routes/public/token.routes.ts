// Realtime session token endpoint. Mints an OpenAI Realtime client secret with
// the user's voice/language/prompt, creates the backing therapy session, and
// schedules auto-termination when a max duration is configured. Anonymous users
// are allowed; rate limits are enforced via checkSessionLimits.
import { Router } from 'express';
import { getOpenAIKey } from '../../config/secrets.js';
import {
  getActiveSessionForUser,
  updateSessionStatus,
  upsertSessionConfig,
  getAiModel,
  getUserPreferences,
  updateUserPreferences,
  getSessionAccessInfo,
  createActiveRealtimeSession,
} from '../../db/index.js';
import { checkSessionLimits, getSystemPrompt } from '../../utils/sessionHelpers.js';
import { recordSessionOwnership } from '../../utils/sessionOwnership.js';

export default function tokenRoutes(): Router {
  const router = Router();

  // Accepts GET (legacy) and POST (with voice/language settings).
  router.all('/token', async (req, res) => {
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

      const { toolRegistry } = await import('../../services/toolRegistry.service.js');
      const tools = toolRegistry.getAllToolDefinitions();

      const dynamicSessionConfig = JSON.stringify({
        session: {
          type: 'realtime',
          tools,
          tool_choice: 'auto',
          model: aiModel,
          instructions: await getSystemPrompt(userLanguage, 'realtime'),
          audio: {
            input: { transcription: { model: 'whisper-1' } },
            output: { voice: userVoice },
          },
        },
      });

      const apiKey = await getOpenAIKey();
      const response = await fetch('https://api.openai.com/v1/realtime/client_secrets', {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
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

      // Remember ownership in the requester's cookie session so later requests
      // (/logs/batch, session:join, audio upload, end) can be authorized even
      // for anonymous participants. Recorded before the DB insert on purpose:
      // if the insert fails, /logs/batch lazily creates the session and still
      // needs to know this browser owns it.
      recordSessionOwnership(req, sessionId);

      try {
        await createActiveRealtimeSession(sessionId, userId);
        console.log(`Therapy session created with user_id: ${userId}`);

        global.io.to('admin-broadcast').emit('session:created', {
          sessionId,
          userId,
          username,
          status: 'active',
          created_at: new Date(),
        });

        // Schedule auto-termination when a max duration applies (not researchers).
        if (limitCheck.limits && limitCheck.limits.max_duration_minutes && !limitCheck.bypass) {
          const maxDurationMinutes = limitCheck.limits.max_duration_minutes;
          const durationMs = maxDurationMinutes * 60 * 1000;
          setTimeout(async () => {
            try {
              const current = await getSessionAccessInfo(sessionId);
              if (current && current.status === 'active') {
                console.log(`⏰ Auto-terminating session ${sessionId} after ${maxDurationMinutes} minutes`);
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
              }
            } catch (err) {
              console.error(`Failed to auto-terminate session ${sessionId}:`, err);
            }
          }, durationMs);

          console.log(`Session ${sessionId} will auto-terminate in ${maxDurationMinutes} minutes`);
        }

        // Persist the session configuration alongside the session.
        const sessionConfigObj = JSON.parse(dynamicSessionConfig);
        await upsertSessionConfig(sessionId, {
          voice: userVoice,
          modalities: ['text', 'audio'],
          instructions: sessionConfigObj.session?.instructions || null,
          turn_detection: sessionConfigObj.session?.turn_detection || null,
          tools: sessionConfigObj.session?.tools || null,
          temperature,
          max_response_output_tokens: sessionConfigObj.session?.max_response_output_tokens || 4096,
          language: userLanguage,
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
