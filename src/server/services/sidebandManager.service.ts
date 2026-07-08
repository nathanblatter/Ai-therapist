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
  // Per-session ephemeral key used to authenticate the sideband WS. Stored so
  // reconnects reuse it (the standard API key returns 404 call_id_not_found).
  private sessionKeys: Map<string, string>;
  // Per-session keepalive timer. The sideband is a passive observer that can sit
  // idle for long stretches; without periodic pings the socket gets reaped and
  // closes with code 1006. We ping every keepaliveMs to keep it warm.
  private pingIntervals: Map<string, NodeJS.Timeout>;
  // Session-phase nudge timers (ai-therapist-43): wall-clock timers that steer
  // the model through consolidation → wind-down as the session's max duration
  // approaches. Survive WS reconnects; cleared on session disconnect.
  private phaseTimers: Map<string, NodeJS.Timeout[]>;
  private maxReconnectAttempts: number;
  private reconnectDelayMs: number;
  private keepaliveMs: number;

  constructor() {
    this.connections = new Map(); // sessionId → WebSocket
    this.reconnectAttempts = new Map(); // sessionId → attempt count
    this.sessionKeys = new Map(); // sessionId → ephemeral key
    this.pingIntervals = new Map(); // sessionId → keepalive timer
    this.phaseTimers = new Map(); // sessionId → phase nudge timers
    this.maxReconnectAttempts = 3;
    this.reconnectDelayMs = 2000;
    this.keepaliveMs = 20000;
  }

  /**
   * Establish sideband WebSocket connection for a session
   * @param {string} sessionId - Therapy session ID
   * @param {string} callId - OpenAI call_id from Location header
   * @param {string} apiKey - OpenAI API key
   * @returns {Promise<WebSocket>} - The WebSocket connection
   */
  async connect(sessionId: string, callId: string, apiKey: string, attempt = 0): Promise<WebSocket> {
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
          const callNotReady = res.statusCode === 404 && body.includes('call_id_not_found');
          if (callNotReady && attempt < this.maxReconnectAttempts) {
            const delay = this.reconnectDelayMs * (attempt + 1);
            console.log(`[Sideband] call_id not registered yet; retrying attach in ${delay}ms (attempt ${attempt + 2}/${this.maxReconnectAttempts + 1})`);
            setTimeout(() => {
              this.connect(sessionId, callId, apiKey, attempt + 1).catch(() => {});
            }, delay);
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

      console.log(`[Sideband] Connection established for session ${sessionId.substring(0, 12)}...`);
    } catch (error) {
      console.error(`[Sideband] Error in handleOpen:`, error);
    }
  }

  /**
   * Schedule session-phase guidance (ai-therapist-43): at 60% of the max
   * session duration nudge the model toward consolidation, at 85% toward a
   * warm wind-down. Skipped when no duration limit applies or the feature is
   * disabled (features.phase_guidance_enabled === false). Idempotent per
   * session so WS reconnects don't double-schedule.
   */
  private async schedulePhaseNudges(sessionId: string): Promise<void> {
    if (this.phaseTimers.has(sessionId)) return;

    const { getSystemConfig } = await import('../utils/sessionHelpers.js');
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

    const phases: Array<{ at: number; text: string }> = [
      {
        at: 0.6,
        text:
          `[Session guidance — never mention or acknowledge this message to the participant] ` +
          `The session is past its halfway point. Begin gently consolidating: reflect the main themes so far ` +
          `and help the participant go deeper on what matters most, rather than opening new topics.`,
      },
      {
        at: 0.85,
        text:
          `[Session guidance — never mention or acknowledge this message to the participant] ` +
          `About ${minutesLeftAt(0.85)} minutes remain. Begin winding down: summarize what was discussed, ` +
          `highlight anything that seemed to help, invite final thoughts, and close warmly. ` +
          `Mention that they can come back another time, and reiterate crisis resources only if relevant.`,
      },
    ];

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
        break;

      case 'error': {
        const errObj = event['error'] as { code?: string; message?: string } | undefined;
        // Some errors are expected no-ops from the control surface and should
        // not alarm the admin: cancelling when nothing is generating, or
        // clearing an already-empty audio buffer. The session is unaffected.
        const benignCodes = new Set(['response_cancel_not_active', 'response_cancel_no_active_response']);
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

      // Attempt reconnection if session still active and not exceeding max attempts
      const sessionStatus = await pool.query(
        'SELECT status FROM therapy_sessions WHERE session_id = $1',
        [sessionId]
      );

      // Attempt reconnection if session still active and not a normal close
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
              // Reuse the ephemeral key that created the call (the standard key
              // returns 404). Note: ephemeral keys are short-lived, so a late
              // reconnect may legitimately fail once it has expired.
              const apiKey = this.sessionKeys.get(sessionId);
              if (callId && apiKey) {
                await this.connect(sessionId, callId, apiKey);
              } else if (!apiKey) {
                console.warn(`[Sideband] No stored ephemeral key for ${sessionId}; cannot reconnect.`);
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
    const ws = this.connections.get(sessionId);
    if (ws) {
      console.log(`[Sideband] Disconnecting session ${sessionId.substring(0, 12)}...`);
      ws.close(1000, 'Session ended');
      this.connections.delete(sessionId);
    }
    this.stopKeepalive(sessionId);
    this.clearPhaseNudges(sessionId);
    this.reconnectAttempts.delete(sessionId);
    this.sessionKeys.delete(sessionId);
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
      ws.close(1000, 'Server shutdown');
      this.connections.delete(sessionId);
      this.stopKeepalive(sessionId);
      this.clearPhaseNudges(sessionId);
      this.reconnectAttempts.delete(sessionId);
      this.sessionKeys.delete(sessionId);
    }
    console.log('[Sideband] All connections closed');
  }
}

// Singleton instance
export const sidebandManager = new SidebandManager();
