/**
 * Sideband manager (GPT-Live).
 *
 * Attaches a server-side WebSocket to the browser-owned WebRTC voice session so
 * the backend can execute tools, persist transcripts, meter usage, and steer the
 * conversation.
 *
 * This file REPLACED the Realtime API implementation. The public surface
 * (tryInject / isConnected / disconnect / getActiveConnections /
 * reattachActiveSessions / injectMessage / updateSession / interrupt /
 * createResponse / triggerTool) is preserved so the ~20 existing call sites in
 * crisisIntervention, sessionLifecycle, toolRegistry and the admin routes did
 * not have to change. What changed underneath is nearly everything:
 *
 *   Realtime                                   GPT-Live
 *   ---------------------------------------    ----------------------------------------
 *   wss://…/v1/realtime?call_id=rtc_…          wss://…/v1/live/sessions/{id}/attach
 *   conversation.item.input_audio_             session.input_transcript.delta
 *     transcription.delta/.completed             (deltas only — no completion event)
 *   response.output_audio_transcript.*         session.output_transcript.delta
 *   conversation.item.create (role: system)    session.instructions/thinking/commentary.append
 *   response.function_call_arguments.done      response.event → response.output_item.done
 *   conversation.item.create                   response.item.create
 *     (function_call_output)                     (function_call_output)
 *   response.done.usage → tokens               session.usage.updated → { seconds }
 *   session.update { type:'realtime', … }      session.update { delegation: { responses: … } }
 *
 * Three Realtime capabilities have no GPT-Live equivalent and are gone:
 *   - hold_floor. It worked by setting turn_detection: null. GPT-Live owns
 *     turn-taking natively and exposes no VAD to disable, so the tool that
 *     depended on it was removed from the registry rather than faked.
 *   - A hard interrupt. response.cancel + output_audio_buffer.clear became
 *     requestStopSpeaking(), which is advisory: the docs are explicit that a
 *     corrective instruction cannot retract audio already heard. Callers that
 *     need a real stop must also cut playback client-side.
 *   - Out-of-band responses (conversation: 'none'). Re-grounding is now a
 *     direct Responses call whose summary returns via session.thinking.append.
 *
 * The single hardest difference is transcripts. Realtime emits a terminal
 * `…input_audio_transcription.completed` carrying a whole user turn, which is
 * what the crisis pipeline scores. GPT-Live emits only fragments, explicitly
 * documented as "not a complete user turn", with no turn-completed event and no
 * item id — because the model is full duplex and both speakers can talk at once.
 * Turn assembly therefore has to happen here. See TranscriptAssembler below.
 */

import WebSocket from 'ws';
import { pool } from '../config/db.js';
import { insertMessagesBatch } from '../db/index.js';
import { broadcastAdminEventForSession } from '../utils/adminBroadcast.js';

/** A transcript fragment as delivered by session.*_transcript.delta. */
interface TranscriptDelta {
  delta: string;
  start_ms: number;
  end_ms: number;
}

/**
 * Assembles GPT-Live transcript fragments into whole conversational turns.
 *
 * GPT-Live gives us fragments with millisecond intervals on the session
 * timeline and nothing else — no item id, no turn boundary, no completion
 * event. Downstream, though, the crisis pipeline scores one user *turn* at a
 * time, and the messages table stores one row per turn. So a turn boundary has
 * to be inferred, and the inference has to be conservative in one specific
 * direction: flushing LATE is a latency cost, but flushing a partial utterance
 * EARLY means the crisis assessor scores half a sentence. "I've been thinking
 * about" scores very differently from "I've been thinking about killing myself".
 *
 * The rule: close a turn when a gap of `gapMs` passes with no new fragment for
 * that speaker. The docs warn that a missing event does not imply silence and
 * that late fragments can arrive out of order, so:
 *   - fragments are appended in `start_ms` order, not arrival order;
 *   - a fragment that arrives after a flush starts a NEW turn rather than being
 *     dropped or retroactively merged, keeping every word in the record;
 *   - the two speakers are tracked independently, because in a full-duplex
 *     conversation their turns legitimately overlap.
 */
export class TranscriptAssembler {
  private fragments: TranscriptDelta[] = [];
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly gapMs: number,
    private readonly onTurn: (text: string, startMs: number, endMs: number) => void,
  ) {}

  add(fragment: TranscriptDelta): void {
    this.fragments.push(fragment);
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), this.gapMs);
    this.timer.unref?.();
  }

  /**
   * Emit the buffered fragments as one turn. Called by the gap timer, and
   * directly at session close so a final utterance is never lost.
   */
  flush(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.fragments.length === 0) return;

    // Order by the session timeline, not arrival: the docs allow late and
    // out-of-order delivery, and concatenating in arrival order would scramble
    // the sentence. Fragments are concatenated EXACTLY as received, with no
    // trimming or inserted spaces — the guide is explicit that the model's
    // fragments already carry their own leading/trailing whitespace.
    const ordered = [...this.fragments].sort((a, b) => a.start_ms - b.start_ms);
    this.fragments = [];

    const text = ordered.map(f => f.delta).join('');
    if (!text.trim()) return;

    this.onTurn(text, ordered[0].start_ms, ordered[ordered.length - 1].end_ms);
  }

  dispose(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.fragments = [];
  }
}

/** Per-session mutable state for a Live sideband. */
interface LiveSessionState {
  ws: WebSocket;
  liveSessionId: string;
  apiKey: string;
  model: string;
  backendModel: string;
  userTranscript: TranscriptAssembler;
  assistantTranscript: TranscriptAssembler;
  /**
   * Function calls collected from nested response.output_item.done, keyed by
   * call_id. The delegation guide is emphatic that the terminal lifecycle
   * snapshot deliberately reports `output: []` — an empty terminal output list
   * does NOT mean there are no pending calls. The only reliable source is the
   * per-item done events, so they are accumulated here.
   */
  pendingCalls: Map<string, { name: string; args: string; delegationId: string | null }>;
  /** Backend response ids already metered, so a replayed event can't double-bill. */
  meteredResponses: Set<string>;
  /** Latest cumulative voice seconds from session.usage.updated. */
  lastUsageSeconds: number;
  peakContextRatio: number;
  /** Set once session.closed arrives; final usage is confirmed. */
  finalized: boolean;
  keepalive: NodeJS.Timeout | null;
  phaseTimers: NodeJS.Timeout[];
  /** Mid-session re-grounding interval (config-gated, off by default). */
  regrounding: NodeJS.Timeout | null;
  /** Pending restore of delegation tool_choice after an admin-forced tool. */
  toolChoiceReset: NodeJS.Timeout | null;
  /**
   * Per-role turn counters, used to mint a transcript row id that is stable
   * within a turn and distinct between turns. See emitTranscript.
   */
  userTurnIndex: number;
  assistantTurnIndex: number;
  /**
   * Which attach this state belongs to. A reconnect builds fresh state with the
   * turn counters back at 0, so the sequence disambiguates transcript row ids
   * across attaches. See emitTranscript.
   */
  attachSeq: number;
  reconnectAttempts: number;
}

export class SidebandManager {
  private sessions = new Map<string, LiveSessionState>();
  /** Sessions that have ended. Never re-attach: the live session id is gone. */
  private endedSessions = new Set<string>();
  /** Monotonic attach counter per session, so reconnects mint distinct row ids. */
  private attachSeqs = new Map<string, number>();

