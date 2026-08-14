/**
 * Sideband WebSocket Manager
 * Manages server-side WebSocket connections to OpenAI Realtime API for monitoring and control
 */

import WebSocket from 'ws';
import { pool } from '../config/db.js';
import { insertMessagesBatch } from '../db/index.js';

export class SidebandManager {
  private connections: Map<string, WebSocket>;
  private reconnectAttempts: Map<string, number>;
  // Per-session key used to authenticate the sideband WS. Since ai-therapist-62
  // this is the STANDARD API key (per OpenAI's server-side-controls docs),
  // which never expires — so mid-session reconnects keep working. Stored per
  // session so reconnects reuse exactly what the initial attach used (which may
  // be the ephemeral fallback if the standard key was rejected live).
  private sessionKeys: Map<string, string>;
  // Per-session keepalive timer. The sideband is a passive observer that can sit
  // idle for long stretches; without periodic pings the socket gets reaped and
  // closes with code 1006. We ping every keepaliveMs to keep it warm.
  private pingIntervals: Map<string, NodeJS.Timeout>;
  // Session-phase nudge timers (ai-therapist-43): wall-clock timers that steer
  // the model through consolidation → wind-down as the session's max duration
  // approaches. Survive WS reconnects; cleared on session disconnect.
  private phaseTimers: Map<string, NodeJS.Timeout[]>;
  // Mid-session re-grounding interval timers (ai-therapist-49): periodically
  // runs an out-of-band summarization response and injects a compact invisible
  // recap. Config-gated (off by default); cleared on disconnect like the
  // other timers.
  private regroundingTimers: Map<string, NodeJS.Timeout>;
  // Sessions that have been ended/finalized (via disconnect()). Once a session is
  // here, we must NOT attempt any (re)attach for it — the OpenAI call_id is gone,
  // so retries just spam 404 "No session found for the provided call_id". Guards
  // both the post-1006 reconnect path and the call-not-registered attach retry.
  private endedSessions: Set<string>;
  // hold_floor timers (ai-therapist-102): while a hold is active, semantic VAD
  // is disabled via session.update so the participant can't barge in; the timer
  // restores it. Cleared/restored on session end so a hold can never outlive
  // its session.
  private holdFloorTimers: Map<string, NodeJS.Timeout>;
  // Admin trigger-tool resets (ai-therapist-103): after forcing
  // tool_choice: { type:'function', ... }, the next response.done for the
  // session flips tool_choice back to 'auto'; the timer is a 30s fallback so a
  // dropped response can't leave the session stuck in forced-tool mode.
  private pendingToolChoiceResets: Map<string, NodeJS.Timeout>;
  // Turn-latency capture (telemetry pass 3): the timestamp of the last
  // completed user transcription plus the first output delta seen since. On
  // response.done the pair becomes one turn_latency row (fire-and-forget).
  // Tool-call-only responses keep the turn pending so the eventual audible
  // response is what gets measured; a response.done with no pending user turn
  // (e.g. the post-tool second response, or an admin-triggered response) is
  // skipped entirely.
  private pendingTurns: Map<string, { userDoneAt: Date; firstOutputAt: Date | null }>;
  private turnCounters: Map<string, number>;
  private maxReconnectAttempts: number;
  private reconnectDelayMs: number;
  private keepaliveMs: number;
  private toolChoiceResetFallbackMs: number;

  constructor() {
    this.connections = new Map(); // sessionId → WebSocket
    this.reconnectAttempts = new Map(); // sessionId → attempt count
    this.sessionKeys = new Map(); // sessionId → ephemeral key
    this.pingIntervals = new Map(); // sessionId → keepalive timer
    this.phaseTimers = new Map(); // sessionId → phase nudge timers
    this.regroundingTimers = new Map(); // sessionId → re-grounding interval timer
    this.endedSessions = new Set(); // sessionIds that ended — never reattach
    this.holdFloorTimers = new Map(); // sessionId → hold_floor restore timer
    this.pendingToolChoiceResets = new Map(); // sessionId → tool_choice reset fallback timer
    this.pendingTurns = new Map(); // sessionId → in-flight turn-latency state
    this.turnCounters = new Map(); // sessionId → measured-turn counter
    this.maxReconnectAttempts = 3;
    this.reconnectDelayMs = 2000;
    this.keepaliveMs = 20000;
    this.toolChoiceResetFallbackMs = 30000;
  }

