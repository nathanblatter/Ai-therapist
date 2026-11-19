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
import { emitCrisisResources } from './crisisResources.js';
import { buildRecoverySpeakFirstNudge, type RecoveryCrisisContact } from '../../shared/recoveryPrompt.js';

/**
 * When the server re-sends the speak-first instruction to a recovery session
 * that has not spoken, in ms after `session.started`. A healthy recovery
 * session starts speaking 0.6 to 1.6 s after `session.started` (up to 3.2 s
 * for a browser still on the older instructions-append delivery; measured
 * 2026-11-18), so the first re-send waits out that range before acting.
 */
export const RECOVERY_SPEAK_RETRY_MS = [4_000, 8_000] as const;

/**
 * A steer must never leave the participant in silence (ai-therapist-313).
 *
 * `session.instructions.append` "can interrupt speech in progress and apply a
 * new instruction" (voice-server-controls, "Redirect the conversation"). Our
 * crisis steers arrive about a second after a disclosure, which is exactly
 * when the voice model is in the middle of answering it, and nothing in them
 * told the model to go on: measured 2026-11-18, the reply stopped mid-sentence
 * in about 7 of 8 voice-layer answers to a passive disclosure, and in
 * continuous calls the participant then sat through 68 to 105 s of silence.
 *
 * Two layers. Every clinical steer is delivered with LIVE_STEER_KEEP_SPEAKING
 * appended, so the interruption is followed by speech. And the sideband
 * watches: if a steer landed while a reply was owed and the assistant has
 * still said nothing STEER_RESUME_CHECK_MS later (and the participant is not
 * talking), it tells the model to speak, once per check.
 */
export const CLINICAL_STEER_MARKER = '[Clinical guidance';
export const LIVE_STEER_KEEP_SPEAKING =
  'This guidance does not end your turn. If you were speaking when it arrived, or the participant is waiting for ' +
  'your reply, speak again now and follow it; do not go silent.';
export const LIVE_STEER_RESUME_COMMENTARY =
  'The participant is waiting and you have stopped speaking. Speak now: respond to what they just said, following ' +
  'the guidance you were given. Do not stay silent.';
export const STEER_RESUME_CHECK_MS = [3_000, 7_000] as const;
/** A reply is owed if the assistant spoke, or the participant finished speaking, this recently before the steer. */
const STEER_REPLY_OWED_WINDOW_MS = 6_000;
/** Fragments of the interrupted sentence keep arriving for about this long after a steer. */
const STEER_INTERRUPT_TAIL_MS = 1_200;
/** The participant counts as still talking if a fragment of theirs arrived this recently. */
const STEER_PARTICIPANT_TALKING_MS = 1_500;

/** A clinical steer as delivered to a live voice model: the text, then the keep-speaking line, inside the append cap. */
export function withKeepSpeaking(text: string): string {
  if (!text.startsWith(CLINICAL_STEER_MARKER) || text.includes(LIVE_STEER_KEEP_SPEAKING)) return text;
  const room = 1600 - LIVE_STEER_KEEP_SPEAKING.length - 1;
  return `${text.length > room ? text.slice(0, room) : text} ${LIVE_STEER_KEEP_SPEAKING}`;
}

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

    const text = ordered.map((f) => f.delta).join('');
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

/**
 * How a GPT-Live session hands work to a backend (see buildLiveSessionConfig).
 * 'responses' is every ordinary session: a Responses backend owns the clinical
 * prompt and the tools. 'client' is a crisis RECOVERY session, which runs with
 * no backend and no tools by design, so it has no `session.delegation.responses`
 * to update.
 */
export type LiveDelegationMode = 'responses' | 'client';

/**
 * Thrown instead of sending a `session.delegation.responses` update to a
 * client-delegated (recovery) session. The Live API rejects that update with
 * "Missing required parameter: session.delegation.type" (ai-therapist-282), and
 * the rejection arrives asynchronously as a data-channel error the caller never
 * sees, so refusing up front is the only way to report it honestly.
 */
export class LiveDelegationUnsupportedError extends Error {
  readonly code = 'live_delegation_unsupported' as const;
  constructor(
    readonly sessionId: string,
    readonly operation: string,
  ) {
    super(
      `${operation} is unavailable on a crisis recovery session: it runs without a backend or tools by design. ` +
        'Use End Session to end it.',
    );
    this.name = 'LiveDelegationUnsupportedError';
  }
}

/** Per-session mutable state for a Live sideband. */
interface LiveSessionState {
  ws: WebSocket;
  liveSessionId: string;
  apiKey: string;
  model: string;
  backendModel: string;
  /** Fixed at session creation; carried across reconnects. */
  delegationMode: LiveDelegationMode;
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
  /**
   * Delegation timing, keyed by delegation id: when GPT-Live handed the turn to
   * the backend and when the backend's first text arrived. In voice the
   * participant waits on exactly this interval, so it is what a backend model
   * change has to be judged on. Logged per backend response; see
   * logDelegationTiming.
   */
  delegationTimings: Map<string, { startedAt: number; firstTextAt: number | null }>;
  /** Latest cumulative voice seconds from session.usage.updated. */
  lastUsageSeconds: number;
  peakContextRatio: number;
  /** Set once session.closed arrives; final usage is confirmed. */
  finalized: boolean;
  keepalive: NodeJS.Timeout | null;
  phaseTimers: NodeJS.Timeout[];
  /** True once any assistant speech has been transcribed on this attach. */
  assistantSpoke: boolean;
  /** Arrival time of the newest assistant / participant transcript fragment (0 = none). */
  lastAssistantDeltaAt: number;
  lastUserDeltaAt: number;
  /** Pending "you went silent after a steer" checks. */
  steerResumeTimers: NodeJS.Timeout[];
  /**
   * This state was built by the route's opening attach (connectAndWait), not
   * by a reconnect or a post-deploy reattach. Unlike `initialAttach` it is
   * never cleared. The recovery speak-first watchdog arms only on it: a
   * sideband that rejoins a recovery conversation already in progress must
   * never tell the model to announce "I'm back" in the middle of it.
   */
  openingAttach: boolean;
  /** Recovery sessions only: pending "you have not spoken yet" re-nudges. */
  speakFirstTimers: NodeJS.Timeout[];
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
  /**
   * True while this is the OPENING attach driven by connectAndWait, and cleared
   * the moment the socket opens.
   *
   * During that window connectAndWait owns the outcome: it retries with backoff
   * and, if every attempt fails, the route hangs the OpenAI session up, marks
   * the session ended and tells the participant. The autonomous failure paths
   * (reconnect scheduling, failClosedUnmonitored) must stay out of it — they
   * would race the retry loop with a second socket and page the on-call about
   * a "lost monitoring connection" for a session in which nobody has spoken.
   */
  initialAttach: boolean;
}