  private readonly maxReconnectAttempts = 3;
  private readonly reconnectDelayMs = 2000;
  private readonly keepaliveMs = 20000;
  /**
   * Silence that closes a turn. 900ms is long enough to ride through the pauses
   * inside a sentence — which matter a great deal in therapy, where people stop
   * mid-thought — and short enough that crisis scoring isn't delayed past the
   * model's own reply.
   */
  private readonly turnGapMs = 900;
  /**
   * How long an admin-forced delegation tool_choice stays pinned. GPT-Live emits
   * no per-turn completion event to restore on, so this is a fixed window.
   */
  private readonly toolChoiceResetMs = 45000;

  /** Next attach sequence for a session. Cleared on disconnect with the rest. */
  private nextAttachSeq(sessionId: string): number {
    const next = (this.attachSeqs.get(sessionId) ?? 0) + 1;
    this.attachSeqs.set(sessionId, next);
    return next;
  }

  // -------------------------------------------------------------------------
  // Connection lifecycle
  // -------------------------------------------------------------------------

  /**
   * Attach to a running GPT-Live session.
   *
   * Unlike the Realtime attach, there is no call-registration race to retry
   * around: POST /v1/live/sessions has already returned a session id by the time
   * we get here, and that id is valid immediately. There is also no ephemeral-key
   * fallback — the docs require the same project API key that created the
   * session, so there is exactly one correct credential.
   */
  async connect(
    sessionId: string,
    liveSessionId: string,
    apiKey: string,
    opts: { model: string; backendModel: string },
  ): Promise<WebSocket> {
    if (this.endedSessions.has(sessionId)) {
      throw new Error('Session ended; Live sideband attach aborted');
    }
    const existing = this.sessions.get(sessionId);
    if (existing) {
      console.warn(`[Live] Already attached for session ${sessionId.substring(0, 12)}...`);
      return existing.ws;
    }

    const wsUrl = `wss://api.openai.com/v1/live/sessions/${encodeURIComponent(liveSessionId)}/attach`;
    console.log(`[Live] Attaching sideband for ${sessionId.substring(0, 12)}... -> ${liveSessionId}`);

    let safetyIdentifier: string | undefined;
    try {
      const { safetyIdentifierForSession } = await import('../utils/safetyIdentifier.js');
      safetyIdentifier = await safetyIdentifierForSession(sessionId);
    } catch { /* best-effort */ }

    const ws = new WebSocket(wsUrl, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        ...(safetyIdentifier ? { 'OpenAI-Safety-Identifier': safetyIdentifier } : {}),
      },
    });

    const state: LiveSessionState = {
      ws,
      liveSessionId,
      apiKey,
      model: opts.model,
      backendModel: opts.backendModel,
      userTranscript: new TranscriptAssembler(this.turnGapMs, (text, startMs, endMs) =>
        this.onUserTurn(sessionId, text, startMs, endMs)),
      assistantTranscript: new TranscriptAssembler(this.turnGapMs, (text, startMs, endMs) =>
        this.onAssistantTurn(sessionId, text, startMs, endMs)),
      pendingCalls: new Map(),
      meteredResponses: new Set(),
      lastUsageSeconds: 0,
      peakContextRatio: 0,
      finalized: false,
      keepalive: null,
      phaseTimers: [],
      regrounding: null,
      toolChoiceReset: null,
      userTurnIndex: 0,
      assistantTurnIndex: 0,
      attachSeq: this.nextAttachSeq(sessionId),
      reconnectAttempts: 0,
    };
    this.sessions.set(sessionId, state);

    ws.on('open', () => this.handleOpen(sessionId, liveSessionId));
    ws.on('message', data => void this.handleMessage(sessionId, data));
    ws.on('error', err => void this.handleError(sessionId, err));
    ws.on('close', (code, reason) => void this.handleClose(sessionId, code, reason));
    ws.on('unexpected-response', (_req, res) => {
      let body = '';
      res.on('data', (chunk: Buffer) => { body += chunk.toString(); });
      res.on('end', () => {
        const detail =
          `Live sideband upgrade rejected: HTTP ${res.statusCode} for ${liveSessionId} — ${body || '(empty body)'}`;
        console.error(`[Live] ${detail}`);
        this.sessions.delete(sessionId);
        void this.logConnectionError(sessionId, new Error(detail));
        if (global.io) {
          void broadcastAdminEventForSession(global.io, 'sideband:error', {
            sessionId, error: detail, statusCode: res.statusCode,
          }, sessionId);
        }
        // Do not leave an active voice session running with no monitoring.
        void this.failClosedUnmonitored(sessionId, `attach rejected with HTTP ${res.statusCode}`);
      });
    });

    return ws;
  }

  /**
   * Attach and WAIT for the socket to actually open.
   *
   * `connect()` returns as soon as the WebSocket object exists — it never
   * awaits the upgrade — so a caller that awaits it learns nothing about
   * whether the sideband is live. That matters much more under GPT-Live than
   * it did under Realtime: the client no longer batches transcripts to
   * /logs/batch, so this socket is the ONLY path by which participant speech
   * reaches runCrisisPipeline. An unattached voice session is an unmonitored
   * one.
   *
   * Rejects on upgrade rejection, socket error, or timeout.
   */
  async connectAndWait(
    sessionId: string,
    liveSessionId: string,
    apiKey: string,
    opts: { model: string; backendModel: string; timeoutMs?: number },
  ): Promise<void> {
    const timeoutMs = opts.timeoutMs ?? 10_000;
    const ws = await this.connect(sessionId, liveSessionId, apiKey, opts);
    if (ws.readyState === WebSocket.OPEN) return;

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => { cleanup(); reject(new Error(`Live sideband did not open within ${timeoutMs}ms`)); },
        timeoutMs,
      );
      timer.unref?.();
      const onOpen = () => { cleanup(); resolve(); };
      const onFail = () => { cleanup(); reject(new Error('Live sideband closed before opening')); };
      const cleanup = () => {
        clearTimeout(timer);
        ws.off('open', onOpen);
        ws.off('close', onFail);
        ws.off('error', onFail);
      };
      ws.once('open', onOpen);
      ws.once('close', onFail);
      ws.once('error', onFail);
    });
  }

  /**
   * The sideband for an ACTIVE voice session is gone for good.
   *
   * Under Realtime this was survivable: participant speech also reached the
   * server through the client's /logs/batch transcript upload, so a dead
   * sideband cost steering and tool execution but detection kept running.
   * Under GPT-Live there is no second path — onUserTurn is the only writer and
   * the only runCrisisPipeline caller for voice. A live session with no
   * sideband is a session where a suicide disclosure would be neither scored,
   * flagged, paged, nor even recorded.
   *
   * So we fail closed: end the session rather than let it continue unmonitored,
   * and page the study team, because this is an operational failure a human
   * needs to know about rather than a console line.
   */
  private async failClosedUnmonitored(sessionId: string, reason: string): Promise<void> {
    try {
      const { getSessionAccessInfo } = await import('../db/index.js');
      const session = await getSessionAccessInfo(sessionId);
      if (!session || session.status !== 'active') return;

      console.error(
        `[Live] UNMONITORED SESSION ${sessionId.substring(0, 12)}... — ${reason}. ` +
        'Ending it: with no sideband there is no crisis detection on the voice path.',
      );

      // Alert first: if the teardown itself fails, the page still went out.
      try {
        const { sendCrisisAlert } = await import('./crisisAlert.service.js');
        await sendCrisisAlert(
          `AI-Therapist: voice session ${sessionId.substring(0, 12)}... lost its monitoring connection ` +
          `(${reason}) and was ended automatically. No crisis detection was running on that session ` +
          'after the disconnect. Review the transcript.',
        );
      } catch (err) {
        console.error('[Live] Failed to page on unmonitored session:', err);
      }

      if (global.io) {
        void broadcastAdminEventForSession(global.io, 'sideband:unmonitored', {
          sessionId, reason, endedAt: new Date(),
        }, sessionId);
      }

      const { serverEndSession } = await import('./sessionLifecycle.service.js');
      await serverEndSession(sessionId, {
        endedBy: 'system',
        reason: 'sideband_lost',
        message:
          'Your session ended because the connection to our monitoring system was lost. ' +
          'Nothing you shared was lost. You can start a new session whenever you are ready.',
      });
    } catch (err) {
      console.error(`[Live] failClosedUnmonitored failed for ${sessionId.substring(0, 12)}...:`, err);
    }
  }

  private async handleOpen(sessionId: string, liveSessionId: string): Promise<void> {
    try {
      await pool.query(
        `UPDATE therapy_sessions
            SET openai_live_session_id = $1,
                sideband_connected = TRUE,
                sideband_connected_at = CURRENT_TIMESTAMP,
                sideband_error = NULL
          WHERE session_id = $2`,
        [liveSessionId, sessionId],
      );

      if (global.io) {
        void broadcastAdminEventForSession(global.io, 'sideband:connected', {
          sessionId, callId: liveSessionId, channel: 'live', connectedAt: new Date(),
        }, sessionId);
      }

      this.startKeepalive(sessionId);
      await this.schedulePhaseNudges(sessionId);
      await this.scheduleRegrounding(sessionId);
      console.log(`[Live] Sideband established for ${sessionId.substring(0, 12)}...`);
    } catch (err) {
      console.error('[Live] handleOpen failed:', err);
    }
  }

  private startKeepalive(sessionId: string): void {
    const state = this.sessions.get(sessionId);
    if (!state) return;
    if (state.keepalive) clearInterval(state.keepalive);
    const timer = setInterval(() => {
      const s = this.sessions.get(sessionId);
      if (s && s.ws.readyState === WebSocket.OPEN) {
        try { s.ws.ping(); } catch (err) {
          console.error(`[Live] Keepalive ping failed for ${sessionId.substring(0, 12)}...:`, err);
        }
      } else {
        clearInterval(timer);
      }
    }, this.keepaliveMs);
    timer.unref?.();
    state.keepalive = timer;
  }

  // -------------------------------------------------------------------------
  // Event routing
  // -------------------------------------------------------------------------

  private async handleMessage(sessionId: string, data: WebSocket.RawData): Promise<void> {
    let event: { type: string; [key: string]: unknown };
    try {
      event = JSON.parse(data.toString());
    } catch (err) {
      console.error('[Live] Message parse error:', err);
      return;
    }

    // A sideband also receives reflected audio copies. Those are high-frequency
    // and we already capture audio through the client's PCM tee, so they are
    // dropped before the log line to avoid flooding both the logs and the CPU.
    const noisy = new Set([
      'session.input_audio.append',
      'session.output_audio.delta',
      'session.input_transcript.delta',
      'session.output_transcript.delta',
    ]);
    if (!noisy.has(event.type)) {
      console.log(`[Live] ${sessionId.substring(0, 12)}... Event: ${event.type}`);
    }

    try {
      await this.handleEvent(sessionId, event);
    } catch (err) {
      console.error(`[Live] Handler failed for ${event.type}:`, err);
    }
  }

  private async handleEvent(sessionId: string, event: { type: string; [key: string]: unknown }): Promise<void> {
    switch (event.type) {
      case 'session.started':
      case 'session.updated':
        if (global.io) {
          void broadcastAdminEventForSession(global.io, 'session:openai-update', {
            sessionId, eventType: event.type, data: event,
          }, sessionId);
        }
        break;

      // --- Transcripts -----------------------------------------------------
      case 'session.input_transcript.delta': {
        const state = this.sessions.get(sessionId);
        if (!state) break;
        state.userTranscript.add({
          delta: String(event.delta ?? ''),
          start_ms: Number(event.start_ms ?? 0),
          end_ms: Number(event.end_ms ?? 0),
        });
        this.emitTranscript(sessionId, { role: 'user', delta: String(event.delta ?? ''), final: false });
        break;
      }

      case 'session.output_transcript.delta': {
        const state = this.sessions.get(sessionId);
        if (!state) break;
        state.assistantTranscript.add({
          delta: String(event.delta ?? ''),
          start_ms: Number(event.start_ms ?? 0),
          end_ms: Number(event.end_ms ?? 0),
        });
        this.emitTranscript(sessionId, { role: 'assistant', delta: String(event.delta ?? ''), final: false });
        break;
      }

      // --- Delegation ------------------------------------------------------
      case 'session.delegation.created':
        if (global.io) {
          const delegation = event.delegation as { id?: string; target?: string } | undefined;
          void broadcastAdminEventForSession(global.io, 'live:delegation', {
            sessionId,
            delegationId: delegation?.id ?? null,
            target: delegation?.target ?? null,
            offsetMs: event.offset_ms ?? null,
            timestamp: new Date(),
          }, sessionId);
        }
        break;

      // Nested Responses events arrive wrapped. Dispatch on the INNER type and
      // preserve the outer delegation_id — the guide warns specifically against
      // treating top-level response.* values as unwrapped Responses events.
      case 'response.event':
        await this.handleNestedResponseEvent(
          sessionId,
          event.event as { type?: string; [key: string]: unknown } | undefined,
          typeof event.delegation_id === 'string' ? event.delegation_id : null,
        );
        break;

      // --- Usage -----------------------------------------------------------
      case 'session.usage.updated': {
        const state = this.sessions.get(sessionId);
        if (!state) break;
        const usage = event.usage as { seconds?: number } | undefined;
        const contextWindow = event.context_window as { usage_ratio?: number } | undefined;
        // Snapshots, not increments — assign, never accumulate.
        if (typeof usage?.seconds === 'number') state.lastUsageSeconds = usage.seconds;
        if (typeof contextWindow?.usage_ratio === 'number') {
          state.peakContextRatio = Math.max(state.peakContextRatio, contextWindow.usage_ratio);
        }
        void this.persistUsage(sessionId, { finalized: false });
        break;
      }

      case 'session.closed': {
        const state = this.sessions.get(sessionId);
        if (state) {
          const usage = event.usage as { seconds?: number } | undefined;
          if (typeof usage?.seconds === 'number') state.lastUsageSeconds = usage.seconds;
          state.finalized = true;
          // Flush any half-spoken turn before teardown so a final utterance —
          // which in this application could be the most clinically important
          // thing said — is never lost.
          state.userTranscript.flush();
          state.assistantTranscript.flush();
          await this.persistUsage(sessionId, {
            finalized: true,
            closeReason: typeof event.reason === 'string' ? event.reason : null,
          });
        }
        console.log(`[Live] Session closed for ${sessionId.substring(0, 12)}...: reason=${String(event.reason)}`);
        if (global.io) {
          void broadcastAdminEventForSession(global.io, 'live:closed', {
            sessionId, reason: event.reason ?? null, usage: event.usage ?? null, timestamp: new Date(),
          }, sessionId);
        }
        break;
      }

      // --- Acknowledgements ------------------------------------------------
      case 'session.instructions.appended':
      case 'session.thinking.appended':
      case 'session.commentary.appended':
        // Acknowledgement only. Explicitly NOT proof that the model consumed the
        // update, spoke it, or that the participant heard anything.
        break;

      case 'error': {
        const err = event.error as { code?: string; message?: string; client_event_id?: string } | undefined;
        console.error(`[Live] API error for ${sessionId.substring(0, 12)}...:`, err);
        await this.logError(sessionId, err);
        if (global.io) {
          void broadcastAdminEventForSession(global.io, 'sideband:error', { sessionId, error: err }, sessionId);
        }
        break;
      }

      default:
        break;
    }
  }

  /**
   * Handle one nested Responses event from a `response.event` envelope.
   *
   * Only output_item.done matters for tool execution. Per the delegation guide,
   * an arguments-done event alone cannot identify a call (it carries neither the
   * function name nor the call_id), and the terminal lifecycle snapshot reports
   * an empty output array by design — so completed output items are the single
   * source of truth for what needs a result.
   */
  private async handleNestedResponseEvent(
    sessionId: string,
    inner: { type?: string; [key: string]: unknown } | undefined,
    delegationId: string | null,
  ): Promise<void> {
    if (!inner?.type) return;
    const state = this.sessions.get(sessionId);
    if (!state) return;

    switch (inner.type) {
      case 'response.output_item.done': {
        const item = inner.item as
          | { type?: string; name?: string; call_id?: string; arguments?: string }
          | undefined;
        if (item?.type !== 'function_call' || !item.call_id || !item.name) return;
        state.pendingCalls.set(item.call_id, {
          name: item.name,
          args: item.arguments ?? '{}',
          delegationId,
        });
        await this.executePendingCall(sessionId, item.call_id);
        break;
      }

      case 'response.completed': {
        // Backend token usage for the delegated Responses call. Counted once per
        // response id so a duplicate or replayed event can't double-bill.
        const response = inner.response as
          | { id?: string; model?: string; usage?: { input_tokens?: number; output_tokens?: number } }
          | undefined;
        const responseId = response?.id;
        if (!responseId || state.meteredResponses.has(responseId)) return;
        state.meteredResponses.add(responseId);
        const { recordLlmUsage } = await import('../db/index.js');
        await recordLlmUsage(
          sessionId,
          'live_delegation',
          response?.model ?? state.backendModel,
          response?.usage?.input_tokens ?? null,
          response?.usage?.output_tokens ?? null,
        );
        break;
      }

      default:
        break;
    }
  }

  // -------------------------------------------------------------------------
  // Turn handling
  // -------------------------------------------------------------------------

  /**
   * A complete participant turn. Persisted, surfaced to admins, and — critically
   * — pushed through the shared crisis pipeline, exactly as the Realtime path
   * does from logs.routes. This is the safety-critical join point: everything
   * downstream (keyword tier, moderation tier, LLM risk assessor, graduated
   * response, minor safeguard) is reused unchanged.
   */
  private onUserTurn(sessionId: string, text: string, startMs: number, endMs: number): void {
    this.emitTranscript(sessionId, { role: 'user', text, final: true });

    void (async () => {
      let messageId: string | number | null = null;
      try {
        const inserted = await insertMessagesBatch([{
          session_id: sessionId,
          role: 'user',
          // 'voice' / 'response', not 'message': analytics.queries.ts and
          // adminSessions.queries.ts count voice turns with
          // `message_type = 'voice'`, so anything else reports zero voice
          // messages for every GPT-Live session.
          message_type: 'voice',
          content: text,
          content_redacted: null,
          metadata: { channel: 'live', start_ms: startMs, end_ms: endMs },
        }]);
        messageId = inserted?.[0]?.message_id ?? null;
      } catch (err) {
        console.error(`[Live] Failed to persist user turn for ${sessionId.substring(0, 12)}...:`, err);
      }

      // Run the safety pipeline even if persistence failed — a DB outage must
      // never silently disable crisis detection. The pipeline tolerates a null
      // messageId; it only uses it to link the flag back to the turn.
      //
      // Channel stays 'realtime': it selects steering DELIVERY (sideband vs the
      // chat request/response cycle), and this IS the sideband path. Detection,
      // flagging, paging and adverse-event handling are channel-independent.
      try {
        const { runCrisisPipeline } = await import('./crisisPipeline.service.js');
        await runCrisisPipeline({ sessionId, messageId, content: text }, 'realtime');
      } catch (err) {
        console.error(`[Live] Crisis pipeline failed for ${sessionId.substring(0, 12)}...:`, err);
      }
    })();
  }

  /** A complete assistant turn. Persisted and surfaced; also moderated. */
  private onAssistantTurn(sessionId: string, text: string, startMs: number, endMs: number): void {
    this.emitTranscript(sessionId, { role: 'assistant', text, final: true });

    void (async () => {
      try {
        await insertMessagesBatch([{
          session_id: sessionId,
          role: 'assistant',
          // Matches the assistant-side voice convention in existing data.
          message_type: 'response',
          content: text,
          content_redacted: null,
          metadata: { channel: 'live', start_ms: startMs, end_ms: endMs },
        }]);
      } catch (err) {
        console.error(`[Live] Failed to persist assistant turn for ${sessionId.substring(0, 12)}...:`, err);
      }
    })();
  }

  /**
   * Push a transcript fragment (or a finalized turn) to the admin monitoring room.
   *
   * GPT-Live fragments carry no item id, but the admin client accumulates turns
   * with `findIndex(t => t.itemId === data.itemId)` — so the id has to be
   * stable WITHIN a turn and distinct BETWEEN turns. A single constant per role
   * would collapse the entire session into one ever-growing row, and each
   * final event would overwrite it with just that turn's text.
   *
   * The counter advances when a turn finalizes, so every delta of the next turn
   * lands on a fresh row.
   */
  private emitTranscript(
    sessionId: string,
    payload: { role: 'user' | 'assistant'; delta?: string; text?: string; final: boolean },
  ): void {
    if (!global.io) return;

    const state = this.sessions.get(sessionId);
    const counters = payload.role === 'user' ? state?.userTurnIndex : state?.assistantTurnIndex;
    // The attach sequence is part of the id because a reconnect builds fresh
    // per-session state with counters back at 0. Without it, turn ids repeat
    // after a reconnect and the admin monitor — which keys rows by itemId —
    // merges post-reconnect turns into pre-reconnect rows.
    const itemId = `live-${payload.role}-${state?.attachSeq ?? 0}-${counters ?? 0}`;
    if (payload.final && state) {
      if (payload.role === 'user') state.userTurnIndex += 1;
      else state.assistantTurnIndex += 1;
    }

    void broadcastAdminEventForSession(global.io, 'sideband:transcript', {
      sessionId,
      itemId,
      ...payload,
      timestamp: new Date(),
    }, sessionId);

    void broadcastAdminEventForSession(global.io, 'session:activity', {
      sessionId,
      lastActivity: new Date(),
      deltaMessages: payload.final ? 1 : 0,
    }, sessionId);
  }

  // -------------------------------------------------------------------------
  // Tool execution
  // -------------------------------------------------------------------------

  /**
   * Execute one delegated function call and return its result to the backend.
   *
   * The result protocol differs from Realtime: `response.item.create` appends
   * the output, and a separate `response.create` continues the backend response.
   * Appending a result does NOT continue it automatically, and `response.create`
   * must not carry a Responses request body — it uses the session's configured
   * backend.
   */
  private async executePendingCall(sessionId: string, callId: string): Promise<void> {
    const state = this.sessions.get(sessionId);
    const call = state?.pendingCalls.get(callId);
    if (!state || !call) return;

    let args: Record<string, unknown> = {};
    let parseError: string | null = null;
    try {
      args = JSON.parse(call.args || '{}') as Record<string, unknown>;
    } catch (err) {
      parseError = err instanceof Error ? err.message : String(err);
    }

    await insertMessagesBatch([{
      session_id: sessionId,
      role: 'system',
      message_type: 'tool_call',
      content: `Tool called: ${call.name}`,
      content_redacted: null,
      metadata: {
        tool_name: call.name, call_id: callId, arguments: args,
        delegation_id: call.delegationId, channel: 'live', status: 'executing',
      },
    }]).catch(err => console.error('[Live] Failed to log tool call:', err));

    if (global.io) {
      void broadcastAdminEventForSession(global.io, 'sideband:tool-call', {
        sessionId, callId, toolName: call.name, args, status: 'executing', timestamp: new Date(),
      }, sessionId);
    }

    let result: unknown;
    let failure: string | null = parseError;
    if (!failure) {
      try {
        const { toolRegistry } = await import('./toolRegistry.service.js');
        result = await toolRegistry.executeTool(call.name, args, { sessionId, channel: 'realtime' });
      } catch (err) {
        failure = err instanceof Error ? err.message : String(err);
      }
    }

    state.pendingCalls.delete(callId);

    const output = failure ? { error: failure, success: false } : result;
    try {
      this.sendEvent(sessionId, {
        type: 'response.item.create',
        event_id: `tool_result_${callId}`,
        item: { type: 'function_call_output', call_id: callId, output: JSON.stringify(output) },
      });
      // Continue the backend only once every outstanding call for this session
      // has a submitted result. Continuing early would run the backend while it
      // is still waiting on a sibling call.
      if (state.pendingCalls.size === 0) {
        this.sendEvent(sessionId, { type: 'response.create', event_id: `continue_${callId}` });
      }
    } catch (err) {
      console.error(`[Live] Failed to return tool result for ${call.name}:`, err);
    }

    await insertMessagesBatch([{
      session_id: sessionId,
      role: 'system',
      message_type: 'tool_response',
      content: failure ? `Tool error: ${call.name}` : `Tool response: ${call.name}`,
      content_redacted: null,
      metadata: {
        tool_name: call.name, call_id: callId, channel: 'live',
        ...(failure ? { error: failure, status: 'failed' } : { response: result, status: 'completed' }),
      },
    }]).catch(err => console.error('[Live] Failed to log tool response:', err));

    if (global.io) {
      void broadcastAdminEventForSession(global.io, 'sideband:tool-call', {
        sessionId, callId, toolName: call.name, args,
        ...(failure ? { error: failure, status: 'failed' } : { result, status: 'completed' }),
        timestamp: new Date(),
      }, sessionId);
    }

    import('../db/index.js')
      .then(db => db.insertToolInvocation(sessionId, call.name, failure ? null : args, !failure))
      .catch(err => console.error('[Live] Failed to log tool invocation:', err));
  }

  // -------------------------------------------------------------------------
  // Control surface
  // -------------------------------------------------------------------------

  /** Forward a client event on the sideband. @throws if not connected. */
  sendEvent(sessionId: string, event: Record<string, unknown>): void {
    const state = this.sessions.get(sessionId);
    if (!state || state.ws.readyState !== WebSocket.OPEN) {
      throw new Error('Live sideband connection not active');
    }
    state.ws.send(JSON.stringify(event));
    console.log(`[Live] Sent ${String(event.type)} for ${sessionId.substring(0, 12)}...`);
  }

  /**
   * Append trusted application instructions. This is the GPT-Live equivalent of
   * the Realtime `conversation.item.create` + `role: 'system'` steer, and it is
   * how crisis steering reaches the model.
   *
   * Content is capped at 500 tokens by the API. The cap is enforced here on
   * characters rather than risking a rejected event — dropping a crisis steer
   * because it ran three words long is not an acceptable failure mode.
   */
  async appendInstructions(sessionId: string, content: string, delegationId: string | null = null): Promise<void> {
    this.sendEvent(sessionId, {
      type: 'session.instructions.append',
      event_id: `instr_${Date.now()}`,
      delegation_id: delegationId,
      content: truncateForAppend(content),
    });
  }

  /** Append quiet factual context the model can use but should not announce. */
  async appendThinking(sessionId: string, content: string, delegationId: string | null = null): Promise<void> {
    this.sendEvent(sessionId, {
      type: 'session.thinking.append',
      event_id: `think_${Date.now()}`,
      delegation_id: delegationId,
      content: truncateForAppend(content),
    });
  }

  /** Append a verified result the model should say aloud (it may paraphrase). */
  async appendCommentary(sessionId: string, content: string, delegationId: string | null = null): Promise<void> {
    this.sendEvent(sessionId, {
      type: 'session.commentary.append',
      event_id: `comm_${Date.now()}`,
      delegation_id: delegationId,
      content: truncateForAppend(content),
    });
  }

  /**
   * Best-effort steer. Mirrors sidebandManager.tryInject so the shared crisis
   * code can treat both channels identically: false means the guidance could NOT
   * be delivered, which the caller records as an undelivered intervention rather
   * than assuming success.
   *
   * `respond` is accepted for signature compatibility and deliberately ignored:
   * GPT-Live decides for itself when to speak, and an appended instruction can
   * already interrupt speech in progress. There is no response.create that makes
   * the voice model talk.
   */
  async tryInject(sessionId: string, _role: 'system' | 'user', text: string, _respond: boolean): Promise<boolean> {
    if (!this.isConnected(sessionId)) return false;
    try {
      await this.appendInstructions(sessionId, text);
      return true;
    } catch (err) {
      console.error(`[Live] tryInject failed for ${sessionId.substring(0, 12)}...:`, err);
      return false;
    }
  }

  /** Update the delegated backend mid-session (model, instructions, tools…). */
  async updateDelegation(sessionId: string, responses: Record<string, unknown>): Promise<void> {
    this.sendEvent(sessionId, {
      type: 'session.update',
      event_id: `update_${Date.now()}`,
      session: { delegation: { responses } },
    });
  }

  /**
   * Inject guidance into the live conversation.
   *
   * Kept under the Realtime name because ~5 call sites depend on it, but the
   * semantics shifted and the difference matters. Realtime inserted a real
   * conversation item with a role; GPT-Live has no conversation item list to
   * write into, so this becomes an instructions append. Consequences:
   *
   *  - `role` is ignored. There is no way to speak AS the participant, so the
   *    admin "inject as user" control now steers the model instead of
   *    impersonating them. That is arguably the more honest behaviour for a
   *    study instrument, but it IS a behaviour change.
   *  - `respond` is ignored. GPT-Live decides when to speak; an appended
   *    instruction can already interrupt speech in progress, and there is no
   *    response.create that makes the voice model talk.
   *
   * @throws if the sideband is not connected (matching the old contract — see
   *   tryInject for the non-throwing variant callers use for best-effort steers).
   */
  async injectMessage(
    sessionId: string,
    _role: 'system' | 'user',
    text: string,
    _respond: boolean,
  ): Promise<void> {
    await this.appendInstructions(sessionId, text);
  }

  /**
   * Update session configuration mid-session.
   *
   * GPT-Live freezes the startup fields — model, the live model's own
   * instructions, audio and input are all rejected as update fields. The only
   * mutable surface is `session.delegation.responses`. So an `instructions`
   * update (toolRegistry's adaptive-prompt path, and the admin instructions
   * control) is routed to the BACKEND prompt, which is where the clinical
   * content lives anyway. Other keys are forwarded to the backend config as-is.
   */
  async updateSession(sessionId: string, updates: Record<string, unknown>): Promise<void> {
    await this.updateDelegation(sessionId, updates);
  }

  /**
   * Interrupt the model mid-response.
   *
   * Strictly weaker than the Realtime interrupt it replaces: it cannot cancel
   * generation and cannot retract buffered audio. It asks the model to stop and
   * yield, and the acknowledgement does not prove it did. Admin callers should
   * treat this as a request, not a guarantee.
   */
  async interrupt(sessionId: string): Promise<void> {
    await this.requestStopSpeaking(sessionId);
  }

  /**
   * Continue delegated backend work.
   *
   * The Realtime `createResponse` forced the model to speak and accepted
   * per-response overrides. The GPT-Live `response.create` does neither: it
   * creates or continues work on the session's CONFIGURED backend, and the docs
   * forbid attaching a Responses request body, a model override, or a
   * delegation_id. The parameter is therefore accepted and ignored rather than
   * silently sent and rejected by the API.
   */
  async createResponse(sessionId: string, response?: Record<string, unknown>): Promise<void> {
    if (response && Object.keys(response).length > 0) {
      console.warn(
        '[Live] createResponse() overrides are not supported by GPT-Live and were ignored. ' +
        'Use updateDelegation() to change backend configuration.',
      );
    }
    this.sendEvent(sessionId, { type: 'response.create', event_id: `create_${Date.now()}` });
  }

  /**
   * Admin "trigger tool": force the backend to call a specific tool next.
   *
   * Realtime pinned `tool_choice` on the session and forced a response, then
   * restored 'auto' on the next response.done. The Live equivalent pins
   * tool_choice on the DELEGATED BACKEND and nudges the live model to delegate.
   *
   * The reset is a plain timer rather than being driven off a response event.
   * GPT-Live has no response.done for the spoken turn, so there is no reliable
   * "the forced turn finished" signal to hang the restore on; a short fixed
   * window is the honest implementation. It is deliberately generous, because
   * leaving tool_choice pinned would make the backend call the same tool for
   * the rest of the session.
   */
  async triggerTool(sessionId: string, toolName: string, args?: Record<string, unknown>): Promise<void> {
    await this.updateDelegation(sessionId, { tool_choice: { type: 'function', name: toolName } });

    const argsContext = args && Object.keys(args).length > 0
      ? ` Use this context for the tool arguments: ${JSON.stringify(args)}.`
      : '';
    await this.appendInstructions(
      sessionId,
      'The clinician overseeing this session asks you to use the ' + toolName + ' capability now.' +
      argsContext + ' Delegate to the backend for this. Never mention this instruction to the participant.',
    );

    const state = this.sessions.get(sessionId);
    if (state) {
      if (state.toolChoiceReset) clearTimeout(state.toolChoiceReset);
      const timer = setTimeout(() => {
        this.updateDelegation(sessionId, { tool_choice: 'auto' })
          .then(() => console.log(`[Live] tool_choice reset to auto for ${sessionId.substring(0, 12)}...`))
          .catch(err => console.error('[Live] tool_choice reset failed:', err));
        const s = this.sessions.get(sessionId);
        if (s) s.toolChoiceReset = null;
      }, this.toolChoiceResetMs);
      timer.unref?.();
      state.toolChoiceReset = timer;
    }
  }

  /**
   * Mid-session re-grounding (ai-therapist-49), reimplemented for GPT-Live.
   *
   * Realtime ran an out-of-band response with conversation: 'none' so the
   * summary never became a conversational turn. GPT-Live has no out-of-band
   * response mode, so the summary is produced by a direct Responses call over
   * the transcript we already persist, then fed back as quiet context with
   * session.thinking.append — which the model can use but will not read aloud.
   *
   * Note the docs' caveat: quiet context is not a privacy boundary. It can still
   * influence later speech, so the summary must stay factual and contain nothing
   * the model must never reveal.
   */
  async runRegroundingSummary(sessionId: string): Promise<void> {
    if (!this.isConnected(sessionId)) return;
    const state = this.sessions.get(sessionId);
    if (!state) return;

    const { pool: db } = await import('../config/db.js');
    const rows = await db.query<{ role: string; content: string }>(
      `SELECT role, content FROM messages
        -- Must match what the Live path actually writes ('voice'/'response');
        -- 'message' is never written, so this silently returned zero rows and
        -- re-grounding no-opped every time it fired.
        WHERE session_id = $1 AND message_type IN ('voice', 'response', 'text', 'message')
        ORDER BY created_at ASC LIMIT 200`,
      [sessionId],
    );
    if (rows.rows.length === 0) return;

    const transcript = rows.rows.map(r => `${r.role}: ${r.content}`).join('\n');

    const { getOpenAIKey } = await import('../config/secrets.js');
    const { safetyIdentifierForSession } = await import('../utils/safetyIdentifier.js');
    const OpenAI = (await import('openai')).default;
    const client = new OpenAI({ apiKey: await getOpenAIKey() });

    const result = await client.responses.create({
      model: state.backendModel,
      instructions:
        'Summarize the therapy conversation SO FAR in ONE short paragraph (60 words or fewer) for internal use ' +
        'only — this is never shown to the participant. Cover: the main theme, the participant\'s emotional ' +
        'trajectory, and what has landed or helped so far, if anything. Plain prose, no headers, no lists.',
      input: transcript,
      store: false,
      safety_identifier: await safetyIdentifierForSession(sessionId).catch(() => undefined),
    });

    const text = result.output_text?.trim();
    if (!text) return;

    const { recordLlmUsage } = await import('../db/index.js');
    await recordLlmUsage(
      sessionId, 'insights', state.backendModel,
      result.usage?.input_tokens ?? null, result.usage?.output_tokens ?? null,
    );

    await this.appendThinking(sessionId, `Recap of the session so far: ${text}`);
    console.log(`[Live] Re-grounding context injected for ${sessionId.substring(0, 12)}...`);
  }

  /** Mute the participant's microphone server-side. Does not stop model output. */
  async muteInput(sessionId: string): Promise<void> {
    this.sendEvent(sessionId, { type: 'session.input_audio.mute', event_id: `mute_${Date.now()}` });
  }

  async unmuteInput(sessionId: string): Promise<void> {
    this.sendEvent(sessionId, { type: 'session.input_audio.unmute', event_id: `unmute_${Date.now()}` });
  }

  /**
   * Ask the model to stop speaking and yield.
   *
   * This is the closest available analogue to the Realtime `response.cancel` +
   * `output_audio_buffer.clear` interrupt, and it is strictly weaker: it cannot
   * retract audio the participant has already heard, and the acknowledgement
   * does not prove speech stopped. Callers that need a hard stop must also cut
   * playback on the client.
   */
  async requestStopSpeaking(sessionId: string): Promise<void> {
    await this.appendInstructions(
      sessionId,
      'Stop speaking immediately and wait for the participant. Do not continue the previous thought.',
    );
  }

  // -------------------------------------------------------------------------
  // Session-phase guidance
  // -------------------------------------------------------------------------

  /**
   * Wall-clock nudges that walk the model through consolidation → wind-down,
   * mirroring the Realtime SidebandManager's schedulePhaseNudges. Same config
   * gates (features.phase_guidance_enabled, session_limits) and the same
   * modality phase script, delivered as instruction appends instead of injected
   * system messages.
   */
  private async schedulePhaseNudges(sessionId: string): Promise<void> {
    const state = this.sessions.get(sessionId);
    if (!state || state.phaseTimers.length > 0) return;

    const { getSystemConfig, getActiveModality } = await import('../utils/sessionHelpers.js');
    const config = await getSystemConfig();
    const features = (config.features ?? {}) as Record<string, unknown>;
    if (features.phase_guidance_enabled === false) return;

    const limits = (config.session_limits ?? {}) as { enabled?: boolean; max_duration_minutes?: number };
    if (!limits.enabled || !limits.max_duration_minutes) return;

    const result = await pool.query<{ created_at: Date }>(
      'SELECT created_at FROM therapy_sessions WHERE session_id = $1', [sessionId],
    );
    const createdAt = result.rows[0]?.created_at;
    if (!createdAt) return;

    const totalMs = limits.max_duration_minutes * 60 * 1000;
    const elapsedMs = Date.now() - new Date(createdAt).getTime();
    const minutesLeftAt = (fraction: number) => Math.max(1, Math.round((totalMs * (1 - fraction)) / 60000));

    const modality = await getActiveModality();
    const modalityPhases = modality?.preset.phases;

    const phases: Array<{ at: number; text: string }> =
      modalityPhases && modalityPhases.length > 0
        ? modalityPhases.map(p => ({
            at: p.at,
            text: p.guidance + (p.at >= 0.8 ? ` About ${minutesLeftAt(p.at)} minutes remain — close warmly as this phase finishes.` : ''),
          }))
        : [
            { at: 0.6, text: 'The session is past its halfway point. Begin gently consolidating: reflect the main themes so far rather than opening new topics.' },
            { at: 0.85, text: `About ${minutesLeftAt(0.85)} minutes remain. Begin winding down: summarize what was discussed, invite final thoughts, and close warmly.` },
          ];
    phases.sort((a, b) => a.at - b.at);

    for (const phase of phases) {
      const delay = totalMs * phase.at - elapsedMs;
      if (delay <= 0) continue;
      const timer = setTimeout(() => {
        this.tryInject(sessionId, 'system', phase.text, false)
          .then(ok => ok && console.log(`[Live] Phase nudge (${phase.at * 100}%) sent to ${sessionId.substring(0, 12)}...`))
          .catch(err => console.error('[Live] Phase nudge failed:', err));
      }, delay);
      timer.unref?.();
      state.phaseTimers.push(timer);
    }
    if (state.phaseTimers.length > 0) {
      console.log(`[Live] Scheduled ${state.phaseTimers.length} phase nudge(s) for ${sessionId.substring(0, 12)}...`);
    }
  }

  /**
   * Arm mid-session re-grounding. Opt-in: disabled unless
   * features.regrounding_enabled === true, matching the Realtime behaviour.
   * Idempotent per session.
   */
  private async scheduleRegrounding(sessionId: string): Promise<void> {
    const state = this.sessions.get(sessionId);
    if (!state || state.regrounding) return;

    const { getSystemConfig } = await import('../utils/sessionHelpers.js');
    const config = await getSystemConfig();
    const features = (config.features ?? {}) as {
      regrounding_enabled?: boolean;
      regrounding_interval_minutes?: number;
    };
    if (features.regrounding_enabled !== true) return;

    const minutes = typeof features.regrounding_interval_minutes === 'number'
      && features.regrounding_interval_minutes > 0
      ? features.regrounding_interval_minutes
      : 5;

    const timer = setInterval(() => {
      this.runRegroundingSummary(sessionId).catch(err =>
        console.error(`[Live] Re-grounding summary failed for ${sessionId.substring(0, 12)}...:`, err));
    }, minutes * 60 * 1000);
    timer.unref?.();
    state.regrounding = timer;
    console.log(`[Live] Scheduled re-grounding every ${minutes}min for ${sessionId.substring(0, 12)}...`);
  }

  /** Clear every per-session timer. Shared by close and disconnect. */
  private clearTimers(state: LiveSessionState): void {
    if (state.keepalive) clearInterval(state.keepalive);
    if (state.regrounding) clearInterval(state.regrounding);
    if (state.toolChoiceReset) clearTimeout(state.toolChoiceReset);
    state.phaseTimers.forEach(t => clearTimeout(t));
    state.keepalive = null;
    state.regrounding = null;
    state.toolChoiceReset = null;
    state.phaseTimers = [];
  }

  // -------------------------------------------------------------------------
  // Teardown
  // -------------------------------------------------------------------------

  private async persistUsage(
    sessionId: string,
    opts: { finalized: boolean; closeReason?: string | null },
  ): Promise<void> {
    const state = this.sessions.get(sessionId);
    if (!state) return;
    const { recordLiveUsage } = await import('../db/liveUsage.queries.js');
    await recordLiveUsage(sessionId, state.model, state.lastUsageSeconds, {
      finalized: opts.finalized,
      closeReason: opts.closeReason ?? null,
      contextRatio: state.peakContextRatio || null,
    });
  }

  private async handleError(sessionId: string, error: Error): Promise<void> {
    console.error(`[Live] WebSocket error for ${sessionId.substring(0, 12)}...:`, error.message);
    await pool.query(
      'UPDATE therapy_sessions SET sideband_error = $1 WHERE session_id = $2',
      [error.message, sessionId],
    ).catch(() => {});
    if (global.io) {
      void broadcastAdminEventForSession(global.io, 'sideband:status-update', {
        sessionId, status: 'error', error: error.message, timestamp: new Date(),
      }, sessionId);
    }
  }

  private async handleClose(sessionId: string, code: number, reason: Buffer): Promise<void> {
    console.log(`[Live] Sideband closed for ${sessionId.substring(0, 12)}...: ${code} - ${reason || 'no reason'}`);
    const state = this.sessions.get(sessionId);

    // Flush pending fragments before losing them with the connection.
    state?.userTranscript.flush();
    state?.assistantTranscript.flush();

    // If the socket dropped before session.closed, the duration we hold is the
    // last in-flight snapshot and is formally unconfirmed. Persist it anyway so
    // the session isn't billed as zero, but leave finalized = false so the cost
    // dashboard can report it as provisional.
    if (state && !state.finalized) {
      await this.persistUsage(sessionId, { finalized: false });
    }

    if (state) this.clearTimers(state);
    this.sessions.delete(sessionId);

    await pool.query(
      `UPDATE therapy_sessions
          SET sideband_connected = FALSE, sideband_disconnected_at = CURRENT_TIMESTAMP
        WHERE session_id = $1`,
      [sessionId],
    ).catch(() => {});

    if (global.io) {
      void broadcastAdminEventForSession(global.io, 'sideband:disconnected', {
        sessionId, code, reason: reason?.toString(), disconnectedAt: new Date(),
      }, sessionId);
    }

    if (this.endedSessions.has(sessionId) || code === 1000 || !state) return;

    const status = await pool.query<{ status: string }>(
      'SELECT status FROM therapy_sessions WHERE session_id = $1', [sessionId],
    ).catch(() => null);
    if (status?.rows[0]?.status !== 'active') return;

    const attempts = state.reconnectAttempts;
    if (attempts >= this.maxReconnectAttempts) {
      console.error(`[Live] Max reconnection attempts reached for ${sessionId.substring(0, 12)}...`);
      await this.failClosedUnmonitored(
        sessionId, `sideband reconnect exhausted after ${this.maxReconnectAttempts} attempts`,
      );
      return;
    }
    const timer = setTimeout(() => {
      this.connect(sessionId, state.liveSessionId, state.apiKey, {
        model: state.model, backendModel: state.backendModel,
      }).then(() => {
        const next = this.sessions.get(sessionId);
        if (next) next.reconnectAttempts = attempts + 1;
      }).catch(err => console.error('[Live] Reconnection failed:', err));
    }, this.reconnectDelayMs * (attempts + 1));
    timer.unref?.();
  }

  /**
   * Close a session gracefully and collect final usage.
   *
   * Order matters and is prescribed by the docs: send session.close, then keep
   * reading until session.closed delivers the confirmed duration, and only then
   * tear down the socket. Closing the transport immediately after the command
   * can prevent the final event from ever arriving, leaving usage unconfirmed.
   */
  async disconnect(sessionId: string, opts: { graceMs?: number } = {}): Promise<void> {
    this.endedSessions.add(sessionId);
    if (this.endedSessions.size > 1000) {
      for (const id of this.endedSessions) {
        if (this.endedSessions.size <= 500) break;
        if (id === sessionId) continue;
        this.endedSessions.delete(id);
      }
    }

    const state = this.sessions.get(sessionId);
    if (!state) return;

    const graceMs = opts.graceMs ?? 5000;
    if (state.ws.readyState === WebSocket.OPEN && !state.finalized) {
      try {
        state.ws.send(JSON.stringify({ type: 'session.close', event_id: `close_${Date.now()}` }));
        await new Promise<void>(resolve => {
          const timer = setTimeout(() => {
            console.warn(`[Live] No session.closed within ${graceMs}ms for ${sessionId.substring(0, 12)}...; final usage unconfirmed.`);
            resolve();
          }, graceMs);
          timer.unref?.();
          const check = setInterval(() => {
            if (this.sessions.get(sessionId)?.finalized) {
              clearTimeout(timer); clearInterval(check); resolve();
            }
          }, 100);
          check.unref?.();
        });
      } catch (err) {
        console.error(`[Live] Graceful close failed for ${sessionId.substring(0, 12)}...:`, err);
      }
    }

    const current = this.sessions.get(sessionId);
    if (current) {
      // FLUSH before dispose. dispose() drops the buffer outright, so a
      // participant utterance still inside the 900ms gap window would be
      // discarded — never persisted, never crisis-scored. That is the most
      // likely moment for it to matter: the graceful-close path above waits on
      // session.closed, and if that times out we arrive here holding exactly
      // the last thing the participant said. handleClose already flushes;
      // this path did not.
      current.userTranscript.flush();
      current.assistantTranscript.flush();
      current.userTranscript.dispose();
      current.assistantTranscript.dispose();
      this.clearTimers(current);
      current.ws.close(1000, 'Session ended');
      this.sessions.delete(sessionId);
      this.attachSeqs.delete(sessionId);
    }
  }

  /**
   * Re-attach sidebands orphaned by a deploy. Mirrors the Realtime manager's
   * reattachActiveSessions, keyed on openai_live_session_id so the two
   * namespaces never cross.
   */
  async reattachActiveSessions(apiKey: string): Promise<{ attempted: number }> {
    const { isLiveModel, LIVE_DEFAULT_BACKEND_MODEL } = await import('../utils/liveSessionConfig.js');
    const result = await pool.query<{
      session_id: string;
      openai_live_session_id: string;
      ai_model: string | null;
      live_backend_model: string | null;
    }>(
      `SELECT ts.session_id, ts.openai_live_session_id, sc.ai_model, sc.live_backend_model
         FROM therapy_sessions ts
         LEFT JOIN session_configurations sc ON sc.session_id = ts.session_id
        WHERE ts.status = 'active'
          AND ts.openai_live_session_id IS NOT NULL
          AND ts.created_at > NOW() - INTERVAL '2 hours'`,
    );

    for (const row of result.rows) {
      if (this.sessions.has(row.session_id)) continue;
      if (!isLiveModel(row.ai_model)) continue;
      console.log(`[Live] Re-attaching orphaned session ${row.session_id.substring(0, 12)}... after restart`);
      try {
        await this.connect(row.session_id, row.openai_live_session_id, apiKey, {
          model: row.ai_model!,
          // The backend the session was PINNED to, not the current default.
          // Re-attaching with today's default would mis-attribute delegated
          // token usage and run re-grounding on a model the session never used.
          backendModel: row.live_backend_model ?? LIVE_DEFAULT_BACKEND_MODEL,
        });
      } catch (err) {
        console.error(`[Live] Re-attach failed for ${row.session_id.substring(0, 12)}...:`,
          err instanceof Error ? err.message : err);
      }
    }
    return { attempted: result.rows.length };
  }

  private async logConnectionError(sessionId: string, error: unknown): Promise<void> {
    const message = error instanceof Error ? error.message : String(error);
    await pool.query(
      'UPDATE therapy_sessions SET sideband_error = $1, sideband_connected = FALSE WHERE session_id = $2',
      [message, sessionId],
    ).catch(err => console.error('[Live] Failed to log connection error:', err));
  }

  private async logError(sessionId: string, error: unknown): Promise<void> {
    const message = typeof error === 'string' ? error
      : error instanceof Error ? error.message : JSON.stringify(error);
    await pool.query(
      'UPDATE therapy_sessions SET sideband_error = $1 WHERE session_id = $2',
      [message, sessionId],
    ).catch(err => console.error('[Live] Failed to log error:', err));
  }

  /**
   * Sessions with a LIVE sideband socket.
   *
   * Filters on readyState, not map membership. A session is in `this.sessions`
   * from the moment connect() is called until 'close' fires, so returning raw
   * keys reported sessions whose socket was still CONNECTING or already
   * CLOSING as usable. Callers treat this as "can I steer this session", and
   * every one of them then calls a method that throws unless the socket is
   * OPEN — so the gap produced steers that consumed their cooldown, threw, and
   * were recorded as neither delivered nor undelivered.
   */
  getActiveConnections(): string[] {
    return Array.from(this.sessions.entries())
      .filter(([, state]) => state.ws.readyState === WebSocket.OPEN)
      .map(([sessionId]) => sessionId);
  }

  isConnected(sessionId: string): boolean {
    const state = this.sessions.get(sessionId);
    return !!state && state.ws.readyState === WebSocket.OPEN;
  }

  /** Latest known cumulative voice seconds, or null when not tracked. */
  getUsageSeconds(sessionId: string): number | null {
    return this.sessions.get(sessionId)?.lastUsageSeconds ?? null;
  }

  async shutdown(): Promise<void> {
    console.log('[Live] Shutting down all Live sideband connections...');
    for (const sessionId of Array.from(this.sessions.keys())) {
      // No graceful close on shutdown: the process is going away and waiting on
      // session.closed for every session would stall the shutdown.
      await this.disconnect(sessionId, { graceMs: 0 });
    }
    console.log('[Live] All Live connections closed');
  }
}

/**
 * Clamp append content to the API's 500-token limit. Uses a conservative
 * characters-per-token heuristic rather than a tokenizer: the cost of being
 * slightly under is a few truncated words, while the cost of being over is a
 * rejected event — and these events carry crisis steering.
 */
function truncateForAppend(content: string): string {
  const MAX_CHARS = 1600; // ~500 tokens at a deliberately pessimistic 3.2 chars/token
  if (content.length <= MAX_CHARS) return content;
  console.warn(`[Live] Append content truncated from ${content.length} to ${MAX_CHARS} chars.`);
  return content.slice(0, MAX_CHARS);
}

export const sidebandManager = new SidebandManager();