  /**
   * Establish sideband WebSocket connection for a session
   * @param {string} sessionId - Therapy session ID
   * @param {string} callId - OpenAI call_id from Location header
   * @param {string} apiKey - OpenAI API key (standard key; see ai-therapist-62)
   * @param {number} attempt - internal retry counter for the call-not-yet-registered race
   * @param {string} [fallbackKey] - optional per-session ephemeral key, tried
   *   once if the standard key is rejected outright (401/403) — diagnostics
   *   safety net until standard-key sideband auth is verified live.
   * @returns {Promise<WebSocket>} - The WebSocket connection
   */
  async connect(sessionId: string, callId: string, apiKey: string, attempt = 0, fallbackKey?: string): Promise<WebSocket> {
    // Never (re)attach for a session that has already ended — the call_id is gone
    // and every attempt just yields 404 call-not-found spam. A fresh initial
    // attach (attempt 0) clears any stale ended flag for a reused sessionId.
    if (attempt === 0) {
      this.endedSessions.delete(sessionId);
    } else if (this.endedSessions.has(sessionId)) {
      console.log(`[Sideband] Session ${sessionId.substring(0, 12)}... has ended; skipping attach retry.`);
      throw new Error('Session ended; sideband attach aborted');
    }

    // Check if already connected
    if (this.connections.has(sessionId)) {
      console.warn(`[Sideband] Already connected for session ${sessionId.substring(0, 12)}...`);
      return this.connections.get(sessionId)!;
    }

    const wsUrl = `wss://api.openai.com/v1/realtime?call_id=${callId}`;
    console.log(`[Sideband] Attaching to ${wsUrl} (attempt ${attempt + 1})`);

    try {
      const ws = new WebSocket(wsUrl, {
        headers: {
          'Authorization': `Bearer ${apiKey}`
        }
      });

      // Setup event handlers
      ws.on('open', () => this.handleOpen(sessionId, callId));
      ws.on('message', (data) => this.handleMessage(sessionId, data));
      ws.on('error', (error) => this.handleError(sessionId, error));
      ws.on('close', (code, reason) => this.handleClose(sessionId, code, reason));

      // The WS upgrade can be rejected with a normal HTTP response (e.g. a 404
      // when the call_id is unknown). The 'error' event only gives a generic
      // message for these, so capture the real status + body here — this is the
      // diagnostic that was missing when the feature was first shelved.
      ws.on('unexpected-response', (_req, res) => {
        let body = '';
        res.on('data', (chunk: Buffer) => { body += chunk.toString(); });
        res.on('end', () => {
          const detail = `Sideband upgrade rejected: HTTP ${res.statusCode} for call_id=${callId} — ${body || '(empty body)'}`;
          console.error(`[Sideband] ${detail}`);
          this.connections.delete(sessionId);

          // A 404 call_id_not_found right after the call starts usually means the
          // Realtime session isn't registered yet (the WebRTC connection is still
          // finishing negotiation). Retry a few times before giving up.
          // If the session ended while an attach was in flight, stop retrying —
          // the call_id is gone for good, so further 404 retries are pure spam.
          if (this.endedSessions.has(sessionId)) {
            console.log(`[Sideband] Session ${sessionId.substring(0, 12)}... ended; abandoning attach retries.`);
            return;
          }

          const callNotReady = res.statusCode === 404 && body.includes('call_id_not_found');
          if (callNotReady && attempt < this.maxReconnectAttempts) {
            const delay = this.reconnectDelayMs * (attempt + 1);
            console.log(`[Sideband] call_id not registered yet; retrying attach in ${delay}ms (attempt ${attempt + 2}/${this.maxReconnectAttempts + 1})`);
            setTimeout(() => {
              this.connect(sessionId, callId, apiKey, attempt + 1, fallbackKey).catch(() => {});
            }, delay);
            return;
          }

          // Current key rejected: either an outright auth failure (401/403 —
          // e.g. an expired ephemeral key on a late reconnect) or 404 retries
          // exhausted (live-verified 2026-07-31: a key with the wrong project
          // scope gets call_id_not_found for the whole call, not just during
          // the registration race). Try the other key once.
          const retriesExhausted = callNotReady && attempt >= this.maxReconnectAttempts;
          if ((res.statusCode === 401 || res.statusCode === 403 || retriesExhausted) && fallbackKey && fallbackKey !== apiKey) {
            console.error(`[Sideband] Key rejected (HTTP ${res.statusCode}) for call_id=${callId}; retrying with the alternate key. Body: ${body || '(empty)'}`);
            this.connect(sessionId, callId, fallbackKey, 0).catch(() => {});
            return;
          }

          this.logConnectionError(sessionId, new Error(detail)).catch(() => {});
          if (global.io) {
            global.io.to('admin-broadcast').emit('sideband:error', {
              sessionId,
              error: detail,
              statusCode: res.statusCode,
            });
          }
        });
      });

      this.connections.set(sessionId, ws);
      this.reconnectAttempts.set(sessionId, 0);
      this.sessionKeys.set(sessionId, apiKey);

      console.log(`[Sideband] Socket opened for session ${sessionId.substring(0, 12)}... (awaiting upgrade)`);
      return ws;

    } catch (error) {
      console.error(`[Sideband] Connection failed for session ${sessionId}:`, error);
      await this.logConnectionError(sessionId, error);
      throw error;
    }
  }

  /**
   * Handle WebSocket open event
   */
  async handleOpen(sessionId: string, callId: string): Promise<void> {
    try {
      // Update database
      await pool.query(
        `UPDATE therapy_sessions
         SET openai_call_id = $1,
             sideband_connected = TRUE,
             sideband_connected_at = CURRENT_TIMESTAMP,
             sideband_error = NULL
         WHERE session_id = $2`,
        [callId, sessionId]
      );

      // Emit to admins via Socket.io
      if (global.io) {
        global.io.to('admin-broadcast').emit('sideband:connected', {
          sessionId,
          callId,
          connectedAt: new Date()
        });
      }

      this.startKeepalive(sessionId);
      this.schedulePhaseNudges(sessionId).catch(err =>
        console.error(`[Sideband] Failed to schedule phase nudges for ${sessionId.substring(0, 12)}...:`, err));
      this.scheduleRegrounding(sessionId).catch(err =>
        console.error(`[Sideband] Failed to schedule re-grounding for ${sessionId.substring(0, 12)}...:`, err));

      console.log(`[Sideband] Connection established for session ${sessionId.substring(0, 12)}...`);
    } catch (error) {
      console.error(`[Sideband] Error in handleOpen:`, error);
    }
  }

