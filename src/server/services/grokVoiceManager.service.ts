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
 * the probe transcript in the flightdeck decision for ai-therapist-244) and
 * re-verified on 2026-10-22 against Grok Voice 3.0 through the red-team voice
 * harness (src/redteam/voiceClient.ts):
 *   - `session.created` reports the RESOLVED model (grok-voice-think-fast-2.0
 *     for the alias in September; grok-voice-3.0 since xAI moved
 *     grok-voice-latest onto the 3.0 generation on 2026-10-14); it is pinned
 *     to the session. Pricing is unchanged at $0.08/min (LIVE_RATES_PER_MINUTE).
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
 *   - resumption (docs.x.ai, Speech to Speech, "Session Resumption", read
 *     2026-10-23): with `resumption.enabled: true` in session.update, xAI
 *     "caches conversation turns keyed by `conversation_id`"; the id arrives
 *     in `conversation.created`; a re-dial with `?conversation_id=<id>` that
 *     opts in again gets "the cached turns replay[ed] before your first new
 *     turn, echoed back as `conversation.item.created` events"; "History is
 *     dropped after 30 minutes of inactivity." Replayed items are ignored
 *     here: they were persisted and scored on the first leg.
 *
 * Reconnection (ai-therapist-245, docs/grok-voice.md section 3): a lost
 * BROWSER socket keeps the xAI session alive for `reconnectWindowMs` and the
 * browser re-attaches to it; a lost xAI socket is re-dialled with the
 * conversation id inside the same window. Past the window the session ends
 * (fail closed), as before. Usage stays assigned from xAI's cumulative figure
 * per leg, with an offset for the legs before it, never summed snapshot by
 * snapshot.
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
  GROK_DEFAULT_REFUSAL_GUARD,
  GROK_REFUSAL_STEER,
  GrokRefusalDetector,
  buildGrokRefusalRecoveryLine,
  type GrokRefusalGuardConfig,
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
  /** How long a lost socket (either side) may be recovered; 0 disables. */
  reconnectWindowMs?: number;
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
  /** Last persisted participant turn, for de-duplicating xAI's occasional
   *  repeated transcription.completed (ai-therapist-258). */
  lastUserTurn: { itemId: string; text: string; at: number; assistantTurnIndex: number } | null;

  // --- Reconnection (ai-therapist-245) ---------------------------------------
  /** xAI's conversation id from `conversation.created`; the resumption key. */
  conversationId: string | null;
  /** How long a lost socket may be recovered. 0 = fail closed at once. */
  reconnectWindowMs: number;
  /** `ready` has been sent at least once: a later session.updated is a leg, not a start. */
  everReady: boolean;
  /** An upstream re-dial is in progress. */
  resuming: boolean;
  /** The participant pressed end; no re-dial may complete after this. */
  endRequested: boolean;
  /** Backoff timer between re-dial attempts, and how many have been made. */
  resumeTimer: NodeJS.Timeout | null;
  resumeAttempt: number;
  /** A reply was in flight when the upstream dropped; ask the model to pick it up. */
  resumeInterrupted: boolean;
  /** Steers that arrived while no upstream was open; delivered on resume. */
  queuedSteers: Array<{ role: 'system' | 'user'; text: string; respond: boolean }>;
  /** Item ids already persisted, so a replayed or repeated item is never a second row. */
  seenUserItems: Set<string>;
  seenAssistantItems: Set<string>;
  /** Billable seconds confirmed on earlier upstream legs (see meterResponse). */
  legBase: number;
  /** Latest cumulative figure reported on the current leg. */
  legSeconds: number;
  /** No response.done seen yet on the current leg. */
  legFresh: boolean;
  /** Counters for the session record and the admin view. */
  clientReconnects: number;
  upstreamResumes: number;
  /** Replayed `conversation.item.created` events seen on the latest resume. */
  replayedItems: number;
}

/** Two completed user transcripts with identical text inside this window are
 *  one utterance reported twice, not two utterances. */
const USER_TURN_DEDUPE_MS = 10_000;

/** Default recovery window when the route passes none (system_config.grok_voice
 *  reconnect_window_s is the configured value). */
const DEFAULT_RECONNECT_WINDOW_MS = 75_000;

/** Backoff before re-dial attempt n (index 0 = before the second attempt). */
const RESUME_BACKOFF_MS = [500, 2_000, 5_000];

/** Close codes for refused attaches. 44xx are ours; the browser treats them as
 *  final (no retry) — see client/main/lib/grokVoiceClient.ts. */
export const GROK_CLOSE_UNKNOWN_SESSION = 4404;
export const GROK_CLOSE_ALREADY_ATTACHED = 4409;
export const GROK_CLOSE_SESSION_ENDED = 4410;

/** xAI answers a response.cancel that races the reply's own completion with
 *  this error. It is benign: nothing was playing, nothing is lost. */
/** Bounded set insert: item ids are remembered for the session's lifetime, but a
 *  multi-hour session must not grow without limit. */
function rememberItem(set: Set<string>, id: string): void {
  set.add(id);
  if (set.size > 2000) {
    for (const old of set) {
      if (set.size <= 1000) break;
      set.delete(old);
    }
  }
}

function isBenignCancelError(err: { code?: string; message?: string } | undefined): boolean {
  const m = err?.message ?? '';
  return /cancellation failed|no active response/i.test(m);
}

