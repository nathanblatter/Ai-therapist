// Public session management API: create/list/view/end a participant's own
// therapy sessions, plus register-call which attaches the OpenAI realtime call
// id. Session owners see their own unredacted content. Mutations reuse
// db/sessions.queries.ts + db/messages.queries.ts.
import { Router, json } from 'express';
import { requireAuth } from '../../middleware/auth.js';
import { appendChunk, isFinalized } from '../../services/recorder.service.js';
import { noteSessionActivity } from '../../services/sessionLifecycle.service.js';
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
import { getSystemConfig } from '../../utils/sessionHelpers.js';
import { requireOutsideQuietHours } from '../../middleware/quietHours.js';
import { requireActiveStudyStatus } from '../../middleware/studyStatus.js';
import { broadcastAdminEventForSession } from '../../utils/adminBroadcast.js';

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
    const { chunks, sampleRate, track } = req.body as {
      chunks?: string[];
      sampleRate?: number;
      track?: string;
    };
    if (!sessionId || !Array.isArray(chunks) || typeof sampleRate !== 'number') {
      return res.status(400).json({ error: 'chunks[] and sampleRate required' });
    }
    // Track tag (086): 'participant' = pre-gain mic-only tap for prosody
    // research; untagged/legacy clients and the redteam harness are 'mixed'.
    if (track !== undefined && track !== 'mixed' && track !== 'participant') {
      return res.status(400).json({ error: 'invalid track' });
    }
    const recordingTrack = track === 'participant' ? 'participant' as const : 'mixed' as const;
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

    // A batch landing at all means the participant is still here — cancels
    // any pending abandon-check scheduled from an earlier socket disconnect.
    noteSessionActivity(sessionId);

    // Defense in depth: the client already gates capture on this flag, but
    // don't persist audio server-side if an admin has since disabled
    // recording (config is cached ~10min, so this can lag a live toggle by
    // that long — acceptable given the client-side gate is the primary control).
    const config = await getSystemConfig();
    const recordingEnabled = (config.features?.session_recording_enabled as boolean | undefined) ?? false;
    if (!recordingEnabled) return res.sendStatus(204);

    // Per-participant consent (migrations 039/086): the session owner's LATEST
    // consent snapshot must allow recording, regardless of the global flag.
    // Applies to BOTH tracks (mixed and participant). Sessions without a
    // linked user (demo/anonymous) keep current behavior. 204, not an error —
    // the client uploader should stop caring, not surface a failure.
    const { isRecordingConsentedForSession } = await import('../../db/index.js');
    if (!(await isRecordingConsentedForSession(sessionId))) return res.sendStatus(204);

    for (const pcm of chunks) {
      if (typeof pcm !== 'string' || !pcm) continue;
      try {
        appendChunk(sessionId, pcm, sampleRate, recordingTrack);
      } catch {
        /* best-effort recording */
      }
      // Live admin relay stays mixed-only: admins already hear the full mix,
      // and relaying the mic tap too would double the participant's audio.
      if (recordingTrack === 'mixed') {
        global.io?.to(`audio:${sessionId}`).emit('audio:chunk', { sessionId, pcm, sampleRate });
      }
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

      // Weekly cadence gate (IRB consent form: each screener "no more than
      // once per week"). Only enforceable for sessions linked to a user —
      // anonymous/demo sessions have no cross-session identity to window on.
      // The administer_scale tool applies the same rule pre-overlay, so a
      // participant normally never reaches this; it is the hard backstop at
      // persistence. Structured 409 so callers can distinguish it from errors.
      if (typeof session.user_id === 'number') {
        const { getUserLatestScaleScore } = await import('../../db/index.js');
        const { SCALE_MIN_INTERVAL_DAYS, daysSinceScaleAdministered } = await import('../../utils/scales.js');
        const last = await getUserLatestScaleScore(session.user_id, def.id);
        if (last && daysSinceScaleAdministered(last.created_at) < SCALE_MIN_INTERVAL_DAYS) {
          return res.status(409).json({
            error: 'scale_recently_administered',
            scale: def.id,
            last_administered_at: last.created_at,
            message: `This check-in was already completed within the last ${SCALE_MIN_INTERVAL_DAYS} days; it can be taken at most once per week.`,
          });
        }
      }

      const score = answers.reduce((a, b) => a + b, 0);
      const { insertScaleResponse } = await import('../../db/index.js');
      await insertScaleResponse(sessionId, def.id, answers, score);

      if (global.io) void broadcastAdminEventForSession(global.io, 'session:scale-completed', {
        sessionId, scale: def.id, score, maxScore: def.max_score, completedAt: new Date(),
      }, sessionId);

      // Tell the live model directly over the sideband (ai-therapist-112) —
      // previously the model only learned the score if the participant's
      // browser managed to inject an invisible message over its data channel.
      // The client falls back to that old path only when injected=false.
      const { sidebandManager } = await import('../../services/sidebandManager.service.js');
      const injected = await sidebandManager.tryInject(
        sessionId,
        'system',
        `[${def.name} completed] Score ${score}/${def.max_score}. Item answers: ${answers.join(', ')}. ` +
        `Respond supportively and naturally — do not read the score out as a verdict or diagnosis.`,
        true,
      );

      res.json({ success: true, scale: def.id, score, max_score: def.max_score, injected });
    } catch (err) {
      console.error('Failed to store scale response:', err);
      res.status(500).json({ error: 'Failed to store scale response' });
    }
  });

  // POST /api/sessions/:sessionId/worksheet-response - store the participant's
  // completed answers for a personalized worksheet created by
  // create_custom_worksheet (ai-therapist-73). Owner-gated. The client renders
  // straight from the model's function-call args (same pattern as the other
  // overlay tools) and never sees the server-generated instance_id, so this
  // resolves the most recent draft instance for the session — see
  // getLatestDraftWorksheetInstance.
  router.post('/api/sessions/:sessionId/worksheet-response', async (req, res) => {
    const { sessionId } = req.params;
    const { responses, summary } = req.body as { responses?: Record<string, string>; summary?: string };

    if (!responses || typeof responses !== 'object') {
      return res.status(400).json({ error: 'responses{} required' });
    }

    try {
      const session = await getSessionAccessInfo(sessionId);
      if (!session) return res.status(404).json({ error: 'Session not found' });
      if (!canAccessSession(req, session, sessionId)) {
        return res.status(403).json({ error: 'Access denied' });
      }

      const { getLatestDraftWorksheetInstance, completeWorksheetInstance } = await import('../../db/index.js');
      const draft = await getLatestDraftWorksheetInstance(sessionId);
      if (!draft) return res.status(404).json({ error: 'No open worksheet instance for this session' });

      await completeWorksheetInstance(draft.instance_id, sessionId, responses);

      if (global.io) void broadcastAdminEventForSession(global.io, 'session:worksheet-completed', {
        sessionId, instanceId: draft.instance_id, completedAt: new Date(),
      }, sessionId);

      // Inform the live model server-side (ai-therapist-112). The client
      // composes `summary` with the worksheet's section labels (it renders
      // from the model's own function-call args, which never reach this
      // route); text length is capped and it lands as a system item in the
      // participant's OWN session, same trust level as their data channel.
      let injected = false;
      if (typeof summary === 'string' && summary.trim()) {
        const { sidebandManager } = await import('../../services/sidebandManager.service.js');
        injected = await sidebandManager.tryInject(sessionId, 'system', summary.trim().slice(0, 4000), true);
      }

      res.json({ success: true, instance_id: draft.instance_id, injected });
    } catch (err) {
      console.error('Failed to store worksheet response:', err);
      res.status(500).json({ error: 'Failed to store worksheet response' });
    }
  });

  // POST /api/sessions/:sessionId/tool-event - participant-side tool/overlay
  // outcomes (ai-therapist-112): exercise finished or dismissed, thought
  // record / values sort / fear ladder completed, journal kept private. The
  // server logs the event and informs the LIVE model over the sideband; the
  // client only falls back to its old data-channel invisible message when
  // injected=false (no sideband — e.g. chat sessions). Owner-gated.
  router.post('/api/sessions/:sessionId/tool-event', async (req, res) => {
    const { sessionId } = req.params;
    const { kind, summary } = req.body as { kind?: string; summary?: string };

    const KINDS = new Set([
      'exercise_completed', 'exercise_dismissed',
      'thought_record', 'values_sort', 'fear_ladder', 'journal_private',
      'scale_result', // chat sessions report screener answers here (ai-therapist-118)
    ]);
    if (!kind || !KINDS.has(kind) || typeof summary !== 'string' || !summary.trim()) {
      return res.status(400).json({ error: 'valid kind and non-empty summary required' });
    }

    try {
      const session = await getSessionAccessInfo(sessionId);
      if (!session) return res.status(404).json({ error: 'Session not found' });
      if (!canAccessSession(req, session, sessionId)) {
        return res.status(403).json({ error: 'Access denied' });
      }

      const text = summary.trim().slice(0, 4000);

      const { insertMessage } = await import('../../db/index.js');
      await insertMessage(sessionId, 'system', `tool_event_${kind}`, text, text, { source: 'tool-event' });

      const { sidebandManager } = await import('../../services/sidebandManager.service.js');
      let injected = await sidebandManager.tryInject(sessionId, 'system', text, true);

      // Chat sessions have no sideband: append the outcome to the in-memory
      // chat history instead so it rides along with the next turn — same
      // mechanism as crisis steering (ai-therapist-118). The client treats
      // injected=true as "the model will know" and skips its fallback.
      if (!injected && session.session_type === 'chat') {
        const { injectGuidance, getConversationHistory } = await import('../../services/chatTherapy.service.js');
        if (getConversationHistory(sessionId).length > 0) {
          injectGuidance(sessionId, text);
          injected = true;
        }
      }

      if (global.io) void broadcastAdminEventForSession(global.io, 'session:tool-event', {
        sessionId, kind, injected, at: new Date(),
      }, sessionId);

      res.json({ success: true, injected });
    } catch (err) {
      console.error('Failed to record tool event:', err);
      res.status(500).json({ error: 'Failed to record tool event' });
    }
  });

  // POST /api/sessions/:sessionId/feedback - post-session participant survey
  // (ai-therapist-25b): 2-3 Likert ratings (1-5) + optional free text, shown
  // once on the post-session screen. Upsert so a resubmit just overwrites.
  router.post('/api/sessions/:sessionId/feedback', async (req, res) => {
    const { sessionId } = req.params;
    const { helpfulness_rating, ease_rating, would_return_rating, comments } = req.body as {
      helpfulness_rating?: number | null;
      ease_rating?: number | null;
      would_return_rating?: number | null;
      comments?: string | null;
    };

    try {
      const session = await getSessionAccessInfo(sessionId);
      if (!session) return res.status(404).json({ error: 'Session not found' });
      if (!canAccessSession(req, session, sessionId)) {
        return res.status(403).json({ error: 'Access denied' });
      }

      const { upsertSessionFeedback } = await import('../../db/index.js');
      const feedback = await upsertSessionFeedback(sessionId, {
        helpfulness_rating: helpfulness_rating ?? null,
        ease_rating: ease_rating ?? null,
        would_return_rating: would_return_rating ?? null,
        comments: comments ?? null,
      });
      res.json({ success: true, feedback });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to store feedback';
      // Validation errors from upsertSessionFeedback (bad rating) are the
      // participant's fault, not a server error.
      const isValidationError = /must be an integer 1-5/.test(message);
      console.error('Failed to store session feedback:', err);
      res.status(isValidationError ? 400 : 500).json({ error: message });
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
      // Auth (ai-therapist-62, revised after live verification 2026-07-31):
      // the STANDARD API key is rejected with 404 call_id_not_found for the
      // entire life of a real WebRTC call (verified in prod logs — all retry
      // attempts fail, so it is NOT the attach-before-registered race; likely
      // a key/project scope mismatch). The per-session EPHEMERAL key is what
      // attaches successfully, so it stays the primary. The standard key is
      // kept as the fallback for late reconnects where the ephemeral key may
      // have expired (the original item-62 concern).
      if (!sidebandEnabled) {
        console.log('[Sideband] Disabled via SIDEBAND_ENABLED=false; call_id recorded only.');
      } else {
        const { getOpenAIKey } = await import('../../config/secrets.js');
        const standardKey = await getOpenAIKey();
        const ephemeralKey = typeof ephemeral_key === 'string' && ephemeral_key ? ephemeral_key : undefined;
        const apiKey = ephemeralKey ?? standardKey;
        const fallbackKey = ephemeralKey ? standardKey : undefined;
        if (!apiKey) {
          console.error('[Sideband] No usable OpenAI key (ephemeral or standard); skipping sideband attach.');
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

  // POST /api/sessions/create - create a new therapy session. Quiet-hours
  // gated as defense in depth alongside /token and /api/chat/start.
  router.post('/api/sessions/create', requireOutsideQuietHours, requireActiveStudyStatus, async (req, res) => {
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
      // through reconnect attempts after the call ends. A closing note is
      // injected first so the transcript records WHY the conversation stops
      // (participant-initiated) instead of just going silent.
      try {
        const { sidebandManager } = await import('../../services/sidebandManager.service.js');
        await sidebandManager.tryInject(
          sessionId, 'system',
          '[The participant ended the session from their screen. The session is now closing.]',
          false,
        );
        await sidebandManager.disconnect(sessionId);
      } catch (e) {
        console.error('[Sideband] cleanup on session end failed:', e);
      }

      // Redact the whole session in one batched job (fire-and-forget), THEN
      // auto-name from the redacted transcript. Naming must run after redaction
      // completes — before it, content_redacted is null and the namer sees a
      // blank transcript and produces junk (ai-therapist wave1 bug 1).
      import('../../services/sessionRedaction.service.js')
        .then(m => m.redactSession(sessionId))
        .then(() => generateSessionNameAsync(sessionId))
        .catch(e => console.error('[Redaction] session redaction/naming failed:', e));

      // Finalize the audio recording (wrap buffered PCM → WAV → object storage).
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

      void broadcastAdminEventForSession(global.io, 'session:ended', { sessionId, endedAt: new Date(), endedBy: 'user' }, sessionId, 'summary');
      global.io.to(`session:${sessionId}`).emit('session:status', { status: 'ended', endedBy: 'user' });

      res.json({ ...updatedSession, message: 'Session ended successfully' });
    } catch (err) {
      console.error('Failed to end session:', err);
      res.status(500).json({ error: 'Failed to end session' });
    }
  });

  return router;
}