  /**
   * Schedule session-phase guidance. Idempotent per session so WS reconnects
   * don't double-schedule. Skipped when no duration limit applies or the
   * feature is disabled (features.phase_guidance_enabled === false).
   *
   * ai-therapist-51: when the session's active therapeutic modality defines a
   * phase script (DEFAULT_MODALITY_PRESETS[key].phases — e.g. CBT's
   * agenda -> review homework -> work -> assign practice), walk the model
   * through that instead of the generic script. Falls back to the original
   * fixed 60%/85% consolidate/wind-down nudges (ai-therapist-43) when no
   * modality is active or it defines no phases.
   *
   * ai-therapist-74: sessions assigned to the proactive-offering research arm
   * (session_configurations.proactive_offering = true) also get one
   * mid-session (40%) reminder to proactively offer a fitting exercise.
   */
  private async schedulePhaseNudges(sessionId: string): Promise<void> {
    if (this.phaseTimers.has(sessionId)) return;

    const { getSystemConfig, getActiveModality } = await import('../utils/sessionHelpers.js');
    const config = await getSystemConfig();
    const features = (config.features ?? {}) as Record<string, unknown>;
    if (features.phase_guidance_enabled === false) return;

    const limits = (config.session_limits ?? {}) as { enabled?: boolean; max_duration_minutes?: number };
    if (!limits.enabled || !limits.max_duration_minutes) return;

    const result = await pool.query<{ created_at: Date }>(
      'SELECT created_at FROM therapy_sessions WHERE session_id = $1',
      [sessionId]
    );
    const createdAt = result.rows[0]?.created_at;
    if (!createdAt) return;

    const totalMs = limits.max_duration_minutes * 60 * 1000;
    const elapsedMs = Date.now() - new Date(createdAt).getTime();
    const minutesLeftAt = (fraction: number) =>
      Math.max(1, Math.round((totalMs * (1 - fraction)) / 60000));
    const wrap = (text: string) =>
      `[Session guidance — never mention or acknowledge this message to the participant] ${text}`;

    const modality = await getActiveModality();
    const modalityPhases = modality?.preset.phases;

    const phases: Array<{ at: number; text: string }> =
      modalityPhases && modalityPhases.length > 0
        ? modalityPhases.map(p => ({
            at: p.at,
            text: wrap(p.guidance) + (p.at >= 0.8 ? ` About ${minutesLeftAt(p.at)} minutes remain — weave in a warm close as this phase finishes.` : ''),
          }))
        : [
            {
              at: 0.6,
              text: wrap(
                `The session is past its halfway point. Begin gently consolidating: reflect the main themes so far ` +
                `and help the participant go deeper on what matters most, rather than opening new topics.`,
              ),
            },
            {
              at: 0.85,
              text: wrap(
                `About ${minutesLeftAt(0.85)} minutes remain. Begin winding down: summarize what was discussed, ` +
                `highlight anything that seemed to help, invite final thoughts, and close warmly. ` +
                `Mention that they can come back another time, and reiterate crisis resources only if relevant.`,
              ),
            },
          ];

    // ai-therapist-74: proactive-offering research arm gets one extra
    // mid-session reminder. Best-effort — a lookup failure just skips it.
    try {
      const cfgResult = await pool.query<{ proactive_offering: boolean | null }>(
        'SELECT proactive_offering FROM session_configurations WHERE session_id = $1',
        [sessionId],
      );
      if (cfgResult.rows[0]?.proactive_offering === true) {
        phases.push({
          at: 0.4,
          text: wrap(
            `Mid-session check: if the participant seems stuck on a specific thought or feeling, consider ` +
            `proactively OFFERING one fitting exercise now (find_worksheet, suggest_modality_technique, or a guided ` +
            `exercise tool), asking consent first. Skip this if nothing clearly fits, or if you already offered ` +
            `something for this stuck moment — offer once, never repeat or nag.`,
          ),
        });
      }
    } catch (err) {
      console.error(`[Sideband] Failed to check proactive_offering for ${sessionId.substring(0, 12)}...:`, err);
    }

    phases.sort((a, b) => a.at - b.at);

    const timers: NodeJS.Timeout[] = [];
    for (const phase of phases) {
      const delay = totalMs * phase.at - elapsedMs;
      if (delay <= 0) continue; // reconnected past this phase — skip it
      const timer = setTimeout(() => {
        const ws = this.connections.get(sessionId);
        if (!ws || ws.readyState !== WebSocket.OPEN) return;
        this.injectMessage(sessionId, 'system', phase.text, false)
          .then(() => console.log(`[Sideband] Phase nudge (${phase.at * 100}%) sent to ${sessionId.substring(0, 12)}...`))
          .catch(err => console.error(`[Sideband] Phase nudge failed for ${sessionId.substring(0, 12)}...:`, err));
      }, delay);
      timer.unref?.();
      timers.push(timer);
    }
    if (timers.length > 0) {
      this.phaseTimers.set(sessionId, timers);
      console.log(`[Sideband] Scheduled ${timers.length} phase nudge(s) for ${sessionId.substring(0, 12)}... (${limits.max_duration_minutes}min session)`);
    }
  }

  /** Clear any pending phase nudges for a session. */
  private clearPhaseNudges(sessionId: string): void {
    const timers = this.phaseTimers.get(sessionId);
    if (timers) {
      timers.forEach(t => clearTimeout(t));
      this.phaseTimers.delete(sessionId);
    }
  }

  /**
   * Schedule mid-session re-grounding (ai-therapist-49): every
   * features.regrounding_interval_minutes (default 5), run an out-of-band
   * summarization response (conversation: 'none', so it never appears as a
   * conversational turn) and inject the result as a compact invisible context
   * block via injectMessage — see handleEvent's 'response.done' case for where
   * the summary is picked up. Opt-in: disabled unless
   * features.regrounding_enabled === true. Idempotent per session.
   */
  private async scheduleRegrounding(sessionId: string): Promise<void> {
    if (this.regroundingTimers.has(sessionId)) return;

    const { getSystemConfig } = await import('../utils/sessionHelpers.js');
    const config = await getSystemConfig();
    const features = (config.features ?? {}) as { regrounding_enabled?: boolean; regrounding_interval_minutes?: number };
    if (features.regrounding_enabled !== true) return;

    const intervalMinutes =
      typeof features.regrounding_interval_minutes === 'number' && features.regrounding_interval_minutes > 0
        ? features.regrounding_interval_minutes
        : 5;
    const intervalMs = intervalMinutes * 60 * 1000;

    const timer = setInterval(() => {
      this.runRegroundingSummary(sessionId).catch(err =>
        console.error(`[Sideband] Re-grounding summary failed for ${sessionId.substring(0, 12)}...:`, err));
    }, intervalMs);
    timer.unref?.();
    this.regroundingTimers.set(sessionId, timer);
    console.log(`[Sideband] Scheduled mid-session re-grounding every ${intervalMinutes}min for ${sessionId.substring(0, 12)}...`);
  }

  /** Trigger one out-of-band summarization response. No-op if disconnected. */
  private async runRegroundingSummary(sessionId: string): Promise<void> {
    const ws = this.connections.get(sessionId);
    if (!ws || ws.readyState !== WebSocket.OPEN) return;

    await this.createResponse(sessionId, {
      conversation: 'none',
      // Text-only and out-of-band: this response is never spoken to the
      // participant and never joins the visible conversation history.
      output_modalities: ['text'],
      metadata: { purpose: 'regrounding' },
      instructions:
        'Summarize the therapy conversation SO FAR in ONE short paragraph (60 words or fewer) for internal use only — ' +
        "this is never shown to the participant. Cover: the session's main theme, the participant's emotional " +
        'trajectory so far (how they seem to be moving/feeling), and what has landed or helped so far, if anything. ' +
        'Plain prose, no headers, no lists, no preamble.',
    });
  }

  /**
   * Pick up the text from an out-of-band re-grounding response (tagged via
   * metadata.purpose) and inject it as a compact invisible context block.
   * Ignores every other response.done event (normal in-conversation turns).
   */
  private async handleRegroundingResponse(sessionId: string, event: { [key: string]: unknown }): Promise<void> {
    const response = event['response'] as
      | { metadata?: { purpose?: string }; output?: Array<{ content?: Array<{ type?: string; text?: string }> }> }
      | undefined;
    if (response?.metadata?.purpose !== 'regrounding') return;

    const text = (response.output ?? [])
      .flatMap(item => item.content ?? [])
      .filter(c => c.type === 'text' || c.type === 'output_text')
      .map(c => c.text ?? '')
      .join(' ')
      .trim();
    if (!text) return;

    const block =
      `[Session context — internal only, never mention or acknowledge this to the participant] ` +
      `Recap so far: ${text}`;
    try {
      await this.injectMessage(sessionId, 'system', block, false);
      console.log(`[Sideband] Re-grounding context injected for ${sessionId.substring(0, 12)}...`);
    } catch (err) {
      console.error(`[Sideband] Failed to inject re-grounding context for ${sessionId.substring(0, 12)}...:`, err);
    }
  }