export class GrokVoiceManager implements VoiceSidebandDelegate {
  private sessions = new Map<string, GrokSessionState>();
  /** Sessions that have ended. Never re-open: their upstream is gone. */
  private endedSessions = new Set<string>();

  private readonly keepaliveMs = 20_000;
  /** How long a created session may wait for the browser's socket. */
  private readonly pendingTtlMs = 45_000;
  /**
   * After the browser drops without ending, how long before we end it when
   * reconnection is DISABLED (reconnect_window_s = 0). With a window, the
   * window itself is the grace: the upstream stays open and the browser may
   * re-attach (handleClientClose).
   */
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
      lastUserTurn: null,
      conversationId: null,
      reconnectWindowMs: Math.max(0, pending.reconnectWindowMs ?? DEFAULT_RECONNECT_WINDOW_MS),
      everReady: false,
      resuming: false,
      endRequested: false,
      resumeTimer: null,
      resumeAttempt: 0,
      resumeInterrupted: false,
      queuedSteers: [],
      seenUserItems: new Set(),
      seenAssistantItems: new Set(),
      legBase: 0,
      legSeconds: 0,
      legFresh: true,
      clientReconnects: 0,
      upstreamResumes: 0,
      replayedItems: 0,
    };
    this.sessions.set(sessionId, state);
    this.armOrphanTimer(sessionId, this.pendingTtlMs, 'client_never_connected');
  }

  /**
   * The browser's socket for a registered session. The first attach dials
   * xAI; a later one — the browser lost its socket and came back inside the
   * reconnect window — re-joins the live upstream session in place
   * (ai-therapist-245). The upgrade handler has already applied the same
   * cookie-authenticated ownership check either way.
   */
  async attachClient(sessionId: string, client: WebSocket): Promise<void> {
    const state = this.sessions.get(sessionId);
    const short = sessionId.substring(0, 12);
    if (this.endedSessions.has(sessionId) || state?.ended) {
      // Includes a reconnect after the window: the session was ended and its
      // upstream is gone, so the browser must run its end flow, not retry.
      console.warn(`[Grok] Client attach for ended session ${short}...; refusing.`);
      client.close(GROK_CLOSE_SESSION_ENDED, 'session ended');
      return;
    }
    if (!state) {
      console.warn(`[Grok] Client attach for unknown session ${short}...; closing.`);
      client.close(GROK_CLOSE_UNKNOWN_SESSION, 'unknown session');
      return;
    }
    if (state.client && state.client.readyState === WebSocket.OPEN) {
      // One browser per session. A second tab replacing the first would leave
      // the first with a dead socket and no explanation; refuse instead.
      console.warn(`[Grok] Second client attach for ${short}... refused.`);
      client.close(GROK_CLOSE_ALREADY_ATTACHED, 'already attached');
      return;
    }
    this.clearOrphanTimer(state);
    state.client = client;

    client.on('message', (data, isBinary) => this.handleClientMessage(sessionId, data, isBinary));
    client.on('close', () => void this.handleClientClose(sessionId));
    client.on('error', (err) => console.error(`[Grok] Client socket error for ${short}...:`, err.message));

    if (state.everReady) {
      // Re-attach. The xAI session never noticed: audio simply resumes. If the
      // upstream is itself being re-dialled right now, the browser gets
      // `ready` (its connect resolves) followed by the link state so it keeps
      // showing "reconnecting" until the model is back.
      state.clientReconnects += 1;
      console.log(`[Grok] Client re-attached to ${short}... (reconnect ${state.clientReconnects})`);
      this.sendToClient(sessionId, { type: 'ready', model: state.resolvedModel ?? state.model, resumed: true });
      if (state.resuming) this.sendToClient(sessionId, { type: 'link', state: 'reconnecting' });
      this.broadcastStatus(sessionId, 'connected', `Participant reconnected (${state.clientReconnects})`);
      if (global.io) {
        void broadcastAdminEventForSession(
          global.io,
          'session:activity',
          {
            sessionId,
            lastActivity: new Date(),
            deltaMessages: 0,
          },
          sessionId,
        );
      }
      return;
    }

    try {
      await this.openUpstream(sessionId);
    } catch (err) {
      console.error(`[Grok] Upstream open FAILED for ${short}...:`, err instanceof Error ? err.message : err);
      this.sendToClient(sessionId, { type: 'error', message: 'Could not reach the voice service.' });
      await this.failClosed(
        sessionId,
        'upstream_unavailable',
        'We could not connect to the voice service. Please try again in a moment.',
      );
    }
  }

  /**
   * Dial xAI. With `resume`, the URL carries the cached conversation id (xAI:
   * "Reopen the WebSocket with `?conversation_id=<id>` and opt in again") and
   * the same session.update — which includes `resumption.enabled` — goes out,
   * so both legs opt in as the docs require.
   */
  private async openUpstream(sessionId: string, resume = false): Promise<void> {
    const state = this.sessions.get(sessionId);
    if (!state) return;
    const short = sessionId.substring(0, 12);
    const ws = new WebSocket(grokRealtimeUrl(state.model, resume ? state.conversationId : null), {
      headers: { Authorization: `Bearer ${state.apiKey}` },
    });
    state.upstream = ws;

    // Every handler is bound to THIS socket: once a leg has been replaced
    // (resume, or a participant end racing a re-dial) its late events are
    // ignored rather than persisted, metered or treated as a fresh loss.
    const current = () => this.sessions.get(sessionId)?.upstream === ws;
    ws.on('message', (data) => {
      if (current()) void this.handleUpstreamMessage(sessionId, data);
    });
    ws.on('error', (err) => {
      if (current()) void this.handleUpstreamError(sessionId, err);
    });
    ws.on('close', (code, reason) => {
      if (current()) void this.handleUpstreamClose(sessionId, code, reason);
    });
    ws.on('unexpected-response', (_req, res) => {
      let body = '';
      res.on('data', (chunk: Buffer) => {
        body += chunk.toString();
      });
      res.on('end', () => {
        console.error(
          `[Grok] Upstream upgrade rejected: HTTP ${res.statusCode} for ${short}... — ${body || '(empty body)'}`,
        );
        // ws only aborts the handshake itself when nothing listens for this
        // event; with a listener registered we must terminate explicitly or
        // the socket sits in CONNECTING and neither 'close' nor 'error' fires.
        try {
          ws.terminate();
        } catch {
          /* already gone */
        }
      });
    });

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        if (state.upstream === ws) state.upstream = null;
        try {
          ws.terminate();
        } catch {
          /* ignore */
        }
        reject(new Error(`xAI socket did not open within ${this.upstreamOpenTimeoutMs}ms`));
      }, this.upstreamOpenTimeoutMs);
      timer.unref?.();
      const onOpen = () => {
        cleanup();
        resolve();
      };
      const onFail = () => {
        cleanup();
        if (state.upstream === ws) state.upstream = null;
        reject(new Error('xAI socket closed before opening'));
      };
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

    if (state.ended || state.endRequested || state.upstream !== ws) {
      // The session ended (or the participant pressed end) while the socket
      // was opening. Never leave a billable orphan at xAI.
      try {
        ws.close(1000, 'Session ended');
      } catch {
        /* ignore */
      }
      if (state.upstream === ws) state.upstream = null;
      return;
    }

    console.log(`[Grok] Upstream open for ${short}...${resume ? ' (resumed leg)' : ''}; configuring session`);
    state.upstream.send(JSON.stringify({ type: 'session.update', session: state.sessionConfig }));
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
        state.endRequested = true;
        this.cancelResume(state);
        this.closeUpstream(state, 1000, 'participant ended');
        break;
      case 'mic':
        if (global.io) {
          void broadcastAdminEventForSession(
            global.io,
            'session:activity',
            {
              sessionId,
              lastActivity: new Date(),
              deltaMessages: 0,
              mic: msg.on === true,
            },
            sessionId,
          );
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
    if (state.endRequested || state.reconnectWindowMs <= 0) {
      // The participant pressed end (POST /end is on its way), or reconnection
      // is disabled. No browser means no microphone and nobody listening;
      // keeping the xAI session open would only bill. Close it now, then end
      // the session unless POST /end lands first (disconnect() clears the timer).
      this.closeUpstream(state, 1000, 'client disconnected');
      this.armOrphanTimer(sessionId, this.clientLossGraceMs, 'client_disconnected');
      return;
    }
    // A network blip, a backgrounded tab, a laptop lid. Keep the xAI session
    // alive for the window so the browser can re-attach to it in place
    // (attachClient); the assistant's audio in between is dropped (nobody is
    // listening), its transcript is still persisted. The window bounds the
    // billing exposure; past it the session ends, fail closed.
    this.broadcastStatus(
      sessionId,
      'client_reconnecting',
      `Participant socket lost; waiting up to ${Math.round(state.reconnectWindowMs / 1000)} s for a reconnect`,
    );
    // While the upstream is itself being resumed its deadline (the same timer
    // slot) already bounds everything; the browser's window is armed when the
    // resume completes (onUpstreamResumed).
    if (!state.resuming) this.armOrphanTimer(sessionId, state.reconnectWindowMs, 'client_disconnected');
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
          await pool
            .query('UPDATE session_configurations SET ai_model = $1 WHERE session_id = $2', [session.model, sessionId])
            .catch((err) => console.error('[Grok] Failed to pin resolved model:', err));
        }
        break;
      }

      case 'conversation.created': {
        // The resumption key: "capture the server's conversation.created.
        // conversation.id and pass it back as ?conversation_id=<id>".
        const conversation = event.conversation as { id?: string } | undefined;
        if (conversation?.id && !state.conversationId) {
          state.conversationId = conversation.id;
          console.log(`[Grok] ${sessionId.substring(0, 12)}... conversation ${conversation.id} (resumable)`);
        } else if (conversation?.id && state.conversationId && conversation.id !== state.conversationId) {
          // xAI minted a NEW conversation for the re-dial: the cache was not
          // honoured (expired, or the id was unknown). Record it so the live
          // results are honest, and key any further resume to the new id.
          console.warn(
            `[Grok] ${sessionId.substring(0, 12)}... resume produced a new conversation ${conversation.id} (was ${state.conversationId})`,
          );
          state.conversationId = conversation.id;
        }
        break;
      }

      case 'conversation.item.created':
      case 'conversation.item.added': {
        // On a resumed leg xAI echoes the cached turns back as these events
        // before the first new turn (`.created` per the docs; live items on
        // 3.0 arrive as `.added`, observed 2026-10-23). They were persisted,
        // relayed and scored on the leg that produced them; replaying nothing
        // is the contract. Counted while the resumed leg is being configured
        // (live 2026-10-23: the replay arrives between the open and
        // session.updated) so the record says what xAI actually replayed.
        if (state.resuming) {
          state.replayedItems += 1;
          const item = event.item as { id?: string; type?: string; role?: string } | undefined;
          console.log(
            `[Grok] ${sessionId.substring(0, 12)}... replayed item ${item?.id ?? '?'} (${item?.type ?? '?'}${item?.role ? `/${item.role}` : ''})`,
          );
        }
        break;
      }

      case 'session.updated': {
        const first = !state.everReady;
        state.ready = true;
        state.everReady = true;
        if (global.io) {
          void broadcastAdminEventForSession(
            global.io,
            'session:openai-update',
            {
              sessionId,
              eventType: event.type,
              data: event,
            },
            sessionId,
          );
        }
        if (first) {
          this.sendToClient(sessionId, { type: 'ready', model: state.resolvedModel ?? state.model });
          await this.onSessionReady(sessionId);
        } else if (state.resuming) {
          await this.onUpstreamResumed(sessionId);
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
          try {
            this.sendUpstream(sessionId, { type: 'response.cancel' });
          } catch {
            /* closing */
          }
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
        if (isBenignCancelError(err)) {
          // Barge-in cancel landed after the reply already completed (seen in
          // Sagers' 2026-09-22 sessions, ai-therapist-258). Not a session error:
          // do not mark the session, alarm the admin view, or toast the participant.
          console.log(`[Grok] benign cancel race for ${sessionId.substring(0, 12)}...: ${err?.message}`);
          break;
        }
        console.error(`[Grok] API error for ${sessionId.substring(0, 12)}...:`, err ?? event);
        await pool
          .query('UPDATE therapy_sessions SET sideband_error = $1 WHERE session_id = $2', [
            err?.message ?? JSON.stringify(event).slice(0, 500),
            sessionId,
          ])
          .catch(() => {});
        this.sendToClient(sessionId, {
          type: 'error',
          message: err?.message ?? 'Voice service error',
          code: err?.code ?? null,
        });
        if (global.io) {
          void broadcastAdminEventForSession(
            global.io,
            'sideband:error',
            { sessionId, error: err ?? event },
            sessionId,
          );
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
      void broadcastAdminEventForSession(
        global.io,
        'sideband:connected',
        {
          sessionId,
          callId: null,
          channel: 'grok',
          model: state.resolvedModel ?? state.model,
          connectedAt: new Date(),
        },
        sessionId,
      );
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
    if (state) {
      const prev = state.lastUserTurn;
      const now = Date.now();
      // Same item re-completed, or the same words again within seconds with no
      // assistant reply in between: xAI reported one utterance twice.
      // Persisting it would inflate message counts and double-score the crisis
      // pipeline (ai-therapist-258). A participant genuinely repeating
      // themselves after the assistant answered is NOT collapsed: the
      // assistant-turn counter has moved, and a repeated crisis utterance must
      // always be scored again.
      // An item id seen on an earlier leg (a resumed upstream replaying what
      // it cached) is never a new utterance either (ai-therapist-245).
      const sameItem = prev?.itemId === itemId || state.seenUserItems.has(itemId);
      const echoedBeforeAnyReply =
        prev &&
        prev.text === text &&
        now - prev.at < USER_TURN_DEDUPE_MS &&
        prev.assistantTurnIndex === state.assistantTurnIndex;
      if (sameItem || echoedBeforeAnyReply) {
        console.log(`[Grok] duplicate user transcript dropped for ${sessionId.substring(0, 12)}... (${itemId})`);
        return;
      }
      state.lastUserTurn = { itemId, text, at: now, assistantTurnIndex: state.assistantTurnIndex };
      rememberItem(state.seenUserItems, itemId);
      state.userTurnIndex += 1;
    }
    this.emitTranscript(sessionId, { role: 'user', itemId, text, final: true });

    void (async () => {
      let messageId: string | number | null = null;
      try {
        const inserted = await insertMessagesBatch([
          {
            session_id: sessionId,
            role: 'user',
            // 'voice' so analytics count this as a voice turn (see sidebandManager).
            message_type: 'voice',
            content: text,
            content_redacted: null,
            metadata: { channel: 'grok', item_id: itemId },
          },
        ]);
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
    if (state.seenAssistantItems.has(itemId)) {
      // Already persisted (a resumed leg re-reporting an item). Never a second row.
      console.log(`[Grok] duplicate assistant item dropped for ${sessionId.substring(0, 12)}... (${itemId})`);
      return;
    }
    rememberItem(state.seenAssistantItems, itemId);

    state.assistantTurnIndex += 1;
    this.emitTranscript(sessionId, { role: 'assistant', itemId, text, final: true });
    void insertMessagesBatch([
      {
        session_id: sessionId,
        role: 'assistant',
        message_type: 'response',
        content: text,
        content_redacted: null,
        metadata: { channel: 'grok', item_id: itemId },
      },
    ]).catch((err) =>
      console.error(`[Grok] Failed to persist assistant turn for ${sessionId.substring(0, 12)}...:`, err),
    );

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
    void this.breakRefusalLoop(sessionId, action, text, streak).catch((err) =>
      console.error(`[Grok] Refusal recovery failed for ${sessionId.substring(0, 12)}...:`, err),
    );
  }

  private async breakRefusalLoop(
    sessionId: string,
    action: 'steer' | 'recover',
    refusalText: string,
    streak: number,
  ): Promise<void> {
    const state = this.sessions.get(sessionId);
    if (!state || state.ended) return;
    const short = sessionId.substring(0, 12);
    console.warn(`[Grok] Refusal loop for ${short}...: ${streak} in a row; action=${action}`);

    if (global.io) {
      void broadcastAdminEventForSession(
        global.io,
        'sideband:status-update',
        {
          sessionId,
          status: 'refusal_loop',
          action,
          streak,
          error: `Model refused ${streak} turns in a row: ${refusalText.slice(0, 200)}`,
          timestamp: new Date(),
        },
        sessionId,
      );
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
    await insertMessagesBatch([
      {
        session_id: sessionId,
        role: 'assistant',
        message_type: 'response',
        content: line,
        content_redacted: null,
        metadata: { channel: 'grok', item_id: itemId, server_authored: true, reason: 'refusal_loop' },
      },
    ]).catch((err) => console.error('[Grok] Failed to persist refusal recovery line:', err));

    // Visible to admins alongside crisis interventions.
    try {
      const { logInterventionAction } = await import('./crisisDetection.service.js');
      await logInterventionAction(sessionId, 'voice_refusal_recovery', {
        channel: 'grok',
        streak,
        refusal: refusalText.slice(0, 500),
        delivered: 'transcript',
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
    void broadcastAdminEventForSession(
      global.io,
      'sideband:transcript',
      {
        sessionId,
        itemId: payload.itemId,
        role: payload.role,
        ...(payload.final ? { text: payload.text } : { delta: payload.text }),
        final: payload.final,
        timestamp: new Date(),
      },
      sessionId,
    );
    void broadcastAdminEventForSession(
      global.io,
      'session:activity',
      {
        sessionId,
        lastActivity: new Date(),
        deltaMessages: payload.final ? 1 : 0,
      },
      sessionId,
    );
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

    await insertMessagesBatch([
      {
        session_id: sessionId,
        role: 'system',
        message_type: 'tool_call',
        content: `Tool called: ${call.name}`,
        content_redacted: null,
        metadata: { tool_name: call.name, call_id: callId, arguments: args, channel: 'grok', status: 'executing' },
      },
    ]).catch((err) => console.error('[Grok] Failed to log tool call:', err));

    if (global.io) {
      void broadcastAdminEventForSession(
        global.io,
        'sideband:tool-call',
        {
          sessionId,
          callId,
          toolName: call.name,
          args,
          status: 'executing',
          timestamp: new Date(),
        },
        sessionId,
      );
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

    await insertMessagesBatch([
      {
        session_id: sessionId,
        role: 'system',
        message_type: 'tool_response',
        content: failure ? `Tool error: ${call.name}` : `Tool response: ${call.name}`,
        content_redacted: null,
        metadata: {
          tool_name: call.name,
          call_id: callId,
          channel: 'grok',
          ...(failure ? { error: failure, status: 'failed' } : { response: result, status: 'completed' }),
        },
      },
    ]).catch((err) => console.error('[Grok] Failed to log tool response:', err));

    if (global.io) {
      void broadcastAdminEventForSession(
        global.io,
        'sideband:tool-call',
        {
          sessionId,
          callId,
          toolName: call.name,
          args,
          ...(failure ? { error: failure, status: 'failed' } : { result, status: 'completed' }),
          timestamp: new Date(),
        },
        sessionId,
      );
    }

    import('../db/index.js')
      .then((db) => db.insertToolInvocation(sessionId, call.name, failure ? null : args, !failure))
      .catch((err) => console.error('[Grok] Failed to log tool invocation:', err));
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
    const usage = event.usage as
      | {
          input_tokens?: number;
          output_tokens?: number;
          billable_audio_seconds?: number;
        }
      | undefined;
    if (!usage) return;

    const model = state.resolvedModel ?? state.model;
    if (typeof usage.billable_audio_seconds === 'number') {
      const secs = usage.billable_audio_seconds;
      if (state.legFresh) {
        // First figure on a new upstream leg. If xAI's counter carried across
        // the resume (the figure is at least what the previous leg reached)
        // it is still one cumulative session total: assign it. If it restarted
        // from zero for the new socket, the previous leg's total becomes the
        // offset and this leg's cumulative figure is assigned on top of it.
        // Either way no two snapshots are ever added together.
        state.legFresh = false;
        if (state.legBase > 0) {
          const carried = secs >= state.legBase;
          console.log(
            `[Grok] ${sessionId.substring(0, 12)}... first usage on resumed leg: ${secs} s ` +
              (carried
                ? `(counter carried across the resume; previous total ${state.legBase} s)`
                : `(counter restarted; offset ${state.legBase} s)`),
          );
          if (carried) state.legBase = 0;
        }
        state.legSeconds = 0;
      }
      state.legSeconds = Math.max(state.legSeconds, secs);
      state.billableSeconds = Math.max(state.billableSeconds, state.legBase + state.legSeconds);
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
        sessionId,
        turnIndex: state.userTurnIndex,
        userDoneAt,
        firstOutputAt,
        responseDoneAt: new Date(),
        channel: 'realtime',
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
      finalized: true,
      closeReason,
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
    return Array.from(this.sessions.keys()).filter((id) => this.isConnected(id));
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
    const state = this.sessions.get(sessionId);
    if (state && !state.ended && state.resuming) {
      // The upstream is being re-dialled. A crisis steer must not be lost to
      // the gap: it is delivered the moment the session is back (bounded by
      // the reconnect window, after which the session ends and the queue dies
      // with it).
      state.queuedSteers.push({ role, text, respond });
      console.log(
        `[Grok] steer queued during resume for ${sessionId.substring(0, 12)}... (${state.queuedSteers.length} pending)`,
      );
      return true;
    }
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
    this.sendUpstream(
      sessionId,
      response && Object.keys(response).length > 0
        ? { type: 'response.create', response }
        : { type: 'response.create' },
    );
  }

  /** Admin "trigger tool": pin tool_choice for one response, then restore auto. */
  async triggerTool(sessionId: string, toolName: string, args?: Record<string, unknown>): Promise<void> {
    const state = this.sessions.get(sessionId);
    if (!state) throw new Error('Grok voice connection not active');
    await this.updateSession(sessionId, { tool_choice: { type: 'function', name: toolName } });
    state.toolChoicePinned = true;
    const argsContext =
      args && Object.keys(args).length > 0 ? ` Use this context for the tool arguments: ${JSON.stringify(args)}.` : '';
    await this.injectMessage(
      sessionId,
      'system',
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
    this.cancelResume(state);
    this.clearTimers(state);
    this.finalizeAssistantTurn(sessionId, 'disconnect');
    await this.persistFinalUsage(sessionId, 'close_requested');

    this.sendToClient(sessionId, { type: 'closed', reason: 'ended' });
    this.closeUpstream(state, 1000, 'Session ended');
    if (state.client) {
      try {
        state.client.close(1000, 'Session ended');
      } catch {
        /* already gone */
      }
      state.client = null;
    }
    this.sessions.delete(sessionId);

    await pool
      .query(
        `UPDATE therapy_sessions
          SET sideband_connected = FALSE, sideband_disconnected_at = CURRENT_TIMESTAMP
        WHERE session_id = $1`,
        [sessionId],
      )
      .catch(() => {});
    if (global.io) {
      void broadcastAdminEventForSession(
        global.io,
        'sideband:disconnected',
        {
          sessionId,
          code: 1000,
          reason: 'Session ended',
          disconnectedAt: new Date(),
        },
        sessionId,
      );
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
    await pool
      .query('UPDATE therapy_sessions SET sideband_error = $1 WHERE session_id = $2', [error.message, sessionId])
      .catch(() => {});
    if (global.io) {
      void broadcastAdminEventForSession(
        global.io,
        'sideband:status-update',
        {
          sessionId,
          status: 'error',
          error: error.message,
          timestamp: new Date(),
        },
        sessionId,
      );
    }
  }

  private async handleUpstreamClose(sessionId: string, code: number, reason: Buffer): Promise<void> {
    const state = this.sessions.get(sessionId);
    console.log(
      `[Grok] Upstream closed for ${sessionId.substring(0, 12)}...: ${code} - ${reason?.toString() || 'no reason'}`,
    );
    if (!state) return;
    state.upstream = null;
    state.ready = false;
    if (state.keepalive) {
      clearInterval(state.keepalive);
      state.keepalive = null;
    }
    if (state.ended) return;

    const wasInFlight = state.responseInFlight;
    state.responseInFlight = false;
    this.finalizeAssistantTurn(sessionId, 'upstream_closed');
    if (code === 1000) {
      await this.persistFinalUsage(sessionId, 'close_requested');
      return;
    }

    // We did not ask for this close (the participant-end and client-loss paths
    // set the state before closing). If xAI gave us a conversation id and the
    // window allows it, re-dial with the id: xAI replays its cache and the
    // conversation continues. Otherwise the conversation cannot continue and
    // there is no monitoring without the upstream, so fail closed.
    if (state.conversationId && state.reconnectWindowMs > 0 && !state.endRequested) {
      // Snapshot, not final: the next leg's figure lands on top of it.
      const { recordLiveUsage } = await import('../db/liveUsage.queries.js');
      await recordLiveUsage(sessionId, state.resolvedModel ?? state.model, state.billableSeconds, { finalized: false });
      if (state.resuming) {
        // A re-dialled leg opened and died before it was configured. Try
        // again; the window armed by beginResume still bounds the effort.
        this.scheduleResumeAttempt(sessionId);
      } else {
        state.resumeInterrupted = wasInFlight;
        this.beginResume(sessionId);
      }
      return;
    }
    await this.persistFinalUsage(sessionId, 'connection_lost');
    await this.failClosed(
      sessionId,
      'upstream_lost',
      'The connection to the voice service was lost. Nothing you shared was lost. ' +
        'You can start a new session whenever you are ready.',
    );
  }

  // -------------------------------------------------------------------------
  // Upstream resumption (ai-therapist-245)
  // -------------------------------------------------------------------------

  /**
   * Start re-dialling xAI with the cached conversation id. Attempts back off
   * (RESUME_BACKOFF_MS) and the whole effort is bounded by the reconnect
   * window: when it elapses with no upstream, the orphan timer ends the
   * session. One `sideband:status-update` marks the transition; the matching
   * `connected` (or the fail-closed end) is the only other one.
   */
  private beginResume(sessionId: string): void {
    const state = this.sessions.get(sessionId);
    if (!state || state.ended || state.resuming) return;
    state.resuming = true;
    state.resumeAttempt = 0;
    state.replayedItems = 0;
    const windowS = Math.round(state.reconnectWindowMs / 1000);
    console.warn(
      `[Grok] Upstream lost for ${sessionId.substring(0, 12)}...; resuming conversation ${state.conversationId} (window ${windowS} s)`,
    );
    this.sendToClient(sessionId, { type: 'link', state: 'reconnecting' });
    this.broadcastStatus(
      sessionId,
      'upstream_reconnecting',
      `Voice service connection lost; resuming conversation within ${windowS} s`,
    );
    this.armResumeDeadline(sessionId);
    void this.attemptResume(sessionId);
  }

  /**
   * The window for an upstream resume: past it, fail closed as before. Uses
   * the orphan-timer slot, so a browser-loss timer is superseded by it; a
   * browser that is also gone is covered because nothing can continue until
   * the upstream is back, and its own window is armed at that point.
   */
  private armResumeDeadline(sessionId: string): void {
    const state = this.sessions.get(sessionId);
    if (!state) return;
    this.armOrphanTimer(sessionId, state.reconnectWindowMs, 'upstream_lost');
  }

  private async attemptResume(sessionId: string): Promise<void> {
    const state = this.sessions.get(sessionId);
    if (!state || state.ended || !state.resuming || state.endRequested) return;
    const short = sessionId.substring(0, 12);
    state.resumeAttempt += 1;
    try {
      state.legFresh = true;
      state.legBase = state.billableSeconds;
      state.legSeconds = 0;
      await this.openUpstream(sessionId, true);
      // session.updated on the new leg completes the resume (onUpstreamResumed).
    } catch (err) {
      console.error(
        `[Grok] Resume attempt ${state.resumeAttempt} failed for ${short}...:`,
        err instanceof Error ? err.message : err,
      );
      this.scheduleResumeAttempt(sessionId);
    }
  }

  /** Next re-dial after backoff (RESUME_BACKOFF_MS by attempts so far). */
  private scheduleResumeAttempt(sessionId: string): void {
    const state = this.sessions.get(sessionId);
    if (!state || !state.resuming || state.ended || state.resumeTimer) return;
    const delay = RESUME_BACKOFF_MS[Math.min(Math.max(0, state.resumeAttempt - 1), RESUME_BACKOFF_MS.length - 1)];
    state.resumeTimer = setTimeout(() => {
      state.resumeTimer = null;
      void this.attemptResume(sessionId);
    }, delay);
    state.resumeTimer.unref?.();
  }

  /** The resumed leg is configured: deliver what waited, and carry on. */
  private async onUpstreamResumed(sessionId: string): Promise<void> {
    const state = this.sessions.get(sessionId);
    if (!state || state.ended) return;
    state.resuming = false;
    state.upstreamResumes += 1;
    this.clearOrphanTimer(state);
    if (state.client && state.client.readyState !== WebSocket.OPEN) {
      // The browser is gone too: its own window applies from here.
      this.armOrphanTimer(sessionId, state.reconnectWindowMs, 'client_disconnected');
    }
    console.log(
      `[Grok] Upstream resumed for ${sessionId.substring(0, 12)}... (resume ${state.upstreamResumes}, ${state.replayedItems} replayed items)`,
    );
    this.sendToClient(sessionId, { type: 'link', state: 'restored' });
    this.broadcastStatus(
      sessionId,
      'connected',
      `Voice service connection restored (resume ${state.upstreamResumes}, ${state.replayedItems} cached turns replayed)`,
    );
    await pool
      .query('UPDATE therapy_sessions SET sideband_connected = TRUE, sideband_error = NULL WHERE session_id = $1', [
        sessionId,
      ])
      .catch(() => {});

    const queued = state.queuedSteers.splice(0);
    for (const steer of queued) {
      try {
        await this.injectMessage(sessionId, steer.role, steer.text, steer.respond);
      } catch (err) {
        console.error(
          `[Grok] Queued steer could not be delivered after resume for ${sessionId.substring(0, 12)}...:`,
          err,
        );
      }
    }
    if (state.resumeInterrupted && !queued.some((q) => q.respond)) {
      // The participant heard a reply stop mid-sentence. Ask the model to
      // finish the thought rather than leave a silence it does not know about.
      state.resumeInterrupted = false;
      try {
        await this.injectMessage(
          sessionId,
          'system',
          'The voice connection dropped for a moment and your last reply was cut off. ' +
            'Briefly pick up where you left off in one or two sentences, then listen. ' +
            'Do not mention the connection.',
          true,
        );
      } catch (err) {
        console.error('[Grok] Post-resume continuation failed:', err);
      }
    }
    state.resumeInterrupted = false;
  }

  private cancelResume(state: GrokSessionState): void {
    state.resuming = false;
    if (state.resumeTimer) {
      clearTimeout(state.resumeTimer);
      state.resumeTimer = null;
    }
  }

  /**
   * Test hook (red-team harness `--voice-drop-upstream-midway`): sever the
   * xAI socket the way a network fault would, so the resume path runs against
   * the live API. Returns false when there is nothing to drop.
   */
  _dropUpstreamForTests(sessionId: string): boolean {
    const state = this.sessions.get(sessionId);
    const ws = state?.upstream;
    if (!state || !ws) return false;
    try {
      ws.terminate();
    } catch {
      /* ignore */
    }
    return true;
  }

  /** What the harness and admin tooling may want to know about a session's links. */
  getLinkStats(sessionId: string): {
    conversationId: string | null;
    clientReconnects: number;
    upstreamResumes: number;
    replayedItems: number;
    resuming: boolean;
  } | null {
    const state = this.sessions.get(sessionId);
    if (!state) return null;
    return {
      conversationId: state.conversationId,
      clientReconnects: state.clientReconnects,
      upstreamResumes: state.upstreamResumes,
      replayedItems: state.replayedItems,
      resuming: state.resuming,
    };
  }

  /** End an active session that can no longer be conducted or monitored. */
  private async failClosed(sessionId: string, reason: string, message: string): Promise<void> {
    const state = this.sessions.get(sessionId);
    if (!state || state.ended) return;
    this.sendToClient(sessionId, { type: 'closed', reason });
    if (global.io) {
      void broadcastAdminEventForSession(
        global.io,
        'sideband:unmonitored',
        {
          sessionId,
          reason,
          endedAt: new Date(),
        },
        sessionId,
      );
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

  /** One `sideband:status-update` per link transition (admin Live Monitoring). */
  private broadcastStatus(sessionId: string, status: string, detail: string): void {
    if (!global.io) return;
    void broadcastAdminEventForSession(
      global.io,
      'sideband:status-update',
      {
        sessionId,
        status,
        error: status === 'connected' ? undefined : detail,
        detail,
        timestamp: new Date(),
      },
      sessionId,
    );
  }

  private sendToClient(sessionId: string, msg: GrokServerMessage): void {
    const client = this.sessions.get(sessionId)?.client;
    if (client && client.readyState === WebSocket.OPEN) {
      try {
        client.send(JSON.stringify(msg));
      } catch (err) {
        console.error(`[Grok] Client send failed for ${sessionId.substring(0, 12)}...:`, err);
      }
    }
  }

  private closeUpstream(state: GrokSessionState, code: number, reason: string): void {
    const ws = state.upstream;
    if (!ws) return;
    state.upstream = null;
    state.ready = false;
    if (state.keepalive) {
      clearInterval(state.keepalive);
      state.keepalive = null;
    }
    try {
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) ws.close(code, reason);
    } catch {
      /* already gone */
    }
  }

  private startKeepalive(sessionId: string): void {
    const state = this.sessions.get(sessionId);
    if (!state) return;
    if (state.keepalive) clearInterval(state.keepalive);
    const timer = setInterval(() => {
      const s = this.sessions.get(sessionId);
      if (s?.upstream && s.upstream.readyState === WebSocket.OPEN) {
        try {
          s.upstream.ping();
        } catch {
          /* ignore */
        }
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
      if (s.resuming) {
        // The upstream never came back inside the window.
        console.warn(`[Grok] Resume window elapsed for ${sessionId.substring(0, 12)}...; ending the session.`);
        this.cancelResume(s);
        void this.persistFinalUsage(sessionId, 'connection_lost').then(() =>
          this.failClosed(
            sessionId,
            'upstream_lost',
            'The connection to the voice service was lost and could not be restored. ' +
              'Nothing you shared was lost. You can start a new session whenever you are ready.',
          ),
        );
        return;
      }
      if (s.client && s.client.readyState === WebSocket.OPEN) return; // reattached in time
      console.warn(`[Grok] Session ${sessionId.substring(0, 12)}... orphaned (${reason}); ending it.`);
      void this.failClosed(
        sessionId,
        reason,
        'Your session ended because the connection to our server was lost. Nothing you shared was lost.',
      );
    }, delayMs);
    timer.unref?.();
    state.orphanTimer = timer;
  }

  private clearOrphanTimer(state: GrokSessionState): void {
    if (state.orphanTimer) {
      clearTimeout(state.orphanTimer);
      state.orphanTimer = null;
    }
  }

  private async schedulePhaseNudges(sessionId: string): Promise<void> {
    const state = this.sessions.get(sessionId);
    if (!state || state.phaseTimers.length > 0) return;
    try {
      const { buildPhaseNudgeSchedule } = await import('../utils/phaseGuidance.js');
      for (const phase of await buildPhaseNudgeSchedule(sessionId)) {
        const timer = setTimeout(() => {
          this.tryInject(sessionId, 'system', phase.text, false)
            .then(
              (ok) =>
                ok && console.log(`[Grok] Phase nudge (${phase.at * 100}%) sent to ${sessionId.substring(0, 12)}...`),
            )
            .catch((err) => console.error('[Grok] Phase nudge failed:', err));
        }, phase.delayMs);
        timer.unref?.();
        state.phaseTimers.push(timer);
      }
    } catch (err) {
      console.error('[Grok] Phase nudge scheduling failed:', err);
    }
  }

  private clearTimers(state: GrokSessionState): void {
    if (state.resumeTimer) {
      clearTimeout(state.resumeTimer);
      state.resumeTimer = null;
    }
    if (state.keepalive) clearInterval(state.keepalive);
    state.phaseTimers.forEach((t) => clearTimeout(t));
    this.clearOrphanTimer(state);
    state.keepalive = null;
    state.phaseTimers = [];
  }
}

export const grokVoiceManager = new GrokVoiceManager();