/**
 * A second voice backend that owns some sessions and answers the same control
 * surface (docs/grok-voice.md). The GPT-Live manager is what every call site
 * imports — crisisIntervention, sessionLifecycle, toolRegistry, the admin
 * routes, index.ts — so rather than rewriting ~20 call sites and their test
 * mocks, a delegate registers here and each public method forwards to it for
 * the sessions it owns. Registration happens once at startup (index.ts); in
 * unit tests nothing registers and behaviour is exactly as before.
 */
export interface VoiceSidebandDelegate {
  /** Does this backend own the session (attached, connecting, or closing)? */
  owns(sessionId: string): boolean;
  isConnected(sessionId: string): boolean;
  getActiveConnections(): string[];
  tryInject(sessionId: string, role: 'system' | 'user', text: string, respond: boolean): Promise<boolean>;
  injectMessage(sessionId: string, role: 'system' | 'user', text: string, respond: boolean): Promise<void>;
  updateSession(sessionId: string, updates: Record<string, unknown>): Promise<void>;
  interrupt(sessionId: string): Promise<void>;
  createResponse(sessionId: string, response?: Record<string, unknown>): Promise<void>;
  triggerTool(sessionId: string, toolName: string, args?: Record<string, unknown>): Promise<void>;
  disconnect(sessionId: string, opts?: { graceMs?: number }): Promise<void>;
  shutdown(): Promise<void>;
}

/**
 * One structured line per completed backend response inside a delegation:
 * `firstTextMs` is delegation start to the backend's first output text (what
 * the participant waits on before the voice model can speak the answer),
 * `totalMs` is start to completion. A delegation that calls tools completes
 * more than one response; each logs its own line against the same start.
 * Grep `[Live] delegation timing` to compare backend models on real sessions.
 * `firstTextMs` is null on a response that only called tools; the text
 * arrives on the continuation response, which logs its own line.
 */
function logDelegationTiming(
  sessionId: string,
  delegationId: string | null,
  state: { delegationTimings: Map<string, { startedAt: number; firstTextAt: number | null }> },
  model: string,
  usage: { input_tokens?: number; output_tokens?: number } | undefined,
): void {
  if (!delegationId) return;
  const timing = state.delegationTimings.get(delegationId);
  if (!timing) return;
  const now = Date.now();
  console.log(
    '[Live] delegation timing',
    JSON.stringify({
      session: sessionId.substring(0, 12),
      delegationId,
      model,
      firstTextMs: timing.firstTextAt === null ? null : timing.firstTextAt - timing.startedAt,
      totalMs: now - timing.startedAt,
      outputTokens: usage?.output_tokens ?? null,
    }),
  );
}

export class SidebandManager {
  private sessions = new Map<string, LiveSessionState>();
  private delegates: VoiceSidebandDelegate[] = [];
  /** Sessions that have ended. Never re-attach: the live session id is gone. */
  private endedSessions = new Set<string>();
  /** Monotonic attach counter per session, so reconnects mint distinct row ids. */
  private attachSeqs = new Map<string, number>();

  private readonly maxReconnectAttempts = 3;
  private readonly reconnectDelayMs = 2000;
  /**
   * Opening-attach retry budget (ai-therapist-195). The attach is now a hard
   * gate on starting a voice session, so a single transient upgrade failure —
   * a 429, a 5xx, a TCP blip — would otherwise deny a participant their
   * session outright. Three tries inside one bounded wall-clock window.
   */
  private readonly attachAttempts = 3;
  /** Total wall-clock budget for the opening attach, retries and backoff included. */
  private readonly attachBudgetMs = 12_000;
  /** Cap on any single attach attempt, so an early one cannot eat the budget. */
  private readonly attachAttemptMs = 4000;
  /** Backoff before attach retry n (index 0 = before the second attempt). */
  private readonly attachBackoffMs = [400, 1200];
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

  /** Register another voice backend (see VoiceSidebandDelegate). Idempotent. */
  registerDelegate(delegate: VoiceSidebandDelegate): void {
    if (!this.delegates.includes(delegate)) this.delegates.push(delegate);
  }

  /** Test hook. */
  _clearDelegatesForTests(): void {
    this.delegates = [];
  }