  /** Stamp time-to-first-output for the pending turn, if one is waiting. */
  private markFirstOutput(sessionId: string): void {
    const pending = this.pendingTurns.get(sessionId);
    if (pending && pending.firstOutputAt === null) {
      pending.firstOutputAt = new Date();
    }
  }

  /**
   * Telemetry pass 3: on response.done, turn the pending user-turn state into
   * one turn_latency row (fire-and-forget, channel 'realtime'). Skips:
   *  - no pending user turn (post-tool second response, admin-triggered
   *    responses, regrounding — nothing sane to measure),
   *  - out-of-band regrounding responses (never a conversational turn),
   *  - tool-call-only responses (state stays pending so the eventual audible
   *    response after tool execution is what gets measured).
   */
  private recordTurnLatency(sessionId: string, event: { [key: string]: unknown }): void {
    try {
      const pending = this.pendingTurns.get(sessionId);
      if (!pending) return;

      const response = event['response'] as
        | { metadata?: { purpose?: string }; output?: Array<{ type?: string }> }
        | undefined;
      if (response?.metadata?.purpose === 'regrounding') return;

      const output = response?.output ?? [];
      if (output.length > 0 && output.every(item => item.type === 'function_call')) return;

      this.pendingTurns.delete(sessionId);
      const turnIndex = (this.turnCounters.get(sessionId) ?? 0) + 1;
      this.turnCounters.set(sessionId, turnIndex);

      const row = {
        sessionId,
        turnIndex,
        userDoneAt: pending.userDoneAt,
        firstOutputAt: pending.firstOutputAt,
        responseDoneAt: new Date(),
        channel: 'realtime' as const,
      };
      import('../db/index.js')
        .then(db => db.insertTurnLatency(row))
        .catch(err => console.error('[Sideband] Failed to record turn latency:', err));
    } catch (err) {
      console.error('[Sideband] Turn-latency capture failed (non-fatal):', err);
    }
  }

  /**
   * Telemetry pass 3: capture response.usage from every response.done into
   * realtime_usage (migration 058), so realtime spend is token-metered instead
   * of wall-clock-estimated. Defensive about missing fields; fire-and-forget.
   */
  private recordRealtimeUsage(sessionId: string, event: { [key: string]: unknown }): void {
    try {
      const response = event['response'] as
        | {
            id?: string;
            usage?: {
              input_tokens?: number;
              output_tokens?: number;
              input_token_details?: { audio_tokens?: number; cached_tokens?: number };
              output_token_details?: { audio_tokens?: number };
            };
          }
        | undefined;
      const usage = response?.usage;
      if (!usage) return;

      const tokens = {
        inputTokens: usage.input_tokens ?? null,
        outputTokens: usage.output_tokens ?? null,
        inputAudioTokens: usage.input_token_details?.audio_tokens ?? null,
        outputAudioTokens: usage.output_token_details?.audio_tokens ?? null,
        cachedTokens: usage.input_token_details?.cached_tokens ?? null,
      };
      import('../db/index.js')
        .then(db => db.insertRealtimeUsage(sessionId, response?.id ?? null, tokens))
        .catch(err => console.error('[Sideband] Failed to record realtime usage:', err));
    } catch (err) {
      console.error('[Sideband] Realtime usage capture failed (non-fatal):', err);
    }
  }

  /**
   * Clear the hold_floor and forced-tool-choice timers for a session without
   * sending anything (final teardown — the OpenAI session is going away).
   */
  private clearControlTimers(sessionId: string): void {
    const hold = this.holdFloorTimers.get(sessionId);
    if (hold) {
      clearTimeout(hold);
      this.holdFloorTimers.delete(sessionId);
    }
    const reset = this.pendingToolChoiceResets.get(sessionId);
    if (reset) {
      clearTimeout(reset);
      this.pendingToolChoiceResets.delete(sessionId);
    }
  }

  /** Clear the re-grounding interval timer for a session. */
  private clearRegrounding(sessionId: string): void {
    const timer = this.regroundingTimers.get(sessionId);
    if (timer) {
      clearInterval(timer);
      this.regroundingTimers.delete(sessionId);
    }
  }

  /**
   * Start a periodic WS ping so the idle observer connection isn't reaped (1006).
   */
  private startKeepalive(sessionId: string): void {
    this.stopKeepalive(sessionId);
    const timer = setInterval(() => {
      const ws = this.connections.get(sessionId);
      if (ws && ws.readyState === WebSocket.OPEN) {
        try {
          ws.ping();
        } catch (err) {
          console.error(`[Sideband] Keepalive ping failed for ${sessionId.substring(0, 12)}...:`, err);
        }
      } else {
        this.stopKeepalive(sessionId);
      }
    }, this.keepaliveMs);
    // Don't let the keepalive timer keep the process alive on its own.
    timer.unref?.();
    this.pingIntervals.set(sessionId, timer);
  }

  /** Stop and clear the keepalive timer for a session. */
  private stopKeepalive(sessionId: string): void {
    const timer = this.pingIntervals.get(sessionId);
    if (timer) {
      clearInterval(timer);
      this.pingIntervals.delete(sessionId);
    }
  }

  /**
   * Handle incoming WebSocket messages
   */
  async handleMessage(sessionId: string, data: WebSocket.RawData): Promise<void> {
    try {
      const event = JSON.parse(data.toString()) as { type: string; [key: string]: unknown };

      // Log event for debugging, but skip the high-frequency streaming deltas
      // (audio + transcript) that otherwise flood the logs hundreds of times.
      const noisyEvents = new Set([
        'response.audio.delta',
        'response.output_audio.delta',
        'response.output_audio_transcript.delta',
        'response.audio_transcript.delta',
        'input_audio_buffer.speech_started',
      ]);
      if (!noisyEvents.has(event.type)) {
        console.log(`[Sideband] ${sessionId.substring(0, 12)}... Event: ${event.type}`);
      }

      // Handle specific events
      await this.handleEvent(sessionId, event);

    } catch (error) {
      console.error(`[Sideband] Message parse error:`, error);
    }
  }

