/**
 * Grok Voice proxy manager (docs/grok-voice.md).
 *
 * xAI's Grok Voice Agent speaks the OpenAI Realtime dialect over a single
 * WebSocket — and ONLY a single WebSocket. There is no WebRTC leg the browser
 * could own and no "attach" endpoint for a server-side observer, which is the
 * shape GPT-Live gave us. So the server sits in the middle:
 *
 *   browser  ──(PCM16 frames + JSON control)──▶  this process  ──(xAI realtime)──▶  api.x.ai
 *
 * Every participant utterance and every model event passes through here, which
 * is what makes the voice path monitorable: transcripts are persisted, each
 * user turn is scored by runCrisisPipeline, tools execute server-side, usage is
 * metered, and every steer (crisis guidance, phase nudges, admin messages) is
 * injected from this side. The browser holds no credential and has no way to
 * steer the model — see shared/grokVoiceProtocol.ts.
 *
 * Protocol facts below were verified against the live API on 2026-09-20 (see
 * the probe transcript in the flightdeck decision for ai-therapist-244):
 *   - `session.created` reports the RESOLVED model (grok-voice-think-fast-2.0
 *     for the grok-voice-latest alias); it is pinned to the session.
 *   - user speech arrives whole: `conversation.item.input_audio_transcription
 *     .completed` with an item id — no fragment assembly needed.
 *   - assistant speech streams as `response.output_audio_transcript.delta` and
 *     finishes with `.done` carrying the full transcript.
 *   - `response.done` carries per-response token counts AND a CUMULATIVE
 *     `usage.billable_audio_seconds` for the session — assign, never sum.
 *   - `response.function_call_arguments.done` carries name + call_id; the
 *     result goes back as a function_call_output item followed by one
 *     `response.create` once every outstanding call has a result.
 *   - system-role `conversation.item.create` + `response.create` steers the
 *     model and makes it speak. `session.update` works mid-session.
 *
 * Public surface matches SidebandManager's control methods (VoiceSidebandDelegate)
 * so the ~20 existing call sites keep working unchanged through delegation.
 */

import WebSocket from 'ws';
import { pool } from '../config/db.js';
import { insertMessagesBatch } from '../db/index.js';
import { broadcastAdminEventForSession } from '../utils/adminBroadcast.js';
import { grokRealtimeUrl } from '../utils/grokVoiceConfig.js';
import {
  GROK_DEFAULT_REFUSAL_GUARD, GROK_REFUSAL_STEER, GrokRefusalDetector,
  buildGrokRefusalRecoveryLine, type GrokRefusalGuardConfig,
} from '../utils/grokRefusalGuard.js';
import type { VoiceSidebandDelegate } from './sidebandManager.service.js';
import type { GrokServerMessage } from '../../shared/grokVoiceProtocol.js';

/** What the session route hands over before the browser's socket arrives. */
export interface PendingGrokSession {
  /** Configured alias, e.g. grok-voice-latest. */
  model: string;
  apiKey: string;
  /** The `session` object for the first session.update. */
  sessionConfig: Record<string, unknown>;
  /** Server-authored opening line, injected once the session is configured. */
  openingPrompt: string | null;
  /** Refusal-loop thresholds (system_config.grok_refusal_guard); defaults when omitted. */
  refusalGuard?: GrokRefusalGuardConfig;
  /** Server-authored line delivered when a refusal loop survives the steer. */
  recoveryLine?: string;
}

interface GrokSessionState {
  model: string;
  /** Model id as reported by session.created; null until then. */
  resolvedModel: string | null;
  apiKey: string;
  sessionConfig: Record<string, unknown>;
  openingPrompt: string | null;
  upstream: WebSocket | null;
  client: WebSocket | null;
  /** session.updated seen: audio may flow. */
  ready: boolean;
  /** disconnect() was called; the session is over on our side. */
  ended: boolean;
  /** Latest CUMULATIVE billable seconds from response.done. */
  billableSeconds: number;
  /** Response ids already metered, so a replayed event can't double-bill. */
  meteredResponses: Set<string>;
  pendingCalls: Map<string, { name: string; args: string }>;
  /** Assistant transcript accumulated across deltas for the in-flight item. */
  assistantItemId: string | null;
  assistantText: string;
  /** Per-role turn counters for admin monitor row ids (see emitTranscript). */
  userTurnIndex: number;
  assistantTurnIndex: number;
  keepalive: NodeJS.Timeout | null;
  phaseTimers: NodeJS.Timeout[];
  /** Pending restore of tool_choice after an admin-forced tool. */
  toolChoicePinned: boolean;
  /** Ends the session if the browser never attaches / drops without ending. */
  orphanTimer: NodeJS.Timeout | null;
  /** A model response is in flight (response.created … response.done). */
  responseInFlight: boolean;
  /** Turn latency: when the participant stopped speaking, and first audio since. */
  lastSpeechStoppedAt: Date | null;
  firstOutputAt: Date | null;
  /** Consecutive-refusal counter for xAI's server-side moderation loop. */
  refusal: GrokRefusalDetector;
  /** Participant-facing text used when the steer does not break the loop. */
  recoveryLine: string;
}

export class GrokVoiceManager implements VoiceSidebandDelegate {
  private sessions = new Map<string, GrokSessionState>();
  /** Sessions that have ended. Never re-open: their upstream is gone. */
  private endedSessions = new Set<string>();