  private delegateFor(sessionId: string): VoiceSidebandDelegate | null {
    for (const d of this.delegates) if (d.owns(sessionId)) return d;
    return null;
  }

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
    opts: { model: string; backendModel: string; delegationMode?: LiveDelegationMode; initialAttach?: boolean },
  ): Promise<WebSocket> {
    const initialAttach = opts.initialAttach === true;
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
    } catch {
      /* best-effort */
    }

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
      delegationMode: opts.delegationMode ?? 'responses',
      userTranscript: new TranscriptAssembler(this.turnGapMs, (text, startMs, endMs) =>
        this.onUserTurn(sessionId, text, startMs, endMs),
      ),
      assistantTranscript: new TranscriptAssembler(this.turnGapMs, (text, startMs, endMs) =>
        this.onAssistantTurn(sessionId, text, startMs, endMs),
      ),
      pendingCalls: new Map(),
      meteredResponses: new Set(),
      delegationTimings: new Map(),
      lastUsageSeconds: 0,
      peakContextRatio: 0,
      finalized: false,
      keepalive: null,
      phaseTimers: [],
      assistantSpoke: false,
      lastAssistantDeltaAt: 0,
      lastUserDeltaAt: 0,
      steerResumeTimers: [],
      openingAttach: initialAttach,
      speakFirstTimers: [],
      regrounding: null,
      toolChoiceReset: null,
      userTurnIndex: 0,
      assistantTurnIndex: 0,
      attachSeq: this.nextAttachSeq(sessionId),
      reconnectAttempts: 0,
      initialAttach,
    };
    this.sessions.set(sessionId, state);

    ws.on('open', () => this.handleOpen(sessionId, liveSessionId));
    ws.on('message', (data) => void this.handleMessage(sessionId, data));
    ws.on('error', (err) => void this.handleError(sessionId, err));
    ws.on('close', (code, reason) => void this.handleClose(sessionId, code, reason));
    ws.on('unexpected-response', (_req, res) => {
      let body = '';
      res.on('data', (chunk: Buffer) => {
        body += chunk.toString();
      });
      res.on('end', () => {
        const detail = `Live sideband upgrade rejected: HTTP ${res.statusCode} for ${liveSessionId} — ${body || '(empty body)'}`;
        console.error(`[Live] ${detail}`);
        // Abort the handshake explicitly. The ws library only calls
        // abortHandshake when 'unexpected-response' has NO listener
        // (ws/lib/websocket.js), so registering this handler suppresses it —
        // leaving the socket in CONNECTING, emitting neither 'close' nor
        // 'error'. connectAndWait waits on exactly those, so an attach
        // rejection (401 on a rotated key, 404, 429) could not fail fast and
        // always burned the full timeout before the participant was told.
        try {
          ws.terminate();
        } catch {
          /* already gone */
        }
        this.sessions.delete(sessionId);
        void this.logConnectionError(sessionId, new Error(detail));
        if (global.io) {
          void broadcastAdminEventForSession(
            global.io,
            'sideband:error',
            {
              sessionId,
              error: detail,
              statusCode: res.statusCode,
            },
            sessionId,
          );
        }
        // Do not leave an active voice session running with no monitoring —
        // UNLESS this is the opening attach, where connectAndWait is retrying
        // and the route already ends the session and tells the participant if
        // the retries run out. Firing here too would kill a session mid-retry
        // and page the on-call about a conversation that never started.
        if (!initialAttach) {
          void this.failClosedUnmonitored(sessionId, `attach rejected with HTTP ${res.statusCode}`);
        }
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
   * Retried with backoff inside a bounded wall-clock window: the attach is a
   * hard gate on starting the session, so one transient 429 or TCP blip must
   * not cost a participant their session. Every attempt and the final outcome
   * land on the session row (`sideband_error`, `sideband_connected`) so "never
   * attached" is queryable rather than inferred from an absence of rows.
   *
   * Rejects, after the budget is spent, on upgrade rejection, socket error, or
   * timeout.
   */
  async connectAndWait(
    sessionId: string,
    liveSessionId: string,
    apiKey: string,
    opts: {
      model: string;
      backendModel: string;
      delegationMode?: LiveDelegationMode;
      timeoutMs?: number;
      attempts?: number;
    },
  ): Promise<void> {
    const budgetMs = opts.timeoutMs ?? this.attachBudgetMs;
    const maxAttempts = Math.max(1, opts.attempts ?? this.attachAttempts);
    const deadline = Date.now() + budgetMs;
    let lastError: unknown = null;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      try {
        await this.attachOnce(
          sessionId,
          liveSessionId,
          apiKey,
          { model: opts.model, backendModel: opts.backendModel, delegationMode: opts.delegationMode },
          Math.min(this.attachAttemptMs, remaining),
        );
        return;
      } catch (err) {
        lastError = err;
        // A session that ended underneath us is not a transient failure.
        if (this.endedSessions.has(sessionId)) break;
        const backoff = this.attachBackoffMs[attempt - 1] ?? this.attachBackoffMs.at(-1) ?? 0;
        if (attempt >= maxAttempts || Date.now() + backoff >= deadline) break;
        console.warn(
          `[Live] Sideband attach attempt ${attempt}/${maxAttempts} failed for ` +
            `${sessionId.substring(0, 12)}... (${err instanceof Error ? err.message : String(err)}); ` +
            `retrying in ${backoff}ms.`,
        );
        await new Promise<void>((resolve) => {
          const t = setTimeout(resolve, backoff);
          t.unref?.();
        });
      }
    }

    const message = lastError instanceof Error ? lastError.message : String(lastError);
    const detail = `sideband attach failed after ${maxAttempts} attempts within ${budgetMs}ms: ${message}`;
    await this.logConnectionError(sessionId, new Error(detail));
    if (global.io) {
      void broadcastAdminEventForSession(
        global.io,
        'sideband:attach-failed',
        {
          sessionId,
          liveSessionId,
          error: detail,
          attempts: maxAttempts,
          failedAt: new Date(),
        },
        sessionId,
      );
    }
    throw lastError instanceof Error ? lastError : new Error(detail);
  }

  /** One attach attempt: open the socket and wait for it, or clean up after itself. */
  private async attachOnce(
    sessionId: string,
    liveSessionId: string,
    apiKey: string,
    opts: { model: string; backendModel: string; delegationMode?: LiveDelegationMode },
    timeoutMs: number,
  ): Promise<void> {
    const ws = await this.connect(sessionId, liveSessionId, apiKey, { ...opts, initialAttach: true });
    if (ws.readyState === WebSocket.OPEN) return;

    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          cleanup();
          reject(new Error(`Live sideband did not open within ${timeoutMs}ms`));
        }, timeoutMs);
        timer.unref?.();
        const onOpen = () => {
          cleanup();
          resolve();
        };
        const onFail = () => {
          cleanup();
          reject(new Error('Live sideband closed before opening'));
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
    } catch (err) {
      this.abandonAttach(sessionId, ws);
      throw err;
    }
  }

  /**
   * Drop a half-open attach.
   *
   * A timed-out attempt leaves a socket stuck in CONNECTING and its state still
   * in `this.sessions` — which both blocks the next attempt (connect() returns
   * the existing, dead socket) and leaves a socket that can open MINUTES later
   * and stamp sideband_connected = TRUE on a session the route already hung up
   * and ended.
   */
  private abandonAttach(sessionId: string, ws: WebSocket): void {
    const state = this.sessions.get(sessionId);
    if (state && state.ws === ws) {
      this.clearTimers(state);
      state.userTranscript.dispose();
      state.assistantTranscript.dispose();
      this.sessions.delete(sessionId);
    }
    try {
      ws.removeAllListeners();
      ws.terminate();
    } catch {
      /* already gone */
    }
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

  /**
   * OpenAI's safety filter terminated the voice session (session.closed with
   * reason 'content').
   *
   * This is not a normal end and must not be recorded or presented as one. It
   * happens disproportionately at crisis disclosure — which is precisely the
   * moment a participant must not experience the assistant disappearing.
   *
   * Three things have to happen, in this order of importance:
   *   1. Tell the participant's client so it can show crisis resources rather
   *      than the generic post-session screen. That is the actual harm.
   *   2. Tell the study team. The crisis SMS may already have fired from the
   *      risk pipeline, but "the platform cut the conversation" is a different
   *      fact from "risk was detected" and a human needs both.
   *   3. Record it, so how often the vendor terminates a therapeutic
   *      conversation is a measurable number rather than an anecdote.
   */
  private async handleModerationTermination(sessionId: string, cause: 'content_filter' | 'expired'): Promise<void> {
    const short = sessionId.substring(0, 12);
    const announce = (): void => {
      global.io?.to(`session:${sessionId}`).emit('session:moderation-terminated', {
        sessionId,
        reason: cause,
        message: 'The call was cut off. That was not your fault, and nothing you said was wrong.',
      });
      // The resource card too, on the same tick (ai-therapist-293). The cut can
      // land before our own pipeline has scored the turn (or on a turn it
      // scored below high), and until now the card depended on that score: in
      // 2 of 2 instrumented baseline cuts no card event went out at all.
      // Normally a no-op here, because the `error` that precedes the close
      // already sent it about half a second earlier.
      emitCrisisResources(sessionId, { reason: cause === 'content_filter' ? 'vendor_cut' : 'vendor_ceiling' });
    };

    // 1. Participant-facing. For the filter this goes out before anything
    // that can throw or stall (a DB round-trip included): it is the socket
    // backstop the recovery flow relies on when the data channel died with
    // the transport. For the vendor ceiling the crisis state decides whether
    // it is sent at all, so that one waits for the read.
    if (cause === 'content_filter') announce();

    // Was this session already known to be in crisis? For the filter it changes
    // what we tell the on-call ("cut during a flagged crisis" is more urgent).
    // For the vendor ceiling it decides everything, and it keys on HIGH
    // severity to match the timer lift and the client's own trigger: an
    // unflagged or lower-severity session that expires is an ordinary end.
    let flagged = false;
    let severity: string | null = null;
    try {
      const result = await pool.query<{ crisis_flagged: boolean | null; crisis_severity: string | null }>(
        'SELECT crisis_flagged, crisis_severity FROM therapy_sessions WHERE session_id = $1',
        [sessionId],
      );
      flagged = result.rows[0]?.crisis_flagged === true;
      severity = result.rows[0]?.crisis_severity ?? null;
    } catch (err) {
      console.error(`[Live] Could not read crisis state for ${short}...:`, err);
    }
    if (cause === 'expired') {
      if (!flagged || severity !== 'high') return;
      announce();
    }

    console.error(
      cause === 'content_filter'
        ? `[Live] MODERATION TERMINATION for ${short}... — OpenAI's safety filter ended this session. ` +
            'Surfacing crisis resources to the participant and alerting the study team.'
        : `[Live] VENDOR CEILING for ${short}... — the session expired during an active high crisis flag. ` +
            'Surfacing crisis resources and asking the client to reconnect.',
    );

    // 2. Alert the study team. Whether this is an SMS, a page folded into one
    // the on-call already has for this participant, or (no risk signal from
    // the participant) a record for review is decided in crisisPaging.service.
    try {
      const { pageVendorTermination } = await import('./crisisPaging.service.js');
      await pageVendorTermination({ sessionId, cause, flagged, severity });
    } catch (err) {
      console.error(`[Live] Failed to alert on ${cause} termination for ${short}...:`, err);
    }

    // 3. Record it against the session.
    try {
      const { logInterventionAction } = await import('./crisisDetection.service.js');
      await logInterventionAction(sessionId, 'external_api_called', {
        event: cause === 'content_filter' ? 'moderation_terminated_session' : 'session_expired_in_crisis',
        vendor: 'openai',
        crisisFlaggedAtTermination: flagged,
      });
    } catch (err) {
      console.error(`[Live] Failed to record ${cause} termination for ${short}...:`, err);
    }

    if (global.io) {
      void broadcastAdminEventForSession(
        global.io,
        'session:moderation-terminated',
        {
          sessionId,
          cause,
          crisisFlagged: flagged,
          timestamp: new Date(),
        },
        sessionId,
      );
    }
  }

  /**
   * A recovery session that does not speak (ai-therapist-293).
   *
   * GPT-Live never speaks unprompted, so a recovery session depends on its
   * speak-first instruction: placed in the session's startup input by the
   * route and sent again by the browser at `session.started`. The docs are
   * plain that such an instruction does "not guarantee that the model will
   * speak", and it does not always: on 2026-11-18, when it was delivered as a
   * single instructions append, 4 of 17 measured recovery starts stayed
   * silent for 11 s or more (one for the whole 90 s the harness waited).
   * Delivered the documented way it spoke within 1.6 s in 8 of 8, but 8 runs
   * do not make a guarantee. For a participant who has just disclosed
   * suicidal intent and been cut off, that silence is the harm the recovery
   * exists to prevent.
   *
   * So the server watches its own recovery sessions: if no assistant speech
   * has been transcribed RECOVERY_SPEAK_RETRY_MS after `session.started`, it
   * sends the speak-first instruction itself, and once more after that. It
   * does not depend on the browser, and it is harmless when the model has
   * already spoken (the timers do nothing).
   *
   * Recovery sessions only (client delegation): an ordinary session's opening
   * is the disclosure preamble, which is not this module's to resend. And only
   * on the opening attach: a reconnect or a post-deploy reattach joins a
   * conversation already under way.
   */
  private armRecoverySpeakWatchdog(sessionId: string): void {
    const state = this.sessions.get(sessionId);
    if (!state || !state.openingAttach || state.delegationMode !== 'client' || state.speakFirstTimers.length > 0) {
      return;
    }
    RECOVERY_SPEAK_RETRY_MS.forEach((delayMs, index) => {
      const timer = setTimeout(() => {
        void this.resendRecoverySpeakFirst(sessionId, index + 1, delayMs);
      }, delayMs);
      timer.unref?.();
      state.speakFirstTimers.push(timer);
    });
  }

  private async resendRecoverySpeakFirst(sessionId: string, attempt: number, afterMs: number): Promise<void> {
    const state = this.sessions.get(sessionId);
    if (!state || state.assistantSpoke || state.finalized || !this.isConnected(sessionId)) return;
    const short = sessionId.substring(0, 12);
    try {
      let contact: RecoveryCrisisContact | undefined;
      try {
        const { getSystemConfig } = await import('../utils/sessionHelpers.js');
        contact = (await getSystemConfig()).crisis_contact as RecoveryCrisisContact | undefined;
      } catch (err) {
        // The national defaults stand in: a missing config must not cost the re-nudge.
        console.error(`[Live] Could not read the crisis contact for ${short}...; using the defaults:`, err);
      }
      // Re-checked after the await: the model may have started in the meantime.
      if (state.assistantSpoke || state.finalized) return;
      console.warn(
        `[Live] RECOVERY SESSION SILENT for ${short}...: no assistant speech ${afterMs} ms after session.started; ` +
          `re-sending the speak-first instruction (attempt ${attempt}/${RECOVERY_SPEAK_RETRY_MS.length}).`,
      );
      // Commentary, as the browser's own speak-first is: the documented way to
      // have GPT-Live open a conversation, and in the measurements the one
      // that reliably made it speak (an instructions re-send did not: one
      // session stayed silent for 21 s through two of them).
      await this.appendCommentary(sessionId, buildRecoverySpeakFirstNudge(contact));
      if (global.io) {
        void broadcastAdminEventForSession(
          global.io,
          'live:recovery-silent',
          { sessionId, attempt, afterMs, timestamp: new Date() },
          sessionId,
        );
      }
    } catch (err) {
      console.error(`[Live] Could not re-send the speak-first instruction for ${short}...:`, err);
    }
  }

  /**
   * Record that the vendor's moderation stopped a generation, so how often a
   * reply is cut WITHOUT the session closing is a number rather than an
   * anecdote (a closed session is already recorded by
   * handleModerationTermination). Best-effort.
   */
  private async recordModerationStop(sessionId: string): Promise<void> {
    try {
      const { logInterventionAction } = await import('./crisisDetection.service.js');
      await logInterventionAction(sessionId, 'external_api_called', {
        event: 'moderation_stopped_generation',
        vendor: 'openai',
      });
    } catch (err) {
      console.error(`[Live] Failed to record a moderation stop for ${sessionId.substring(0, 12)}...:`, err);
    }
  }

  private async handleOpen(sessionId: string, liveSessionId: string): Promise<void> {
    // The opening attach succeeded: reconnect scheduling and fail-closed are
    // this session's own business again from here on.
    const opened = this.sessions.get(sessionId);
    if (opened) opened.initialAttach = false;
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
        void broadcastAdminEventForSession(
          global.io,
          'sideband:connected',
          {
            sessionId,
            callId: liveSessionId,
            channel: 'live',
            connectedAt: new Date(),
            delegationMode: opened?.delegationMode ?? 'responses',
          },
          sessionId,
        );
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
        try {
          s.ws.ping();
        } catch (err) {
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
        if (event.type === 'session.started') this.armRecoverySpeakWatchdog(sessionId);
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
        break;

      // --- Transcripts -----------------------------------------------------
      case 'session.input_transcript.delta': {
        const state = this.sessions.get(sessionId);
        if (!state) break;
        state.lastUserDeltaAt = Date.now();
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
        state.assistantSpoke = true;
        state.lastAssistantDeltaAt = Date.now();
        state.assistantTranscript.add({
          delta: String(event.delta ?? ''),
          start_ms: Number(event.start_ms ?? 0),
          end_ms: Number(event.end_ms ?? 0),
        });
        this.emitTranscript(sessionId, { role: 'assistant', delta: String(event.delta ?? ''), final: false });
        break;
      }

      // --- Delegation ------------------------------------------------------
      case 'session.delegation.created': {
        const created = event.delegation as { id?: string } | undefined;
        const timingState = this.sessions.get(sessionId);
        if (timingState && created?.id) {
          timingState.delegationTimings.set(created.id, { startedAt: Date.now(), firstTextAt: null });
        }
        if (global.io) {
          const delegation = event.delegation as { id?: string; target?: string } | undefined;
          void broadcastAdminEventForSession(
            global.io,
            'live:delegation',
            {
              sessionId,
              delegationId: delegation?.id ?? null,
              target: delegation?.target ?? null,
              offsetMs: event.offset_ms ?? null,
              timestamp: new Date(),
            },
            sessionId,
          );
        }
        break;
      }

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
          void broadcastAdminEventForSession(
            global.io,
            'live:closed',
            {
              sessionId,
              reason: event.reason ?? null,
              usage: event.usage ?? null,
              timestamp: new Date(),
            },
            sessionId,
          );
        }
        // reason 'content' means OPENAI'S OWN safety filter ended the session,
        // not the participant and not us. In a mental-health context that fires
        // at the worst possible moment — observed 2026-09-11, a participant said
        // "I wanna kill myself", the assistant began "Hey, I'm really glad you
        // told me", and the platform terminated the session mid-sentence. Our
        // crisis pipeline had already scored it 100/high and paged on-call
        // correctly; the harm was purely that the conversation vanished.
        //
        // We cannot disable OpenAI's filter, so this must be handled rather than
        // prevented. Treated as its own event class so the participant gets
        // crisis resources instead of a generic end screen (see the client), the
        // study team is told, and the frequency is measurable.
        if (event.reason === 'content') {
          await this.handleModerationTermination(sessionId, 'content_filter');
        } else if (event.reason === 'expired') {
          // The vendor's 60-minute ceiling (ai-therapist-281). For a session
          // in crisis that is the same harm as the filter — the conversation
          // vanishes — and gets the same recovery. Ordinary sessions end as
          // before.
          await this.handleModerationTermination(sessionId, 'expired');
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
        // OpenAI's moderation stopped the assistant mid-reply. The docs give
        // two outcomes ("Some moderation events end the session. Others cut
        // off assistant audio for the remainder of its current speech and emit
        // an `error` event without ending the session"), and in both the
        // participant has just heard a reply stop partway. In the measured
        // runs this error arrived 0.5 to 0.7 s BEFORE `session.closed`, so it
        // is the earliest moment the server can put crisis resources on their
        // screen, and it is done before anything that can stall.
        if (err?.code === 'content_filter') {
          emitCrisisResources(sessionId, { reason: 'vendor_moderation_stop' });
          void this.recordModerationStop(sessionId);
        }
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

    if (delegationId && inner.type === 'response.output_text.delta') {
      const timing = state.delegationTimings.get(delegationId);
      if (timing && timing.firstTextAt === null) timing.firstTextAt = Date.now();
    }

    switch (inner.type) {
      case 'response.output_item.done': {
        const item = inner.item as { type?: string; name?: string; call_id?: string; arguments?: string } | undefined;
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
        logDelegationTiming(sessionId, delegationId, state, response?.model ?? state.backendModel, response?.usage);
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
        const inserted = await insertMessagesBatch([
          {
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
          },
        ]);
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
        await insertMessagesBatch([
          {
            session_id: sessionId,
            role: 'assistant',
            // Matches the assistant-side voice convention in existing data.
            message_type: 'response',
            content: text,
            content_redacted: null,
            metadata: { channel: 'live', start_ms: startMs, end_ms: endMs },
          },
        ]);
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

    void broadcastAdminEventForSession(
      global.io,
      'sideband:transcript',
      {
        sessionId,
        itemId,
        ...payload,
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

    await insertMessagesBatch([
      {
        session_id: sessionId,
        role: 'system',
        message_type: 'tool_call',
        content: `Tool called: ${call.name}`,
        content_redacted: null,
        metadata: {
          tool_name: call.name,
          call_id: callId,
          arguments: args,
          delegation_id: call.delegationId,
          channel: 'live',
          status: 'executing',
        },
      },
    ]).catch((err) => console.error('[Live] Failed to log tool call:', err));

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
          channel: 'live',
          ...(failure ? { error: failure, status: 'failed' } : { response: result, status: 'completed' }),
        },
      },
    ]).catch((err) => console.error('[Live] Failed to log tool response:', err));

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
      .catch((err) => console.error('[Live] Failed to log tool invocation:', err));
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
   * Queue the participant's TYPED text for the delegated backend and continue
   * it (ai-therapist-214). The browser used to send this pair on its own data
   * channel; the channel is now locked to `session.close`, because
   * `response.item.create` from the browser also accepts developer-role
   * messages and tool outputs. Here the item is always a user-role message
   * built from plain text, so the participant keeps the participant's voice
   * and nothing more.
   *
   * Returns false when there is no sideband, and on a client-delegated
   * (recovery) session, which has no Responses backend to queue text for.
   */
  sendParticipantText(sessionId: string, text: string): boolean {
    const state = this.sessions.get(sessionId);
    if (!state || state.delegationMode === 'client' || state.ws.readyState !== WebSocket.OPEN) return false;
    const stamp = Date.now();
    this.sendEvent(sessionId, {
      type: 'response.item.create',
      event_id: `typed_${stamp}`,
      item: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] },
    });
    this.sendEvent(sessionId, { type: 'response.create', event_id: `typed_continue_${stamp}` });
    return true;
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
    const delegate = this.delegateFor(sessionId);
    if (delegate) return delegate.tryInject(sessionId, _role, text, _respond);
    if (!this.isConnected(sessionId)) return false;
    try {
      await this.appendInstructions(sessionId, withKeepSpeaking(text));
      this.armSteerResume(sessionId, text);
      return true;
    } catch (err) {
      console.error(`[Live] tryInject failed for ${sessionId.substring(0, 12)}...:`, err);
      return false;
    }
  }

  /**
   * After a clinical steer, make sure the assistant is not left silent
   * (ai-therapist-313; see LIVE_STEER_KEEP_SPEAKING). Armed only when a reply
   * was owed at the moment the steer landed: the assistant was speaking, or
   * the participant had just finished. A steer that arrives while the
   * assistant is quietly listening must not make it talk over the participant.
   */
  private armSteerResume(sessionId: string, text: string): void {
    const state = this.sessions.get(sessionId);
    if (!state || !text.startsWith(CLINICAL_STEER_MARKER)) return;
    const steeredAt = Date.now();
    const lastActivity = Math.max(state.lastAssistantDeltaAt, state.lastUserDeltaAt);
    if (lastActivity === 0 || steeredAt - lastActivity > STEER_REPLY_OWED_WINDOW_MS) return;
    // One watch per session at a time: a second steer restarts it.
    state.steerResumeTimers.forEach((t) => clearTimeout(t));
    state.steerResumeTimers = STEER_RESUME_CHECK_MS.map((delayMs, index) => {
      const timer = setTimeout(() => {
        void this.resumeAfterSteer(sessionId, steeredAt, index + 1, delayMs);
      }, delayMs);
      timer.unref?.();
      return timer;
    });
  }

  private async resumeAfterSteer(
    sessionId: string,
    steeredAt: number,
    attempt: number,
    afterMs: number,
  ): Promise<void> {
    const state = this.sessions.get(sessionId);
    if (!state || state.finalized || !this.isConnected(sessionId)) return;
    // The assistant has spoken since the steer: nothing to do, and no later
    // check either. "Since" starts after a short tail: the last fragments of
    // the interrupted sentence still arrive for a moment after the append,
    // and counting them as "carried on" is how a reply cut at "It sounds"
    // was left unprompted in the first measured run of this watch.
    if (state.lastAssistantDeltaAt > steeredAt + STEER_INTERRUPT_TAIL_MS) {
      state.steerResumeTimers.forEach((t) => clearTimeout(t));
      state.steerResumeTimers = [];
      return;
    }
    // The participant is talking: the assistant should be listening.
    if (Date.now() - state.lastUserDeltaAt < STEER_PARTICIPANT_TALKING_MS) return;
    const short = sessionId.substring(0, 12);
    try {
      console.warn(
        `[Live] SILENT AFTER STEER for ${short}...: no assistant speech ${afterMs} ms after a clinical steer; ` +
          `telling the model to speak (attempt ${attempt}/${STEER_RESUME_CHECK_MS.length}).`,
      );
      await this.appendCommentary(sessionId, LIVE_STEER_RESUME_COMMENTARY);
      if (global.io) {
        void broadcastAdminEventForSession(
          global.io,
          'live:steer-silent',
          { sessionId, attempt, afterMs, timestamp: new Date() },
          sessionId,
        );
      }
    } catch (err) {
      console.error(`[Live] Could not resume ${short}... after a steer:`, err);
    }
  }

  /**
   * Best-effort commentary append: something the model should say aloud now.
   * False means it could not be sent. GPT-Live only (the Grok proxy has no
   * commentary channel; it falls back to its own steer).
   */
  async tryCommentary(sessionId: string, text: string): Promise<boolean> {
    const delegate = this.delegateFor(sessionId);
    if (delegate) return delegate.tryInject(sessionId, 'system', text, true);
    if (!this.isConnected(sessionId)) return false;
    try {
      await this.appendCommentary(sessionId, text);
      return true;
    } catch (err) {
      console.error(`[Live] tryCommentary failed for ${sessionId.substring(0, 12)}...:`, err);
      return false;
    }
  }

  /**
   * Update the delegated backend mid-session (model, instructions, tools…).
   *
   * @throws LiveDelegationUnsupportedError on a client-delegated (recovery)
   *   session, which has no backend config to update.
   */
  async updateDelegation(
    sessionId: string,
    responses: Record<string, unknown>,
    operation = 'Updating the backend configuration',
  ): Promise<void> {
    if (this.sessions.get(sessionId)?.delegationMode === 'client') {
      throw new LiveDelegationUnsupportedError(sessionId, operation);
    }
    // `delegation.type` is required on an update as well as at creation: the
    // API reference's session.update example carries it ("The delegation
    // type must match the current session"), and without it the live API
    // answers "Missing required parameter: 'session.delegation.type'" and
    // applies nothing. Until 2026-11-18 it was omitted here, so every
    // server-side backend update (the admin trigger-tool pin and its 45 s
    // restore, the admin instructions update, switch_language) was rejected
    // (seen on stage, ai-therapist-282, and by the voice red-team probes).
    this.sendEvent(sessionId, {
      type: 'session.update',
      event_id: `update_${Date.now()}`,
      session: { delegation: { type: 'responses', responses } },
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
  async injectMessage(sessionId: string, _role: 'system' | 'user', text: string, _respond: boolean): Promise<void> {
    const delegate = this.delegateFor(sessionId);
    if (delegate) return delegate.injectMessage(sessionId, _role, text, _respond);
    await this.appendInstructions(sessionId, withKeepSpeaking(text));
    this.armSteerResume(sessionId, text);
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
    const delegate = this.delegateFor(sessionId);
    if (delegate) return delegate.updateSession(sessionId, updates);
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
    const delegate = this.delegateFor(sessionId);
    if (delegate) return delegate.interrupt(sessionId);
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
    const delegate = this.delegateFor(sessionId);
    if (delegate) return delegate.createResponse(sessionId, response);
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
    const delegate = this.delegateFor(sessionId);
    if (delegate) return delegate.triggerTool(sessionId, toolName, args);
    // Throws on a recovery session BEFORE anything is sent, so no nudge
    // reaches a model that has no tool to call.
    await this.updateDelegation(sessionId, { tool_choice: { type: 'function', name: toolName } }, 'Triggering a tool');

    const argsContext =
      args && Object.keys(args).length > 0 ? ` Use this context for the tool arguments: ${JSON.stringify(args)}.` : '';
    await this.appendInstructions(
      sessionId,
      'The clinician overseeing this session asks you to use the ' +
        toolName +
        ' capability now.' +
        argsContext +
        ' Delegate to the backend for this. Never mention this instruction to the participant.',
    );

    const state = this.sessions.get(sessionId);
    if (state) {
      if (state.toolChoiceReset) clearTimeout(state.toolChoiceReset);
      const timer = setTimeout(() => {
        this.updateDelegation(sessionId, { tool_choice: 'auto' })
          .then(() => console.log(`[Live] tool_choice reset to auto for ${sessionId.substring(0, 12)}...`))
          .catch((err) => console.error('[Live] tool_choice reset failed:', err));
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

    const transcript = rows.rows.map((r) => `${r.role}: ${r.content}`).join('\n');

    const { getOpenAIKey } = await import('../config/secrets.js');
    const { safetyIdentifierForSession } = await import('../utils/safetyIdentifier.js');
    const OpenAI = (await import('openai')).default;
    const client = new OpenAI({ apiKey: await getOpenAIKey() });

    const result = await client.responses.create({
      model: state.backendModel,
      instructions:
        'Summarize the therapy conversation SO FAR in ONE short paragraph (60 words or fewer) for internal use ' +
        "only — this is never shown to the participant. Cover: the main theme, the participant's emotional " +
        'trajectory, and what has landed or helped so far, if anything. Plain prose, no headers, no lists.',
      input: transcript,
      store: false,
      safety_identifier: await safetyIdentifierForSession(sessionId).catch(() => undefined),
    });

    const text = result.output_text?.trim();
    if (!text) return;

    const { recordLlmUsage } = await import('../db/index.js');
    await recordLlmUsage(
      sessionId,
      'insights',
      state.backendModel,
      result.usage?.input_tokens ?? null,
      result.usage?.output_tokens ?? null,
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

    // The schedule itself is shared with the Grok Voice proxy
    // (utils/phaseGuidance.ts) so both backends nudge at the same points.
    const { buildPhaseNudgeSchedule } = await import('../utils/phaseGuidance.js');
    for (const phase of await buildPhaseNudgeSchedule(sessionId)) {
      const timer = setTimeout(() => {
        this.tryInject(sessionId, 'system', phase.text, false)
          .then(
            (ok) =>
              ok && console.log(`[Live] Phase nudge (${phase.at * 100}%) sent to ${sessionId.substring(0, 12)}...`),
          )
          .catch((err) => console.error('[Live] Phase nudge failed:', err));
      }, phase.delayMs);
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

    const minutes =
      typeof features.regrounding_interval_minutes === 'number' && features.regrounding_interval_minutes > 0
        ? features.regrounding_interval_minutes
        : 5;

    const timer = setInterval(
      () => {
        this.runRegroundingSummary(sessionId).catch((err) =>
          console.error(`[Live] Re-grounding summary failed for ${sessionId.substring(0, 12)}...:`, err),
        );
      },
      minutes * 60 * 1000,
    );
    timer.unref?.();
    state.regrounding = timer;
    console.log(`[Live] Scheduled re-grounding every ${minutes}min for ${sessionId.substring(0, 12)}...`);
  }

  /** Clear every per-session timer. Shared by close and disconnect. */
  private clearTimers(state: LiveSessionState): void {
    if (state.keepalive) clearInterval(state.keepalive);
    if (state.regrounding) clearInterval(state.regrounding);
    if (state.toolChoiceReset) clearTimeout(state.toolChoiceReset);
    state.phaseTimers.forEach((t) => clearTimeout(t));
    state.speakFirstTimers.forEach((t) => clearTimeout(t));
    state.speakFirstTimers = [];
    state.steerResumeTimers.forEach((t) => clearTimeout(t));
    state.steerResumeTimers = [];
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

  private async handleClose(sessionId: string, code: number, reason: Buffer): Promise<void> {
    console.log(`[Live] Sideband closed for ${sessionId.substring(0, 12)}...: ${code} - ${reason || 'no reason'}`);
    const state = this.sessions.get(sessionId);

    // The OPENING attach never completed. connectAndWait owns that outcome: it
    // is mid-retry, and the route ends the session and tells the participant if
    // the retries run out. Scheduling a reconnect here would race a second
    // socket against the retry loop, and there is no transcript, no usage and
    // no participant to fail closed on yet.
    if (state?.initialAttach) {
      this.clearTimers(state);
      state.userTranscript.dispose();
      state.assistantTranscript.dispose();
      this.sessions.delete(sessionId);
      return;
    }

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
          code,
          reason: reason?.toString(),
          disconnectedAt: new Date(),
        },
        sessionId,
      );
    }

    // state.finalized means session.closed already arrived: the OpenAI-side live
    // session is definitively over and its id will 404 on re-attach. Without
    // this check, any non-1000 socket close after session.closed (1006 on a
    // dropped TCP connection, 1001 going-away, and notably the content-filter
    // termination path) scheduled a re-attach that was rejected, ran the
    // unexpected-response handler, and called failClosedUnmonitored — which
    // pages the on-call and ends the session. On a NORMAL end that is a false
    // crisis page; after a content-filter termination it actively races the
    // crisis recovery the client is trying to start.
    if (this.endedSessions.has(sessionId) || code === 1000 || !state || state.finalized) return;

    const status = await pool
      .query<{ status: string }>('SELECT status FROM therapy_sessions WHERE session_id = $1', [sessionId])
      .catch(() => null);
    if (status?.rows[0]?.status !== 'active') return;

    const attempts = state.reconnectAttempts;
    if (attempts >= this.maxReconnectAttempts) {
      console.error(`[Live] Max reconnection attempts reached for ${sessionId.substring(0, 12)}...`);
      await this.failClosedUnmonitored(
        sessionId,
        `sideband reconnect exhausted after ${this.maxReconnectAttempts} attempts`,
      );
      return;
    }
    const timer = setTimeout(
      () => {
        this.connect(sessionId, state.liveSessionId, state.apiKey, {
          model: state.model,
          backendModel: state.backendModel,
          delegationMode: state.delegationMode,
        })
          .then(() => {
            const next = this.sessions.get(sessionId);
            if (next) next.reconnectAttempts = attempts + 1;
          })
          .catch((err) => console.error('[Live] Reconnection failed:', err));
      },
      this.reconnectDelayMs * (attempts + 1),
    );
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
    const delegate = this.delegateFor(sessionId);
    if (delegate) return delegate.disconnect(sessionId, opts);
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
        await new Promise<void>((resolve) => {
          const timer = setTimeout(() => {
            console.warn(
              `[Live] No session.closed within ${graceMs}ms for ${sessionId.substring(0, 12)}...; final usage unconfirmed.`,
            );
            resolve();
          }, graceMs);
          timer.unref?.();
          const check = setInterval(() => {
            if (this.sessions.get(sessionId)?.finalized) {
              clearTimeout(timer);
              clearInterval(check);
              resolve();
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
      recovery?: boolean | null;
    }>(
      // A recovery session's only durable marker is the crisis_events row
      // markSessionCrisisContinuation writes (risk factor recovery_continuation).
      // Without it a re-attached recovery session would be treated as
      // responses-delegated and send updates the Live API rejects.
      `SELECT ts.session_id, ts.openai_live_session_id, sc.ai_model, sc.live_backend_model,
              EXISTS (
                SELECT 1 FROM crisis_events ce
                 WHERE ce.session_id = ts.session_id
                   AND ce.risk_factors @> '["recovery_continuation"]'::jsonb
              ) AS recovery
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
          delegationMode: row.recovery === true ? 'client' : 'responses',
        });
      } catch (err) {
        console.error(
          `[Live] Re-attach failed for ${row.session_id.substring(0, 12)}...:`,
          err instanceof Error ? err.message : err,
        );
      }
    }
    return { attempted: result.rows.length };
  }

  private async logConnectionError(sessionId: string, error: unknown): Promise<void> {
    const message = error instanceof Error ? error.message : String(error);
    await pool
      .query('UPDATE therapy_sessions SET sideband_error = $1, sideband_connected = FALSE WHERE session_id = $2', [
        message,
        sessionId,
      ])
      .catch((err) => console.error('[Live] Failed to log connection error:', err));
  }

  private async logError(sessionId: string, error: unknown): Promise<void> {
    const message = typeof error === 'string' ? error : error instanceof Error ? error.message : JSON.stringify(error);
    await pool
      .query('UPDATE therapy_sessions SET sideband_error = $1 WHERE session_id = $2', [message, sessionId])
      .catch((err) => console.error('[Live] Failed to log error:', err));
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
    const own = Array.from(this.sessions.entries())
      .filter(([, state]) => state.ws.readyState === WebSocket.OPEN)
      .map(([sessionId]) => sessionId);
    return own.concat(...this.delegates.map((d) => d.getActiveConnections()));
  }

  /**
   * The delegation mode of a GPT-Live session this manager owns, or null when
   * it is not attached here (including sessions owned by another backend).
   */
  getDelegationMode(sessionId: string): LiveDelegationMode | null {
    if (this.delegateFor(sessionId)) return null;
    return this.sessions.get(sessionId)?.delegationMode ?? null;
  }

  isConnected(sessionId: string): boolean {
    const delegate = this.delegateFor(sessionId);
    if (delegate) return delegate.isConnected(sessionId);
    const state = this.sessions.get(sessionId);
    return !!state && state.ws.readyState === WebSocket.OPEN;
  }

  /** Latest known cumulative voice seconds, or null when not tracked. */
  getUsageSeconds(sessionId: string): number | null {
    return this.sessions.get(sessionId)?.lastUsageSeconds ?? null;
  }

  async shutdown(): Promise<void> {
    for (const d of this.delegates) {
      await d.shutdown().catch((err) => console.error('[Live] delegate shutdown failed:', err));
    }
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