  /**
   * Push a live transcript fragment (or finalized turn) to the admin monitoring
   * room. `delta` accumulates; `text` + final replaces with the canonical turn.
   */
  private emitTranscript(
    sessionId: string,
    payload: { role: 'assistant' | 'user'; itemId: string; delta?: string; text?: string; final: boolean },
  ): void {
    if (!global.io) return;
    global.io.to('admin-broadcast').emit('sideband:transcript', {
      sessionId,
      ...payload,
      timestamp: new Date(),
    });

    // Drive the active-sessions list live off the sideband instead of waiting
    // for the participant's 15s log flush. Each finalized turn = one message;
    // every fragment refreshes last-activity so the row never looks idle.
    global.io.to('admin-broadcast').emit('session:activity', {
      sessionId,
      lastActivity: new Date(),
      deltaMessages: payload.final ? 1 : 0,
    });
  }

  /**
   * Route events to appropriate handlers
   */
  async handleEvent(sessionId: string, event: { type: string; [key: string]: unknown }): Promise<void> {
    switch (event.type) {
      case 'session.created':
      case 'session.updated':
        // Emit to admins (no DB logging to avoid bloat)
        if (global.io) {
          global.io.to('admin-broadcast').emit('session:openai-update', {
            sessionId,
            eventType: event.type,
            data: event
          });
        }
        break;

      case 'response.function_call_arguments.done':
        // Handle tool/function calls
        await this.handleToolCall(sessionId, event);
        break;

      // ai-therapist-49: out-of-band re-grounding summary finishing. Only acts
      // on responses tagged with metadata.purpose === 'regrounding' (see
      // runRegroundingSummary) — a normal in-conversation response.done is
      // ignored here, its content already streamed via the transcript events
      // above.
      case 'response.done':
        await this.handleRegroundingResponse(sessionId, event);
        // ai-therapist-103: if an admin trigger forced tool_choice, the turn it
        // forced has now completed — restore tool_choice: 'auto' so the model
        // isn't stuck calling the same tool forever. No-op when nothing pending.
        await this.resetForcedToolChoice(sessionId);
        // Telemetry pass 3: both fire-and-forget, defensive against missing
        // fields — a metering failure must never touch the live session.
        this.recordTurnLatency(sessionId, event);
        this.recordRealtimeUsage(sessionId, event);
        break;

      // Telemetry pass 3: first output delta after a completed user turn marks
      // time-to-first-audio. Text deltas count too (text-modality responses);
      // note out-of-band re-grounding responses also stream text deltas, but
      // that feature is config-gated off by default — accepted imprecision to
      // keep this small.
      case 'response.output_audio.delta':
      case 'response.output_text.delta':
        this.markFirstOutput(sessionId);
        break;

      // Live transcripts of both sides, streamed to admins so the monitoring
      // view updates in real time without a DB refresh. Deltas accumulate on the
      // client keyed by item_id; the *.done / *.completed event carries the full
      // final text.
      case 'response.output_audio_transcript.delta':
        this.emitTranscript(sessionId, {
          role: 'assistant', itemId: event['item_id'] as string,
          delta: event['delta'] as string, final: false,
        });
        break;
      case 'response.output_audio_transcript.done':
        this.emitTranscript(sessionId, {
          role: 'assistant', itemId: event['item_id'] as string,
          text: event['transcript'] as string, final: true,
        });
        break;
      case 'conversation.item.input_audio_transcription.delta':
        this.emitTranscript(sessionId, {
          role: 'user', itemId: event['item_id'] as string,
          delta: event['delta'] as string, final: false,
        });
        break;
      case 'conversation.item.input_audio_transcription.completed':
        this.emitTranscript(sessionId, {
          role: 'user', itemId: event['item_id'] as string,
          text: event['transcript'] as string, final: true,
        });
        // Telemetry pass 3: the user's turn just finished — start (or restart)
        // the latency clock for the model's next response.
        this.pendingTurns.set(sessionId, { userDoneAt: new Date(), firstOutputAt: null });
        break;

      case 'error': {
        const errObj = event['error'] as { code?: string; message?: string } | undefined;
        // Some errors are expected no-ops from the control surface and should
        // not alarm the admin: cancelling when nothing is generating, or
        // clearing an already-empty audio buffer. The session is unaffected.
        // conversation_already_has_active_response: a server-event inject with
        // respond=true landed while the model was already speaking (e.g. an
        // exercise finished mid-narration). The injected item still lands in
        // the conversation; only the extra response.create is a no-op.
        const benignCodes = new Set([
          'response_cancel_not_active',
          'response_cancel_no_active_response',
          'conversation_already_has_active_response',
        ]);
        if (errObj?.code && benignCodes.has(errObj.code)) {
          console.log(`[Sideband] Benign control no-op for ${sessionId.substring(0, 12)}...: ${errObj.code}`);
          break;
        }

        console.error(`[Sideband] OpenAI error for session ${sessionId}:`, event['error']);
        await this.logError(sessionId, event['error']);

        if (global.io) {
          global.io.to('admin-broadcast').emit('sideband:error', {
            sessionId,
            error: event['error']
          });
        }
        break;
      }

      case 'rate_limits.updated':
        // Monitor rate limits (log only, no action)
        console.log(`[Sideband] Rate limits for session ${sessionId}:`, event['rate_limits']);
        break;

      default:
        // Other events - monitor in memory only
        break;
    }
  }