  private readonly keepaliveMs = 20_000;
  /** How long a created session may wait for the browser's socket. */
  private readonly pendingTtlMs = 45_000;
  /** After the browser drops without ending, how long before we end it. */
  private readonly clientLossGraceMs = 15_000;
  private readonly upstreamOpenTimeoutMs = 10_000;

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  /**
   * Register a session the route has created in the DB. Nothing is dialled yet:
   * the upstream socket opens when the browser attaches, so a start that dies
   * client-side (mic permission, closed tab) never bills xAI. If the browser
   * never shows up the session is ended server-side rather than left "active".
   */
  registerPending(sessionId: string, pending: PendingGrokSession): void {
    if (this.sessions.has(sessionId)) return;
    const state: GrokSessionState = {
      model: pending.model,
      resolvedModel: null,
      apiKey: pending.apiKey,
      sessionConfig: pending.sessionConfig,
      openingPrompt: pending.openingPrompt,
      upstream: null,
      client: null,
      ready: false,
      ended: false,
      billableSeconds: 0,
      meteredResponses: new Set(),
      pendingCalls: new Map(),
      assistantItemId: null,
      assistantText: '',
      userTurnIndex: 0,
      assistantTurnIndex: 0,
      keepalive: null,
      phaseTimers: [],
      toolChoicePinned: false,
      orphanTimer: null,
      responseInFlight: false,
      lastSpeechStoppedAt: null,
      firstOutputAt: null,
      refusal: new GrokRefusalDetector(pending.refusalGuard ?? GROK_DEFAULT_REFUSAL_GUARD),
      recoveryLine: pending.recoveryLine ?? buildGrokRefusalRecoveryLine(null),
    };
    this.sessions.set(sessionId, state);
    this.armOrphanTimer(sessionId, this.pendingTtlMs, 'client_never_connected');
  }

  /** The browser's socket for a registered session. */
  async attachClient(sessionId: string, client: WebSocket): Promise<void> {
    const state = this.sessions.get(sessionId);
    const short = sessionId.substring(0, 12);
    if (!state || state.ended || this.endedSessions.has(sessionId)) {
      console.warn(`[Grok] Client attach for unknown/ended session ${short}...; closing.`);
      client.close(4404, 'unknown session');
      return;
    }
    if (state.client && state.client.readyState === WebSocket.OPEN) {
      // One browser per session. A second tab replacing the first would leave
      // the first with a dead socket and no explanation; refuse instead.
      console.warn(`[Grok] Second client attach for ${short}... refused.`);
      client.close(4409, 'already attached');
      return;
    }
    this.clearOrphanTimer(state);
    state.client = client;

    client.on('message', (data, isBinary) => this.handleClientMessage(sessionId, data, isBinary));
    client.on('close', () => void this.handleClientClose(sessionId));
    client.on('error', err => console.error(`[Grok] Client socket error for ${short}...:`, err.message));

    try {
      await this.openUpstream(sessionId);
    } catch (err) {
      console.error(`[Grok] Upstream open FAILED for ${short}...:`, err instanceof Error ? err.message : err);
      this.sendToClient(sessionId, { type: 'error', message: 'Could not reach the voice service.' });
      await this.failClosed(sessionId, 'upstream_unavailable',
        'We could not connect to the voice service. Please try again in a moment.');
    }
  }

