// Public session management API: create/list/view/end a participant's own
// therapy sessions, plus register-call which attaches the OpenAI realtime call
// id. Session owners see their own unredacted content. Mutations reuse
// db/sessions.queries.ts + db/messages.queries.ts.
import { Router, json } from 'express';
import { requireAuth } from '../../middleware/auth.js';
import { appendChunk, isFinalized } from '../../services/recorder.service.js';
import {
  createSession,
  getSession,
  getUserSessions,
  getSessionMessages,
  getSessionConfig,
  updateSessionStatus,
  getSessionAccessInfo,
  setSessionCallId,
} from '../../db/index.js';
import { generateSessionNameAsync } from '../../services/sessionName.service.js';
import { canAccessSession, recordSessionOwnership } from '../../utils/sessionOwnership.js';

export default function sessionsRoutes(): Router {
  const router = Router();

  // POST /api/sessions/:sessionId/audio - ingest mixed (mic+assistant) PCM16
  // audio over HTTP. The participant browser's Socket.io connection is
  // unreliable through the tunnel, but HTTP works, so audio is uploaded here:
  // each batch is appended to the session recording and relayed live to any
  // admin listening (over the admin socket, which is reliable). Uses its own
  // larger body limit since batches are bigger than the default 100kb.
  router.post('/api/sessions/:sessionId/audio', json({ limit: '8mb' }), async (req, res) => {
    const { sessionId } = req.params;
    const { chunks, sampleRate } = req.body as { chunks?: string[]; sampleRate?: number };
    if (!sessionId || !Array.isArray(chunks) || typeof sampleRate !== 'number') {
      return res.status(400).json({ error: 'chunks[] and sampleRate required' });
    }
    // Only the session's owner may feed audio into its recording. Cookie
    // ownership avoids a DB hit on this hot path; logged-in owners whose
    // cookie was lost fall back to the user_id check.
    if (!(req.session?.ownedSessions ?? []).includes(sessionId)) {
      const access = await getSessionAccessInfo(sessionId);
      if (!access || !canAccessSession(req, access, sessionId)) {
        return res.status(403).json({ error: 'Access denied' });
      }
    }
    // Recording already closed (session ended / auto-terminated): tell the
    // client to stop its uploader instead of silently discarding forever.
    if (isFinalized(sessionId)) return res.sendStatus(410);
    for (const pcm of chunks) {
      if (typeof pcm !== 'string' || !pcm) continue;
      try {
        appendChunk(sessionId, pcm, sampleRate);
      } catch {
        /* best-effort recording */
      }
      global.io?.to(`audio:${sessionId}`).emit('audio:chunk', { sessionId, pcm, sampleRate });
    }
    res.sendStatus(204);
  });

  // POST /api/sessions/:sessionId/scale-response - store a completed screener
  // (PHQ-2/GAD-2) submitted from the administer_scale overlay. Owner-gated.
  router.post('/api/sessions/:sessionId/scale-response', async (req, res) => {
    const { sessionId } = req.params;
    const { scale, answers } = req.body as { scale?: string; answers?: number[] };

    const { SCALES } = await import('../../utils/scales.js');
    const def = scale ? SCALES[scale] : undefined;
    if (!def || !Array.isArray(answers) || answers.length !== def.items.length ||
        !answers.every(a => Number.isInteger(a) && a >= 0 && a <= 3)) {
      return res.status(400).json({ error: 'valid scale and answers[] required' });
    }

    try {
      const session = await getSessionAccessInfo(sessionId);
      if (!session) return res.status(404).json({ error: 'Session not found' });
      if (!canAccessSession(req, session, sessionId)) {
        return res.status(403).json({ error: 'Access denied' });
      }

      const score = answers.reduce((a, b) => a + b, 0);
      const { insertScaleResponse } = await import('../../db/index.js');
      await insertScaleResponse(sessionId, def.id, answers, score);

      global.io?.to('admin-broadcast').emit('session:scale-completed', {
        sessionId, scale: def.id, score, maxScore: def.max_score, completedAt: new Date(),
      });

      res.json({ success: true, scale: def.id, score, max_score: def.max_score });
    } catch (err) {
      console.error('Failed to store scale response:', err);
      res.status(500).json({ error: 'Failed to store scale response' });
    }
  });

  // GET /api/scales/:scaleId - screener definition for the client form
  router.get('/api/scales/:scaleId', async (req, res) => {
    const { SCALES } = await import('../../utils/scales.js');
    const def = SCALES[req.params.scaleId];
    if (!def) return res.status(404).json({ error: 'Unknown scale' });
    res.json(def);
  });

  // POST /api/sessions/:sessionId/register-call - attach an OpenAI call id
  router.post('/api/sessions/:sessionId/register-call', async (req, res) => {
    const { sessionId } = req.params;
    const { call_id, ephemeral_key } = req.body;

    if (!call_id) {
      return res.status(400).json({ error: 'call_id is required' });
    }

    try {
      const session = await getSessionAccessInfo(sessionId);
      if (!session) {
        return res.status(404).json({ error: 'Session not found' });
      }
      if (!canAccessSession(req, session, sessionId)) {
        return res.status(403).json({ error: 'Access denied' });
      }
      if (session.status !== 'active') {
        return res.status(400).json({ error: 'Session is not active' });
      }

      await setSessionCallId(sessionId, call_id);

      // Attach the server-side sideband WebSocket to this in-progress WebRTC call
      // so the backend can run tools / monitor / steer the session. Fire-and-forget
      // and non-fatal: the user's call continues even if the sideband fails to
      // attach (errors are logged to the session via sidebandManager).
      // Kill switch: set SIDEBAND_ENABLED=false to stop attaching without a redeploy.
      const sidebandEnabled = process.env.SIDEBAND_ENABLED !== 'false';
      const { sidebandManager } = await import('../../services/sidebandManager.service.js');
      // Auth (ai-therapist-62): per OpenAI's server-side-controls docs the
      // sideband WS authenticates with the STANDARD API key, which never
      // expires — so late reconnects keep working (the per-session ephemeral
      // key used previously expires minutes into the session). The earlier
      // "standard key returns 404 call_id_not_found" observation is now
      // believed to have been the attach-before-call-registered race, which
      // connect() retries around. If the standard key is genuinely rejected
      // live, connect()'s unexpected-response handler logs the HTTP status +
      // body, and the client-supplied ephemeral key is used as a fallback.
      if (!sidebandEnabled) {
        console.log('[Sideband] Disabled via SIDEBAND_ENABLED=false; call_id recorded only.');
      } else {
        const { getOpenAIKey } = await import('../../config/secrets.js');
        const apiKey = await getOpenAIKey();
        const fallbackKey = typeof ephemeral_key === 'string' && ephemeral_key ? ephemeral_key : undefined;
        if (!apiKey) {
          console.error('[Sideband] No standard OpenAI key available; skipping sideband attach.');
        } else {
          sidebandManager.connect(sessionId, call_id, apiKey, 0, fallbackKey).catch(err => {
            console.warn(`[Sideband] connect() failed for ${sessionId}:`, err instanceof Error ? err.message : err);
          });
        }
      }

      res.json({ success: true, message: 'Call registered', sessionId, call_id });
    } catch (error: unknown) {
      console.error('Failed to establish sideband connection:', error);
      res.status(500).json({
        error: 'Failed to establish sideband connection',
        details: error instanceof Error ? error.message : String(error),
      });
    }
  });

  // POST /api/sessions/create - create a new therapy session
  router.post('/api/sessions/create', async (req, res) => {
    try {
      const userId = req.session?.userId || null;
      const { sessionName } = req.body;
      const session = await createSession(userId, sessionName);
      recordSessionOwnership(req, session.session_id);
      res.json(session);
    } catch (err) {
      console.error('Failed to create session:', err);
      res.status(500).json({ error: 'Failed to create session' });
    }
  });

  // GET /api/sessions - list the authenticated user's sessions
  router.get('/api/sessions', requireAuth, async (req, res) => {
    try {
      const sessions = await getUserSessions(req.session.userId!);
      res.json(sessions);
    } catch (err) {
      console.error('Failed to fetch sessions:', err);
      res.status(500).json({ error: 'Failed to fetch sessions' });
    }
  });

  // GET /api/sessions/:sessionId - full session detail (owner only)
  router.get('/api/sessions/:sessionId', async (req, res) => {
    try {
      const { sessionId } = req.params;
      const session = await getSession(sessionId);
      if (!session) {
        return res.status(404).json({ error: 'Session not found' });
      }
      if (!canAccessSession(req, session, sessionId)) {
        return res.status(403).json({ error: 'Access denied' });
      }

      // Owners see their own unredacted content.
      const messages = await getSessionMessages(sessionId, false);
      const config = await getSessionConfig(sessionId);

      res.json({ session, messages, config });
    } catch (err) {
      console.error('Failed to fetch session details:', err);
      res.status(500).json({ error: 'Failed to fetch session details' });
    }
  });

  // POST /api/sessions/:sessionId/end - end a session (triggers auto-naming)
  router.post('/api/sessions/:sessionId/end', async (req, res) => {
    try {
      const { sessionId } = req.params;
      const session = await getSession(sessionId);
      if (!session) {
        return res.status(404).json({ error: 'Session not found' });
      }
      if (!canAccessSession(req, session, sessionId)) {
        return res.status(403).json({ error: 'Access denied' });
      }

      // Idempotent end.
      if (session.status === 'ended') {
        console.log(`Session ${sessionId} already ended, returning existing data (idempotent)`);
        return res.status(200).json({ ...session, alreadyEnded: true, message: 'Session was already ended' });
      }

      const updatedSession = await updateSessionStatus(sessionId, 'ended', 'user');

      // Cleanly tear down the sideband observer so it doesn't 1006 and churn
      // through reconnect attempts after the call ends.
      try {
        const { sidebandManager } = await import('../../services/sidebandManager.service.js');
        await sidebandManager.disconnect(sessionId);
      } catch (e) {
        console.error('[Sideband] cleanup on session end failed:', e);
      }

      // Redact the whole session in one batched job (fire-and-forget).
      import('../../services/sessionRedaction.service.js')
        .then(m => m.redactSession(sessionId))
        .catch(e => console.error('[Redaction] session redaction failed:', e));

      // Finalize the audio recording (wrap buffered PCM → WAV → object storage).
      import('../../services/recorder.service.js')
        .then(m => m.finalize(sessionId))
        .catch(e => console.error('[Recorder] finalize failed:', e));

      // Memory summary + draft SOAP note (fire-and-forget).
      import('../../services/sessionInsights.service.js')
        .then(m => m.generateSessionInsightsAsync(sessionId))
        .catch(e => console.error('[Insights] generation failed:', e));

      global.io.to('admin-broadcast').emit('session:ended', { sessionId, endedAt: new Date(), endedBy: 'user' });
      global.io.to(`session:${sessionId}`).emit('session:status', { status: 'ended', endedBy: 'user' });

      // Auto-name from the conversation in the background.
      generateSessionNameAsync(sessionId);

      res.json({ ...updatedSession, message: 'Session ended successfully' });
    } catch (err) {
      console.error('Failed to end session:', err);
      res.status(500).json({ error: 'Failed to end session' });
    }
  });

  return router;
}