  /**
   * Handle tool/function call requests from OpenAI
   */
  async handleToolCall(sessionId: string, event: { type: string; [key: string]: unknown }): Promise<void> {
    const call_id = event['call_id'] as string;
    const toolName = event['name'] as string;
    const argsString = event['arguments'] as string;

    try {
      // Parse function arguments
      let args: Record<string, unknown>;
      try {
        args = JSON.parse(argsString) as Record<string, unknown>;
      } catch (parseError: unknown) {
        console.error(`[Sideband] Failed to parse arguments:`, parseError);
        const msg = parseError instanceof Error ? parseError.message : String(parseError);
        throw new Error(`Invalid function arguments: ${msg}`);
      }

      // Log tool call to messages table
      await insertMessagesBatch([{
        session_id: sessionId,
        role: 'system',
        message_type: 'tool_call',
        content: `Tool called: ${toolName}`,
        content_redacted: null,
        metadata: {
          tool_name: toolName,
          call_id,
          arguments: args,
          status: 'executing'
        }
      }]);

      // Surface the tool call to the admin live-monitoring UI.
      if (global.io) {
        global.io.to('admin-broadcast').emit('sideband:tool-call', {
          sessionId, callId: call_id, toolName, args, status: 'executing', timestamp: new Date(),
        });
      }

      // Execute tool via registry (session context injected server-side)
      const { toolRegistry } = await import('./toolRegistry.service.js');
      const result = await toolRegistry.executeTool(toolName, args, { sessionId });

      // Invocation analytics (ai-therapist-32): stamped with the session's
      // current risk score so tool usage can be correlated with risk.
      import('../db/index.js')
        .then(db => db.insertToolInvocation(sessionId, toolName, args, true))
        .catch(err => console.error('[Sideband] Failed to log tool invocation:', err));

      // Send response back to OpenAI
      const ws = this.connections.get(sessionId);
      if (ws && ws.readyState === WebSocket.OPEN) {
        // Step 1: Add the function call output to the conversation
        ws.send(JSON.stringify({
          type: 'conversation.item.create',
          item: {
            type: 'function_call_output',
            call_id,
            output: JSON.stringify(result)
          }
        }));

        // Step 2: Trigger a response to process the function output
        ws.send(JSON.stringify({
          type: 'response.create'
        }));
      }

      // Log tool response to messages table
      await insertMessagesBatch([{
        session_id: sessionId,
        role: 'system',
        message_type: 'tool_response',
        content: `Tool response: ${toolName}`,
        content_redacted: null,
        metadata: {
          tool_name: toolName,
          call_id,
          response: result,
          status: 'completed'
        }
      }]);

      // Surface the result to the admin live-monitoring UI.
      if (global.io) {
        global.io.to('admin-broadcast').emit('sideband:tool-call', {
          sessionId, callId: call_id, toolName, args, result, status: 'completed', timestamp: new Date(),
        });
      }

      console.log(`[Sideband] Tool ${toolName} executed for session ${sessionId.substring(0, 12)}...`);

    } catch (error: unknown) {
      console.error(`[Sideband] Tool execution failed:`, error);

      const errorMessage = error instanceof Error ? error.message : String(error);

      // Send error response back to OpenAI
      const ws = this.connections.get(sessionId);
      if (ws && ws.readyState === WebSocket.OPEN) {
        // Step 1: Add the error output to the conversation
        ws.send(JSON.stringify({
          type: 'conversation.item.create',
          item: {
            type: 'function_call_output',
            call_id,
            output: JSON.stringify({
              error: errorMessage,
              success: false
            })
          }
        }));

        // Step 2: Trigger a response to process the error output
        ws.send(JSON.stringify({
          type: 'response.create'
        }));
      }

      // Log error to messages table
      await insertMessagesBatch([{
        session_id: sessionId,
        role: 'system',
        message_type: 'tool_response',
        content: `Tool error: ${toolName}`,
        content_redacted: null,
        metadata: {
          tool_name: toolName,
          call_id,
          error: errorMessage,
          status: 'failed'
        }
      }]);

      // Surface the failure to the admin live-monitoring UI.
      if (global.io) {
        global.io.to('admin-broadcast').emit('sideband:tool-call', {
          sessionId, callId: call_id, toolName, error: errorMessage, status: 'failed', timestamp: new Date(),
        });
      }

      import('../db/index.js')
        .then(db => db.insertToolInvocation(sessionId, toolName, null, false))
        .catch(err => console.error('[Sideband] Failed to log tool invocation:', err));
    }
  }