  private async openUpstream(sessionId: string): Promise<void> {
    const state = this.sessions.get(sessionId);
    if (!state) return;
    const short = sessionId.substring(0, 12);
    const ws = new WebSocket(grokRealtimeUrl(state.model), {
      headers: { Authorization: `Bearer ${state.apiKey}` },
    });
    state.upstream = ws;

    ws.on('message', data => void this.handleUpstreamMessage(sessionId, data));
    ws.on('error', err => void this.handleUpstreamError(sessionId, err));
    ws.on('close', (code, reason) => void this.handleUpstreamClose(sessionId, code, reason));
    ws.on('unexpected-response', (_req, res) => {
      let body = '';
      res.on('data', (chunk: Buffer) => { body += chunk.toString(); });
      res.on('end', () => {
        console.error(`[Grok] Upstream upgrade rejected: HTTP ${res.statusCode} for ${short}... — ${body || '(empty body)'}`);
        // ws only aborts the handshake itself when nothing listens for this
        // event; with a listener registered we must terminate explicitly or
        // the socket sits in CONNECTING and neither 'close' nor 'error' fires.
        try { ws.terminate(); } catch { /* already gone */ }
      });
    });

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { cleanup(); reject(new Error(`xAI socket did not open within ${this.upstreamOpenTimeoutMs}ms`)); }, this.upstreamOpenTimeoutMs);
      timer.unref?.();
      const onOpen = () => { cleanup(); resolve(); };
      const onFail = () => { cleanup(); reject(new Error('xAI socket closed before opening')); };
      const cleanup = () => { clearTimeout(timer); ws.off('open', onOpen); ws.off('close', onFail); ws.off('error', onFail); };
      ws.once('open', onOpen);
      ws.once('close', onFail);
      ws.once('error', onFail);
    });

    console.log(`[Grok] Upstream open for ${short}...; configuring session`);
    this.sendUpstream(sessionId, { type: 'session.update', session: state.sessionConfig });
    this.startKeepalive(sessionId);
  }

  // -------------------------------------------------------------------------
  // Browser -> server
  // -------------------------------------------------------------------------

  private handleClientMessage(sessionId: string, data: WebSocket.RawData, isBinary: boolean): void {
    const state = this.sessions.get(sessionId);
    if (!state || state.ended) return;

    if (isBinary) {
      // Microphone PCM. Dropped until the upstream session is configured —
      // audio appended before session.update would be interpreted in the
      // default format.
      if (!state.ready || !state.upstream || state.upstream.readyState !== WebSocket.OPEN) return;
      const buf = Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer);
      if (buf.length === 0) return;
      state.upstream.send(JSON.stringify({ type: 'input_audio_buffer.append', audio: buf.toString('base64') }));
      return;
    }

    let msg: { type?: string; on?: boolean };
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return;
    }
    switch (msg.type) {
      case 'end':
        // The participant pressed end. Stop billing immediately; the browser's
        // POST /end runs the rest of the teardown (and calls disconnect()).
        console.log(`[Grok] Client requested end for ${sessionId.substring(0, 12)}...`);
        this.closeUpstream(state, 1000, 'participant ended');
        break;
      case 'mic':
        if (global.io) {
          void broadcastAdminEventForSession(global.io, 'session:activity', {
            sessionId, lastActivity: new Date(), deltaMessages: 0, mic: msg.on === true,
          }, sessionId);
        }
        break;
      default:
        // No other client → server control exists by design.
        break;
    }
  }

  private async handleClientClose(sessionId: string): Promise<void> {
    const state = this.sessions.get(sessionId);
    if (!state) return;
    state.client = null;
    if (state.ended) return;
    console.log(`[Grok] Client socket closed for ${sessionId.substring(0, 12)}...`);
    // No browser means no microphone and nobody listening; keeping the xAI
    // session open would only bill. Close it now, then end the session unless
    // the client's own POST /end lands first (disconnect() no-ops the timer).
    this.closeUpstream(state, 1000, 'client disconnected');
    this.armOrphanTimer(sessionId, this.clientLossGraceMs, 'client_disconnected');
  }

  // -------------------------------------------------------------------------
  // xAI -> server
  // -------------------------------------------------------------------------

  private async handleUpstreamMessage(sessionId: string, data: WebSocket.RawData): Promise<void> {
    let event: { type: string; [key: string]: unknown };
    try {
      event = JSON.parse(data.toString());
    } catch (err) {
      console.error('[Grok] Upstream parse error:', err);
      return;
    }
    const noisy = new Set([
      'response.output_audio.delta',
      'response.output_audio_transcript.delta',
      'conversation.item.input_audio_transcription.updated',
      'ping',
    ]);
    if (!noisy.has(event.type)) {
      console.log(`[Grok] ${sessionId.substring(0, 12)}... Event: ${event.type}`);
    }
    try {
      await this.handleUpstreamEvent(sessionId, event);
    } catch (err) {
      console.error(`[Grok] Handler failed for ${event.type}:`, err);
    }
  }

  private async handleUpstreamEvent(sessionId: string, event: { type: string; [key: string]: unknown }): Promise<void> {
    const state = this.sessions.get(sessionId);
    if (!state) return;

    switch (event.type) {
      case 'session.created': {
        const session = event.session as { model?: string } | undefined;
        if (session?.model) {
          state.resolvedModel = session.model;
          // Model pinning (ai-therapist-61): record the exact model the alias
          // resolved to, so the session stays reproducible when xAI moves the
          // alias mid-study.
          await pool.query(
            'UPDATE session_configurations SET ai_model = $1 WHERE session_id = $2',
            [session.model, sessionId],
          ).catch(err => console.error('[Grok] Failed to pin resolved model:', err));
        }
        break;
      }

      case 'session.updated': {
        const first = !state.ready;
        state.ready = true;
        if (global.io) {
          void broadcastAdminEventForSession(global.io, 'session:openai-update', {
            sessionId, eventType: event.type, data: event,
          }, sessionId);
        }
        if (first) {
          this.sendToClient(sessionId, { type: 'ready', model: state.resolvedModel ?? state.model });
          await this.onSessionReady(sessionId);
        }
        break;
      }

      // --- Participant speech ---------------------------------------------
      case 'input_audio_buffer.speech_started':
        // Barge-in. The browser must drop queued playback or the participant
        // hears the assistant keep talking over them for a few seconds — and
        // the upstream reply is cancelled so no further audio follows.
        this.sendToClient(sessionId, { type: 'speech_started' });
        if (state.responseInFlight) {
          state.responseInFlight = false;
          try { this.sendUpstream(sessionId, { type: 'response.cancel' }); } catch { /* closing */ }
        }
        this.finalizeAssistantTurn(sessionId, 'interrupted');
        break;

      case 'input_audio_buffer.speech_stopped':
        // Start of the turn-latency clock (docs/grok-voice.md §7a).
        state.lastSpeechStoppedAt = new Date();
        state.firstOutputAt = null;
        break;

      case 'response.created':
        state.responseInFlight = true;
        break;

      case 'conversation.item.input_audio_transcription.updated': {
        // Cumulative in-progress transcript (xAI extension). Caption only.
        const itemId = typeof event.item_id === 'string' ? event.item_id : `user-${state.userTurnIndex}`;
        const text = typeof event.transcript === 'string' ? event.transcript : '';
        if (text) {
          this.sendToClient(sessionId, { type: 'transcript', role: 'user', itemId, text, final: false });
        }
        break;
      }

      case 'conversation.item.input_audio_transcription.completed': {
        const itemId = typeof event.item_id === 'string' ? event.item_id : `user-${state.userTurnIndex}`;
        const text = typeof event.transcript === 'string' ? event.transcript.trim() : '';
        if (text) this.onUserTurn(sessionId, itemId, text);
        break;
      }

      // --- Assistant speech -----------------------------------------------
      case 'response.output_audio.delta': {
        if (typeof event.delta !== 'string') break;
        if (!state.firstOutputAt) state.firstOutputAt = new Date();
        const client = state.client;
        if (client && client.readyState === WebSocket.OPEN) {
          client.send(Buffer.from(event.delta, 'base64'), { binary: true });
        }
        break;
      }

      case 'response.output_audio_transcript.delta': {
        const itemId = typeof event.item_id === 'string' ? event.item_id : null;
        const delta = typeof event.delta === 'string' ? event.delta : '';
        if (itemId && state.assistantItemId && state.assistantItemId !== itemId) {
          // A new item started before the previous one's .done arrived.
          this.finalizeAssistantTurn(sessionId, 'superseded');
        }
        state.assistantItemId = itemId ?? state.assistantItemId ?? `assistant-${state.assistantTurnIndex}`;
        state.assistantText += delta;
        this.emitTranscript(sessionId, { role: 'assistant', itemId: state.assistantItemId, text: delta, final: false });
        break;
      }

      case 'response.output_audio_transcript.done': {
        const itemId = typeof event.item_id === 'string' ? event.item_id : state.assistantItemId;
        const transcript = typeof event.transcript === 'string' ? event.transcript : state.assistantText;
        state.assistantItemId = itemId ?? state.assistantItemId;
        state.assistantText = transcript;
        this.finalizeAssistantTurn(sessionId, 'completed');
        break;
      }

      // --- Tools ----------------------------------------------------------
      case 'response.function_call_arguments.done': {
        const callId = typeof event.call_id === 'string' ? event.call_id : null;
        const name = typeof event.name === 'string' ? event.name : null;
        if (!callId || !name) break;
        state.pendingCalls.set(callId, { name, args: typeof event.arguments === 'string' ? event.arguments : '{}' });
        await this.executePendingCall(sessionId, callId);
        break;
      }

      // --- Usage ----------------------------------------------------------
      case 'response.done': {
        state.responseInFlight = false;
        await this.recordTurnLatency(sessionId);
        await this.meterResponse(sessionId, event);
        this.finalizeAssistantTurn(sessionId, 'response_done');
        this.sendToClient(sessionId, { type: 'response_done' });
        if (state.toolChoicePinned) {
          state.toolChoicePinned = false;
          try {
            this.sendUpstream(sessionId, { type: 'session.update', session: { tool_choice: 'auto' } });
          } catch (err) {
            console.error('[Grok] tool_choice reset failed:', err);
          }
        }
        break;
      }

      case 'error': {
        const err = event.error as { code?: string; message?: string; type?: string } | undefined;
        console.error(`[Grok] API error for ${sessionId.substring(0, 12)}...:`, err ?? event);
        await pool.query(
          'UPDATE therapy_sessions SET sideband_error = $1 WHERE session_id = $2',
          [err?.message ?? JSON.stringify(event).slice(0, 500), sessionId],
        ).catch(() => {});
        this.sendToClient(sessionId, { type: 'error', message: err?.message ?? 'Voice service error', code: err?.code ?? null });
        if (global.io) {
          void broadcastAdminEventForSession(global.io, 'sideband:error', { sessionId, error: err ?? event }, sessionId);
        }
        break;
      }

      default:
        break;
    }
  }

  /** The session is configured: mark it monitored and start the conversation. */
  private async onSessionReady(sessionId: string): Promise<void> {
    const state = this.sessions.get(sessionId);
    if (!state) return;
    try {
      await pool.query(
        `UPDATE therapy_sessions
            SET sideband_connected = TRUE, sideband_connected_at = CURRENT_TIMESTAMP, sideband_error = NULL
          WHERE session_id = $1`,
        [sessionId],
      );
    } catch (err) {
      console.error('[Grok] Failed to mark session monitored:', err);
    }
    if (global.io) {
      void broadcastAdminEventForSession(global.io, 'sideband:connected', {
        sessionId, callId: null, channel: 'grok', model: state.resolvedModel ?? state.model, connectedAt: new Date(),
      }, sessionId);
    }
    await this.schedulePhaseNudges(sessionId);

    if (state.openingPrompt) {
      try {
        await this.injectMessage(sessionId, 'system', state.openingPrompt, true);
      } catch (err) {
        console.error('[Grok] Opening prompt failed:', err);
      }
    }
    console.log(`[Grok] Session ready for ${sessionId.substring(0, 12)}... on ${state.resolvedModel ?? state.model}`);
  }

  // -------------------------------------------------------------------------
  // Turns
  // -------------------------------------------------------------------------

  /**
   * A complete participant turn. Persisted, surfaced, and — the safety-critical
   * join point — pushed through the shared crisis pipeline exactly as the
   * GPT-Live sideband does. Everything downstream is reused unchanged.
   */
  private onUserTurn(sessionId: string, itemId: string, text: string): void {
    const state = this.sessions.get(sessionId);
    if (state) state.userTurnIndex += 1;
    this.emitTranscript(sessionId, { role: 'user', itemId, text, final: true });

    void (async () => {
      let messageId: string | number | null = null;
      try {
        const inserted = await insertMessagesBatch([{
          session_id: sessionId,
          role: 'user',
          // 'voice' so analytics count this as a voice turn (see sidebandManager).
          message_type: 'voice',
          content: text,
          content_redacted: null,
          metadata: { channel: 'grok', item_id: itemId },
        }]);
        messageId = inserted?.[0]?.message_id ?? null;
      } catch (err) {
        console.error(`[Grok] Failed to persist user turn for ${sessionId.substring(0, 12)}...:`, err);
      }
      // Run the safety pipeline even if persistence failed — a DB outage must
      // never silently disable crisis detection. Channel 'realtime' selects
      // sideband-style steering delivery, which the delegate hook routes here.
      try {
        const { runCrisisPipeline } = await import('./crisisPipeline.service.js');
        await runCrisisPipeline({ sessionId, messageId, content: text }, 'realtime');
      } catch (err) {
        console.error(`[Grok] Crisis pipeline failed for ${sessionId.substring(0, 12)}...:`, err);
      }
    })();
  }

  /** Close out the in-flight assistant transcript, if any, as one turn. */
  private finalizeAssistantTurn(sessionId: string, why: string): void {
    const state = this.sessions.get(sessionId);
    if (!state) return;
    const text = state.assistantText.trim();
    const itemId = state.assistantItemId;
    state.assistantText = '';
    state.assistantItemId = null;
    if (!text || !itemId) return;

    state.assistantTurnIndex += 1;
    this.emitTranscript(sessionId, { role: 'assistant', itemId, text, final: true });
    void insertMessagesBatch([{
      session_id: sessionId,
      role: 'assistant',
      message_type: 'response',
      content: text,
      content_redacted: null,
      metadata: { channel: 'grok', item_id: itemId },
    }]).catch(err => console.error(`[Grok] Failed to persist assistant turn for ${sessionId.substring(0, 12)}...:`, err));

    // Only a turn the model actually finished says anything about a refusal
    // loop; a turn cut short by barge-in or teardown is truncated by us.
    if (why === 'completed' || why === 'response_done') this.checkRefusalLoop(sessionId, text);
  }

  // -------------------------------------------------------------------------
  // Refusal loops (ai-therapist-255)
  // -------------------------------------------------------------------------

  /**
   * xAI moderates server-side. When it trips, the model answers everything —
   * including "so is the session just over?" — with the same canned refusal,
   * and no prompt of ours can override it. Count the repeats and break the
   * loop: first a system steer, then, if that fails, a line we author
   * ourselves so the participant is never left with silence or a sixth "I
   * can't help with that". See utils/grokRefusalGuard.ts for the detector.
   */
  private checkRefusalLoop(sessionId: string, text: string): void {
    const state = this.sessions.get(sessionId);
    if (!state || state.ended) return;
    const action = state.refusal.observe(text);
    if (action === 'none') return;
    const streak = state.refusal.streak;
    // Reset here rather than after delivery: the next loop then escalates from
    // the top (steer, then recovery) instead of repeating our own line on every
    // further refusal, and the counter cannot drift while delivery awaits.
    if (action === 'recover') state.refusal.reset();
    void this.breakRefusalLoop(sessionId, action, text, streak).catch(err =>
      console.error(`[Grok] Refusal recovery failed for ${sessionId.substring(0, 12)}...:`, err));
  }

  private async breakRefusalLoop(
    sessionId: string, action: 'steer' | 'recover', refusalText: string, streak: number,
  ): Promise<void> {
    const state = this.sessions.get(sessionId);
    if (!state || state.ended) return;
    const short = sessionId.substring(0, 12);
    console.warn(`[Grok] Refusal loop for ${short}...: ${streak} in a row; action=${action}`);

    if (global.io) {
      void broadcastAdminEventForSession(global.io, 'sideband:status-update', {
        sessionId, status: 'refusal_loop', action, streak,
        error: `Model refused ${streak} turns in a row: ${refusalText.slice(0, 200)}`,
        timestamp: new Date(),
      }, sessionId);
    }

    if (action === 'steer') {
      // A forced response keeps the participant from sitting in silence while
      // the model re-reads its guidance.
      const delivered = await this.tryInject(sessionId, 'system', GROK_REFUSAL_STEER, true);
      if (!delivered) console.error(`[Grok] Refusal steer could not be delivered for ${short}...`);
      return;
    }

    // Second threshold: speak for ourselves. There is no server-side TTS on
    // this socket, so the line goes out on the transcript channel the browser
    // already renders, and is persisted like any assistant turn.
    const line = state.recoveryLine;
    state.assistantTurnIndex += 1;
    const itemId = `grok-recovery-${state.assistantTurnIndex}`;
    this.emitTranscript(sessionId, { role: 'assistant', itemId, text: line, final: true });
    await insertMessagesBatch([{
      session_id: sessionId,
      role: 'assistant',
      message_type: 'response',
      content: line,
      content_redacted: null,
      metadata: { channel: 'grok', item_id: itemId, server_authored: true, reason: 'refusal_loop' },
    }]).catch(err => console.error('[Grok] Failed to persist refusal recovery line:', err));

    // Visible to admins alongside crisis interventions.
    try {
      const { logInterventionAction } = await import('./crisisDetection.service.js');
      await logInterventionAction(sessionId, 'voice_refusal_recovery', {
        channel: 'grok', streak, refusal: refusalText.slice(0, 500), delivered: 'transcript',
      });
    } catch (err) {
      console.error('[Grok] Failed to log refusal intervention:', err);
    }

    // Re-steer without forcing a reply: the participant is reading our line.
    await this.tryInject(sessionId, 'system', GROK_REFUSAL_STEER, false);
  }

  /** Push a transcript fragment or a finalized turn to the browser and admins. */
  private emitTranscript(
    sessionId: string,
    payload: { role: 'user' | 'assistant'; itemId: string; text: string; final: boolean },
  ): void {
    this.sendToClient(sessionId, { type: 'transcript', ...payload });
    if (!global.io) return;
    // Same event shape the GPT-Live sideband emits, so LiveMonitoring needs no
    // changes: deltas accumulate on the row keyed by itemId, finals replace it.
    void broadcastAdminEventForSession(global.io, 'sideband:transcript', {
      sessionId,
      itemId: payload.itemId,
      role: payload.role,
      ...(payload.final ? { text: payload.text } : { delta: payload.text }),
      final: payload.final,
      timestamp: new Date(),
    }, sessionId);
    void broadcastAdminEventForSession(global.io, 'session:activity', {
      sessionId, lastActivity: new Date(), deltaMessages: payload.final ? 1 : 0,
    }, sessionId);
  }

  // -------------------------------------------------------------------------
  // Tools
  // -------------------------------------------------------------------------

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

    // UI-only notification: the browser opens the matching overlay. Execution
    // stays here, so the model receives exactly one result per call.
    this.sendToClient(sessionId, { type: 'tool_call', callId, name: call.name, args });

    await insertMessagesBatch([{
      session_id: sessionId,
      role: 'system',
      message_type: 'tool_call',
      content: `Tool called: ${call.name}`,
      content_redacted: null,
      metadata: { tool_name: call.name, call_id: callId, arguments: args, channel: 'grok', status: 'executing' },
    }]).catch(err => console.error('[Grok] Failed to log tool call:', err));

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
      this.sendUpstream(sessionId, {
        type: 'conversation.item.create',
        item: { type: 'function_call_output', call_id: callId, output: JSON.stringify(output ?? {}) },
      });
      // Per the xAI docs: no response.create until every outstanding call has
      // its output submitted.
      if (state.pendingCalls.size === 0) {
        this.sendUpstream(sessionId, { type: 'response.create' });
      }
    } catch (err) {
      console.error(`[Grok] Failed to return tool result for ${call.name}:`, err);
    }

    await insertMessagesBatch([{
      session_id: sessionId,
      role: 'system',
      message_type: 'tool_response',
      content: failure ? `Tool error: ${call.name}` : `Tool response: ${call.name}`,
      content_redacted: null,
      metadata: {
        tool_name: call.name, call_id: callId, channel: 'grok',
        ...(failure ? { error: failure, status: 'failed' } : { response: result, status: 'completed' }),
      },
    }]).catch(err => console.error('[Grok] Failed to log tool response:', err));

    if (global.io) {
      void broadcastAdminEventForSession(global.io, 'sideband:tool-call', {
        sessionId, callId, toolName: call.name, args,
        ...(failure ? { error: failure, status: 'failed' } : { result, status: 'completed' }),
        timestamp: new Date(),
      }, sessionId);
    }

    import('../db/index.js')
      .then(db => db.insertToolInvocation(sessionId, call.name, failure ? null : args, !failure))
      .catch(err => console.error('[Grok] Failed to log tool invocation:', err));
  }

  // -------------------------------------------------------------------------
  // Usage
  // -------------------------------------------------------------------------

  /**
   * Meter one response.done. Token counts are per response and recorded for
   * the research record; the money is `billable_audio_seconds`, which xAI
   * reports as a CUMULATIVE session total — it is assigned, never summed, and
   * lands in live_usage where the cost dashboard already prices per-minute
   * voice backends.
   */
  private async meterResponse(sessionId: string, event: { [key: string]: unknown }): Promise<void> {
    const state = this.sessions.get(sessionId);
    if (!state) return;
    const response = event.response as { id?: string } | undefined;
    const usage = event.usage as {
      input_tokens?: number; output_tokens?: number; billable_audio_seconds?: number;
    } | undefined;
    if (!usage) return;

    const model = state.resolvedModel ?? state.model;
    if (typeof usage.billable_audio_seconds === 'number') {
      state.billableSeconds = Math.max(state.billableSeconds, usage.billable_audio_seconds);
      const { recordLiveUsage } = await import('../db/liveUsage.queries.js');
      await recordLiveUsage(sessionId, model, state.billableSeconds, { finalized: false });
    }

    const responseId = response?.id;
    if (responseId && !state.meteredResponses.has(responseId)) {
      state.meteredResponses.add(responseId);
      const { recordLlmUsage } = await import('../db/index.js');
      await recordLlmUsage(sessionId, 'grok_voice', model, usage.input_tokens ?? null, usage.output_tokens ?? null);
    }
  }

  /**
   * Ground-truth turn latency for the study record and for tuning: the gap
   * from the participant's end of speech to the first audio byte (TTFA) and to
   * response.done. Only turns that follow a speech_stopped are measured, so
   * server-injected turns (opening line, steers, tool continuations) do not
   * pollute the numbers. Same table the GPT-Live/Realtime path used.
   */
  private async recordTurnLatency(sessionId: string): Promise<void> {
    const state = this.sessions.get(sessionId);
    if (!state?.lastSpeechStoppedAt) return;
    const userDoneAt = state.lastSpeechStoppedAt;
    const firstOutputAt = state.firstOutputAt;
    state.lastSpeechStoppedAt = null;
    state.firstOutputAt = null;
    try {
      const { insertTurnLatency } = await import('../db/latency.queries.js');
      await insertTurnLatency({
        sessionId, turnIndex: state.userTurnIndex, userDoneAt, firstOutputAt,
        responseDoneAt: new Date(), channel: 'realtime',
      });
    } catch (err) {
      console.error('[Grok] turn latency record failed:', err);
    }
  }

  private async persistFinalUsage(sessionId: string, closeReason: string | null): Promise<void> {
    const state = this.sessions.get(sessionId);
    if (!state) return;
    const { recordLiveUsage } = await import('../db/liveUsage.queries.js');
    await recordLiveUsage(sessionId, state.resolvedModel ?? state.model, state.billableSeconds, {
      finalized: true, closeReason,
    });
  }

  // -------------------------------------------------------------------------
  // Control surface (VoiceSidebandDelegate)
  // -------------------------------------------------------------------------

  owns(sessionId: string): boolean {
    return this.sessions.has(sessionId);
  }

  isConnected(sessionId: string): boolean {
    const state = this.sessions.get(sessionId);
    return !!state && !state.ended && state.ready && !!state.upstream && state.upstream.readyState === WebSocket.OPEN;
  }

  getActiveConnections(): string[] {
    return Array.from(this.sessions.keys()).filter(id => this.isConnected(id));
  }

  /** Latest cumulative billable seconds, or null when not tracked. */
  getUsageSeconds(sessionId: string): number | null {
    return this.sessions.get(sessionId)?.billableSeconds ?? null;
  }

  /** Forward a client event upstream. @throws if the session is not live. */
  sendUpstream(sessionId: string, event: Record<string, unknown>): void {
    const state = this.sessions.get(sessionId);
    if (!state || state.ended || !state.upstream || state.upstream.readyState !== WebSocket.OPEN) {
      throw new Error('Grok voice connection not active');
    }
    state.upstream.send(JSON.stringify(event));
    if (event.type !== 'input_audio_buffer.append') {
      console.log(`[Grok] Sent ${String(event.type)} for ${sessionId.substring(0, 12)}...`);
    }
  }

  /**
   * Insert a hidden conversation item and optionally make the model respond.
   * This is the Realtime-dialect steer: a system-role item is trusted guidance,
   * a user-role item speaks as the participant (admin "inject as user").
   */
  async injectMessage(sessionId: string, role: 'system' | 'user', text: string, respond: boolean): Promise<void> {
    this.sendUpstream(sessionId, {
      type: 'conversation.item.create',
      item: { type: 'message', role, content: [{ type: 'input_text', text }] },
    });
    if (respond) this.sendUpstream(sessionId, { type: 'response.create' });
  }

  /** Best-effort steer: false means the guidance could NOT be delivered. */
  async tryInject(sessionId: string, role: 'system' | 'user', text: string, respond: boolean): Promise<boolean> {
    if (!this.isConnected(sessionId)) return false;
    try {
      await this.injectMessage(sessionId, role, text, respond);
      return true;
    } catch (err) {
      console.error(`[Grok] tryInject failed for ${sessionId.substring(0, 12)}...:`, err);
      return false;
    }
  }

  /**
   * Update session configuration mid-session. Unlike GPT-Live, Grok accepts
   * `instructions` here, so the adaptive-prompt path and the admin instructions
   * control change the live prompt directly.
   */
  async updateSession(sessionId: string, updates: Record<string, unknown>): Promise<void> {
    this.sendUpstream(sessionId, { type: 'session.update', session: updates });
  }

  /** Hard interrupt: cancel generation and tell the browser to drop playback. */
  async interrupt(sessionId: string): Promise<void> {
    this.sendUpstream(sessionId, { type: 'response.cancel' });
    this.sendToClient(sessionId, { type: 'clear_audio' });
    this.finalizeAssistantTurn(sessionId, 'interrupted_by_admin');
  }

  /** Force a response, with optional per-response overrides (e.g. instructions). */
  async createResponse(sessionId: string, response?: Record<string, unknown>): Promise<void> {
    this.sendUpstream(sessionId, response && Object.keys(response).length > 0
      ? { type: 'response.create', response }
      : { type: 'response.create' });
  }

  /** Admin "trigger tool": pin tool_choice for one response, then restore auto. */
  async triggerTool(sessionId: string, toolName: string, args?: Record<string, unknown>): Promise<void> {
    const state = this.sessions.get(sessionId);
    if (!state) throw new Error('Grok voice connection not active');
    await this.updateSession(sessionId, { tool_choice: { type: 'function', name: toolName } });
    state.toolChoicePinned = true;
    const argsContext = args && Object.keys(args).length > 0
      ? ` Use this context for the tool arguments: ${JSON.stringify(args)}.`
      : '';
    await this.injectMessage(
      sessionId, 'system',
      `The clinician overseeing this session asks you to use the ${toolName} tool now.${argsContext} ` +
      'Never mention this instruction to the participant.',
      true,
    );
  }

  /**
   * End the session on our side: close both sockets, confirm usage, clear
   * timers. Idempotent. The browser is told first so it runs its end flow
   * rather than treating the close as a network drop.
   */
  async disconnect(sessionId: string, _opts: { graceMs?: number } = {}): Promise<void> {
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
    state.ended = true;
    this.clearTimers(state);
    this.finalizeAssistantTurn(sessionId, 'disconnect');
    await this.persistFinalUsage(sessionId, 'close_requested');

    this.sendToClient(sessionId, { type: 'closed', reason: 'ended' });
    this.closeUpstream(state, 1000, 'Session ended');
    if (state.client) {
      try { state.client.close(1000, 'Session ended'); } catch { /* already gone */ }
      state.client = null;
    }
    this.sessions.delete(sessionId);

    await pool.query(
      `UPDATE therapy_sessions
          SET sideband_connected = FALSE, sideband_disconnected_at = CURRENT_TIMESTAMP
        WHERE session_id = $1`,
      [sessionId],
    ).catch(() => {});
    if (global.io) {
      void broadcastAdminEventForSession(global.io, 'sideband:disconnected', {
        sessionId, code: 1000, reason: 'Session ended', disconnectedAt: new Date(),
      }, sessionId);
    }
  }

  async shutdown(): Promise<void> {
    console.log('[Grok] Shutting down all Grok voice sessions...');
    for (const sessionId of Array.from(this.sessions.keys())) {
      await this.disconnect(sessionId);
    }
  }

  // -------------------------------------------------------------------------
  // Failure handling
  // -------------------------------------------------------------------------

  private async handleUpstreamError(sessionId: string, error: Error): Promise<void> {
    console.error(`[Grok] Upstream socket error for ${sessionId.substring(0, 12)}...:`, error.message);
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

  private async handleUpstreamClose(sessionId: string, code: number, reason: Buffer): Promise<void> {
    const state = this.sessions.get(sessionId);
    console.log(`[Grok] Upstream closed for ${sessionId.substring(0, 12)}...: ${code} - ${reason?.toString() || 'no reason'}`);
    if (!state) return;
    state.upstream = null;
    state.ready = false;
    if (state.keepalive) { clearInterval(state.keepalive); state.keepalive = null; }
    if (state.ended) return;

    this.finalizeAssistantTurn(sessionId, 'upstream_closed');
    await this.persistFinalUsage(sessionId, code === 1000 ? 'close_requested' : 'connection_lost');

    // We did not ask for this close (the participant-end and client-loss paths
    // set the state before closing). The conversation cannot continue and there
    // is no monitoring without the upstream, so fail closed: end the session
    // and tell the participant why. (xAI's session resumption cache is a
    // follow-up — see docs/grok-voice.md.)
    if (code !== 1000) {
      await this.failClosed(sessionId, 'upstream_lost',
        'The connection to the voice service was lost. Nothing you shared was lost. ' +
        'You can start a new session whenever you are ready.');
    }
  }

  /** End an active session that can no longer be conducted or monitored. */
  private async failClosed(sessionId: string, reason: string, message: string): Promise<void> {
    const state = this.sessions.get(sessionId);
    if (!state || state.ended) return;
    this.sendToClient(sessionId, { type: 'closed', reason });
    if (global.io) {
      void broadcastAdminEventForSession(global.io, 'sideband:unmonitored', {
        sessionId, reason, endedAt: new Date(),
      }, sessionId);
    }
    try {
      const { serverEndSession } = await import('./sessionLifecycle.service.js');
      // serverEndSession calls sidebandManager.disconnect → delegates back to
      // disconnect() above, which tears down whatever is left.
      await serverEndSession(sessionId, { endedBy: 'system', reason, message });
    } catch (err) {
      console.error(`[Grok] failClosed failed for ${sessionId.substring(0, 12)}...:`, err);
    }
    // serverEndSession no-ops on already-ended rows; make sure our state goes.
    if (this.sessions.has(sessionId)) await this.disconnect(sessionId);
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  private sendToClient(sessionId: string, msg: GrokServerMessage): void {
    const client = this.sessions.get(sessionId)?.client;
    if (client && client.readyState === WebSocket.OPEN) {
      try { client.send(JSON.stringify(msg)); } catch (err) {
        console.error(`[Grok] Client send failed for ${sessionId.substring(0, 12)}...:`, err);
      }
    }
  }

  private closeUpstream(state: GrokSessionState, code: number, reason: string): void {
    const ws = state.upstream;
    if (!ws) return;
    state.upstream = null;
    state.ready = false;
    if (state.keepalive) { clearInterval(state.keepalive); state.keepalive = null; }
    try {
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) ws.close(code, reason);
    } catch { /* already gone */ }
  }

  private startKeepalive(sessionId: string): void {
    const state = this.sessions.get(sessionId);
    if (!state) return;
    if (state.keepalive) clearInterval(state.keepalive);
    const timer = setInterval(() => {
      const s = this.sessions.get(sessionId);
      if (s?.upstream && s.upstream.readyState === WebSocket.OPEN) {
        try { s.upstream.ping(); } catch { /* ignore */ }
      } else {
        clearInterval(timer);
      }
    }, this.keepaliveMs);
    timer.unref?.();
    state.keepalive = timer;
  }

  private armOrphanTimer(sessionId: string, delayMs: number, reason: string): void {
    const state = this.sessions.get(sessionId);
    if (!state) return;
    this.clearOrphanTimer(state);
    const timer = setTimeout(() => {
      const s = this.sessions.get(sessionId);
      if (!s || s.ended) return;
      if (s.client && s.client.readyState === WebSocket.OPEN) return; // reattached in time
      console.warn(`[Grok] Session ${sessionId.substring(0, 12)}... orphaned (${reason}); ending it.`);
      void this.failClosed(sessionId, reason,
        'Your session ended because the connection to our server was lost. Nothing you shared was lost.');
    }, delayMs);
    timer.unref?.();
    state.orphanTimer = timer;
  }

  private clearOrphanTimer(state: GrokSessionState): void {
    if (state.orphanTimer) { clearTimeout(state.orphanTimer); state.orphanTimer = null; }
  }

  private async schedulePhaseNudges(sessionId: string): Promise<void> {
    const state = this.sessions.get(sessionId);
    if (!state || state.phaseTimers.length > 0) return;
    try {
      const { buildPhaseNudgeSchedule } = await import('../utils/phaseGuidance.js');
      for (const phase of await buildPhaseNudgeSchedule(sessionId)) {
        const timer = setTimeout(() => {
          this.tryInject(sessionId, 'system', phase.text, false)
            .then(ok => ok && console.log(`[Grok] Phase nudge (${phase.at * 100}%) sent to ${sessionId.substring(0, 12)}...`))
            .catch(err => console.error('[Grok] Phase nudge failed:', err));
        }, phase.delayMs);
        timer.unref?.();
        state.phaseTimers.push(timer);
      }
    } catch (err) {
      console.error('[Grok] Phase nudge scheduling failed:', err);
    }
  }

  private clearTimers(state: GrokSessionState): void {
    if (state.keepalive) clearInterval(state.keepalive);
    state.phaseTimers.forEach(t => clearTimeout(t));
    this.clearOrphanTimer(state);
    state.keepalive = null;
    state.phaseTimers = [];
  }
}

export const grokVoiceManager = new GrokVoiceManager();