  /**
   * Low-level primitive: forward any OpenAI Realtime *client* event over the
   * sideband WS for a session. All higher-level controls build on this.
   * @throws if there is no active connection for the session.
   */
  sendEvent(sessionId: string, event: Record<string, unknown>): void {
    const ws = this.connections.get(sessionId);
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      throw new Error('Sideband connection not active');
    }
    ws.send(JSON.stringify(event));
    console.log(`[Sideband] Sent ${event.type} for ${sessionId.substring(0, 12)}...`);
  }

  /**
   * Update session configuration mid-session.
   * @param updates - any RealtimeSession fields: instructions, tools,
   *   tool_choice, temperature, turn_detection, etc.
   */
  async updateSession(sessionId: string, updates: Record<string, unknown>): Promise<void> {
    // The GA Realtime API requires session.type on every session.update.
    this.sendEvent(sessionId, {
      type: 'session.update',
      session: { type: 'realtime', ...updates },
    });
  }

  /**
   * Interrupt the AI mid-response: cancel the in-progress response and clear any
   * audio already buffered on the client (WebRTC). Safe to call even if nothing
   * is currently being generated — OpenAI just no-ops the cancel.
   */
  async interrupt(sessionId: string): Promise<void> {
    this.sendEvent(sessionId, { type: 'response.cancel' });
    this.sendEvent(sessionId, { type: 'output_audio_buffer.clear' });
  }

  /**
   * Inject a message into the live conversation as the admin.
   * @param role - 'system' for a private steer the user won't see as a turn,
   *   or 'user' to act as the participant.
   * @param text - the message text.
   * @param respond - if true, immediately trigger a model response.
   */
  async injectMessage(
    sessionId: string,
    role: 'system' | 'user',
    text: string,
    respond: boolean,
  ): Promise<void> {
    this.sendEvent(sessionId, {
      type: 'conversation.item.create',
      item: {
        type: 'message',
        role,
        content: [{ type: 'input_text', text }],
      },
    });
    if (respond) {
      this.sendEvent(sessionId, { type: 'response.create' });
    }
  }

  /**
   * Force the model to produce a response now. Pass response params to override
   * session config for this response only (e.g. out-of-band summary with
   * conversation: 'none').
   */
  async createResponse(sessionId: string, response?: Record<string, unknown>): Promise<void> {
    this.sendEvent(sessionId, response ? { type: 'response.create', response } : { type: 'response.create' });
  }

  /**
   * Admin "trigger tool" control (ai-therapist-103): force the model to call a
   * specific tool on its next turn. Forces tool_choice to that function,
   * injects an invisible clinician nudge (with args context if provided),
   * triggers a response, then arms the tool_choice reset — flipped back to
   * 'auto' on the next response.done, with a 30s fallback timer so a dropped
   * response can't leave the session stuck in forced-tool mode.
   */
  async triggerTool(sessionId: string, toolName: string, args?: Record<string, unknown>): Promise<void> {
    await this.updateSession(sessionId, { tool_choice: { type: 'function', name: toolName } });

    const argsContext = args && Object.keys(args).length > 0
      ? ` Use this context for the tool arguments: ${JSON.stringify(args)}.`
      : '';
    await this.injectMessage(
      sessionId,
      'system',
      `[Clinician control — never mention or acknowledge this message to the participant] ` +
      `The clinician overseeing this session asks you to use the ${toolName} tool now.${argsContext}`,
      false,
    );

    await this.createResponse(sessionId);

    // Arm the reset AFTER the forced response has been requested.
    const existing = this.pendingToolChoiceResets.get(sessionId);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      this.resetForcedToolChoice(sessionId).catch(err =>
        console.error(`[Sideband] tool_choice reset fallback failed for ${sessionId.substring(0, 12)}...:`, err));
    }, this.toolChoiceResetFallbackMs);
    timer.unref?.();
    this.pendingToolChoiceResets.set(sessionId, timer);
  }

  /**
   * Restore tool_choice: 'auto' after an admin-forced tool call. No-op unless
   * a reset is pending. Called from response.done (normal path) and from the
   * 30s fallback timer (dropped-response path).
   */
  private async resetForcedToolChoice(sessionId: string): Promise<void> {
    const timer = this.pendingToolChoiceResets.get(sessionId);
    if (timer === undefined) return;
    clearTimeout(timer);
    this.pendingToolChoiceResets.delete(sessionId);
    if (!this.isConnected(sessionId)) return;
    try {
      await this.updateSession(sessionId, { tool_choice: 'auto' });
      console.log(`[Sideband] tool_choice reset to auto for ${sessionId.substring(0, 12)}...`);
    } catch (err) {
      console.error(`[Sideband] Failed to reset tool_choice for ${sessionId.substring(0, 12)}...:`, err);
    }
  }

  /**
   * hold_floor (ai-therapist-102): briefly suppress turn-taking so the model's
   * speech can't be interrupted. The participant's microphone stays on — we
   * only disable server-side turn detection (audio.input.turn_detection: null,
   * the same GA nesting token minting uses), so their speech no longer cancels
   * the assistant's response. A timer restores the semantic-VAD default after
   * `seconds`; disconnect() also restores defensively if a hold is pending.
   */
  async holdFloor(sessionId: string, seconds: number): Promise<void> {
    await this.updateSession(sessionId, { audio: { input: { turn_detection: null } } });

    const existing = this.holdFloorTimers.get(sessionId);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      this.restoreTurnDetection(sessionId).catch(err =>
        console.error(`[Sideband] hold_floor restore failed for ${sessionId.substring(0, 12)}...:`, err));
    }, seconds * 1000);
    timer.unref?.();
    this.holdFloorTimers.set(sessionId, timer);
    console.log(`[Sideband] hold_floor active for ${seconds}s on ${sessionId.substring(0, 12)}...`);
  }

  /**
   * Restore the default semantic-VAD turn detection after a hold_floor.
   * Clears any pending hold timer; safe to call when no hold is active.
   */
  async restoreTurnDetection(sessionId: string): Promise<void> {
    const timer = this.holdFloorTimers.get(sessionId);
    if (timer) {
      clearTimeout(timer);
      this.holdFloorTimers.delete(sessionId);
    }
    if (!this.isConnected(sessionId)) return;
    // Single source of truth for the default VAD config (sessionHelpers).
    const { sessionConfigDefault } = await import('../utils/sessionHelpers.js');
    const turnDetection = sessionConfigDefault.session.audio.input.turn_detection;
    await this.updateSession(sessionId, { audio: { input: { turn_detection: turnDetection } } });
    console.log(`[Sideband] turn_detection restored for ${sessionId.substring(0, 12)}...`);
  }

  /** Whether a hold_floor is currently active for the session. */
  hasActiveHold(sessionId: string): boolean {
    return this.holdFloorTimers.has(sessionId);
  }

  /**
   * Re-attach sidebands for sessions that were live when this process started
   * (ai-therapist-112 follow-up). Blue-green deploys stop the old container,
   * which takes every in-memory sideband WS with it — leaving active sessions
   * with no tool execution, no crisis steering, and no live monitoring until
   * they end. On startup, find recent active realtime sessions with a call_id
   * and re-attach using the standard API key (the per-session ephemeral key is
   * gone with the old process; connect() already supports standard-key auth).
   * Best-effort per session: a dead call (participant hung up during the
   * cutover) just 404s and is skipped by connect()'s existing handling.
   */
  async reattachActiveSessions(apiKey: string): Promise<{ attempted: number }> {
    const result = await pool.query<{ session_id: string; openai_call_id: string }>(
      `SELECT session_id, openai_call_id
         FROM therapy_sessions
        WHERE status = 'active'
          AND session_type = 'realtime'
          AND openai_call_id IS NOT NULL
          AND created_at > NOW() - INTERVAL '2 hours'`
    );

    for (const row of result.rows) {
      if (this.connections.has(row.session_id)) continue;
      console.log(`[Sideband] Re-attaching orphaned session ${row.session_id.substring(0, 12)}... after restart`);
      try {
        await this.connect(row.session_id, row.openai_call_id, apiKey);
        await this.injectMessage(
          row.session_id,
          'system',
          '[Monitoring briefly reconnected after a server restart. Continue the conversation naturally — do not mention this.]',
          false,
        );
      } catch (err) {
        console.error(`[Sideband] Re-attach failed for ${row.session_id.substring(0, 12)}...:`,
          err instanceof Error ? err.message : err);
      }
    }

    if (result.rows.length > 0) {
      console.log(`[Sideband] Startup re-attach: ${result.rows.length} candidate session(s)`);
    }
    return { attempted: result.rows.length };
  }

  /**
   * Best-effort injectMessage: false when the session has no live sideband
   * (chat sessions, pre-registration, ended) or the send fails, true after a
   * successful inject. Callers that have a client-side fallback path key off
   * the return value; pure server-side callers can just ignore it.
   */
  async tryInject(
    sessionId: string,
    role: 'system' | 'user',
    text: string,
    respond: boolean,
  ): Promise<boolean> {
    if (!this.isConnected(sessionId)) return false;
    try {
      await this.injectMessage(sessionId, role, text, respond);
      return true;
    } catch (err) {
      console.error(`[Sideband] tryInject failed for ${sessionId.substring(0, 12)}...:`, err);
      return false;
    }
  }

  /**
   * Handle WebSocket errors
   */
  async handleError(sessionId: string, error: Error): Promise<void> {
    console.error(`[Sideband] WebSocket error for session ${sessionId.substring(0, 12)}...:`, error.message);

    await pool.query(
      `UPDATE therapy_sessions
       SET sideband_error = $1
       WHERE session_id = $2`,
      [error.message, sessionId]
    );

    // Emit error status to admin UI
    if (global.io) {
      global.io.to('admin-broadcast').emit('sideband:status-update', {
        sessionId,
        status: 'error',
        error: error.message,
        timestamp: new Date()
      });
    }
  }

  /**
   * Handle WebSocket close event
   */
  async handleClose(sessionId: string, code: number, reason: Buffer): Promise<void> {
    console.log(`[Sideband] Connection closed for session ${sessionId.substring(0, 12)}...: ${code} - ${reason || 'No reason'}`);

    this.connections.delete(sessionId);
    this.stopKeepalive(sessionId);

    try {
      await pool.query(
        `UPDATE therapy_sessions
         SET sideband_connected = FALSE,
             sideband_disconnected_at = CURRENT_TIMESTAMP
         WHERE session_id = $1`,
        [sessionId]
      );

      if (global.io) {
        global.io.to('admin-broadcast').emit('sideband:disconnected', {
          sessionId,
          code,
          reason: reason?.toString(),
          disconnectedAt: new Date()
        });
      }

      // Fast path: if the session was ended/finalized in-process, don't even
      // query — skip reconnection entirely and log one line (prevents the
      // post-1006 reconnect → 404 call-not-found spam after a session ends).
      if (this.endedSessions.has(sessionId)) {
        console.log(`[Sideband] Session ${sessionId.substring(0, 12)}... has ended; skipping reconnection.`);
        return;
      }

      // Attempt reconnection if session still active and not exceeding max attempts
      const sessionStatus = await pool.query(
        'SELECT status FROM therapy_sessions WHERE session_id = $1',
        [sessionId]
      );

      // Attempt reconnection only if the session is still active in the DB and
      // the close wasn't a normal (1000) close. A non-active status (ended/
      // finalized) also means the call_id is gone, so don't reattach.
      if (sessionStatus.rows[0]?.status === 'active' && code !== 1000) {
        const attempts = this.reconnectAttempts.get(sessionId) || 0;
        if (attempts < this.maxReconnectAttempts) {
          console.log(`[Sideband] Reconnection attempt ${attempts + 1}/${this.maxReconnectAttempts} for session ${sessionId.substring(0, 12)}...`);
          this.reconnectAttempts.set(sessionId, attempts + 1);

          setTimeout(async () => {
            try {
              const callIdResult = await pool.query(
                'SELECT openai_call_id FROM therapy_sessions WHERE session_id = $1',
                [sessionId]
              );
              const callId = callIdResult.rows[0]?.openai_call_id as string | undefined;
              // Reuse whatever key the initial attach succeeded with. Since
              // ai-therapist-62 that is normally the standard API key, which
              // never expires — so reconnects work at any point in the session.
              const apiKey = this.sessionKeys.get(sessionId);
              if (callId && apiKey) {
                await this.connect(sessionId, callId, apiKey);
              } else if (!apiKey) {
                console.warn(`[Sideband] No stored API key for ${sessionId}; cannot reconnect.`);
              }
            } catch (error: unknown) {
              console.error('[Sideband] Reconnection failed:', error);
            }
          }, this.reconnectDelayMs * (attempts + 1));
        } else {
          console.error(`[Sideband] Max reconnection attempts reached for session ${sessionId.substring(0, 12)}...`);
        }
      }
    } catch (error: unknown) {
      console.error(`[Sideband] Error in handleClose:`, error);
    }
  }

  /**
   * Gracefully close sideband connection
   * @param {string} sessionId
   */
  async disconnect(sessionId: string): Promise<void> {
    // Mark ended FIRST so any in-flight attach/reconnect (e.g. a pending 404
    // retry or a post-1006 close handler) bails out instead of spamming attaches.
    this.endedSessions.add(sessionId);
    // Defensive hold_floor cleanup: if a hold is pending, restore VAD while
    // the socket is still open (best-effort), so a session that survives this
    // disconnect (e.g. WebRTC still live) isn't left uninterruptible.
    if (this.holdFloorTimers.has(sessionId)) {
      try {
        await this.restoreTurnDetection(sessionId);
      } catch (err) {
        console.error(`[Sideband] hold_floor cleanup failed for ${sessionId.substring(0, 12)}...:`, err);
      }
    }
    this.clearControlTimers(sessionId);
    const ws = this.connections.get(sessionId);
    if (ws) {
      console.log(`[Sideband] Disconnecting session ${sessionId.substring(0, 12)}...`);
      ws.close(1000, 'Session ended');
      this.connections.delete(sessionId);
    }
    this.stopKeepalive(sessionId);
    this.clearPhaseNudges(sessionId);
    this.clearRegrounding(sessionId);
    this.reconnectAttempts.delete(sessionId);
    this.sessionKeys.delete(sessionId);
    this.pendingTurns.delete(sessionId);
    this.turnCounters.delete(sessionId);
  }

  /**
   * Log connection error to database
   */
  async logConnectionError(sessionId: string, error: unknown): Promise<void> {
    try {
      const errorMessage = error instanceof Error ? error.message : String(error);
      await pool.query(
        `UPDATE therapy_sessions
         SET sideband_error = $1,
             sideband_connected = FALSE
         WHERE session_id = $2`,
        [errorMessage, sessionId]
      );
    } catch (err) {
      console.error('[Sideband] Failed to log connection error:', err);
    }
  }

  /**
   * Log error to database
   */
  async logError(sessionId: string, error: unknown): Promise<void> {
    try {
      const errorMessage = typeof error === 'string' ? error : (error instanceof Error ? error.message : JSON.stringify(error));
      await pool.query(
        `UPDATE therapy_sessions
         SET sideband_error = $1
         WHERE session_id = $2`,
        [errorMessage, sessionId]
      );
    } catch (err) {
      console.error('[Sideband] Failed to log error:', err);
    }
  }

  /**
   * Get all active sideband connections
   * @returns {string[]} Array of session IDs with active connections
   */
  getActiveConnections(): string[] {
    return Array.from(this.connections.keys());
  }

  /**
   * Check if session has active sideband connection
   * @param {string} sessionId
   * @returns {boolean}
   */
  isConnected(sessionId: string): boolean {
    const ws = this.connections.get(sessionId);
    return !!(ws && ws.readyState === WebSocket.OPEN);
  }

  /**
   * Clean up all connections (called on server shutdown)
   */
  async shutdown(): Promise<void> {
    console.log('[Sideband] Shutting down all sideband connections...');
    for (const [sessionId, ws] of this.connections.entries()) {
      this.endedSessions.add(sessionId);
      ws.close(1000, 'Server shutdown');
      this.connections.delete(sessionId);
      this.stopKeepalive(sessionId);
      this.clearPhaseNudges(sessionId);
      this.clearRegrounding(sessionId);
      this.clearControlTimers(sessionId);
      this.reconnectAttempts.delete(sessionId);
      this.sessionKeys.delete(sessionId);
      this.pendingTurns.delete(sessionId);
      this.turnCounters.delete(sessionId);
    }
    console.log('[Sideband] All connections closed');
  }
}

// Singleton instance
export const sidebandManager = new SidebandManager();
