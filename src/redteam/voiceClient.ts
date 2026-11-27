// Voice pipeline (ai-therapist-124 phase 2; re-ported to the production voice
// backends in ai-therapist-213/245): a Node-side stand-in for the participant
// browser that drives a REAL voice session through the same server path the
// app uses, speaks persona turns as TTS audio, and hands the assistant's
// transcript to the shared assertion/judge code untouched.
//
// Which backend runs is decided exactly as in production, by
// system_config.ai_model (detectVoiceBackend):
//
//   grok-voice-*  xAI Grok Voice through OUR proxy. POST /api/grok/session
//                 creates the session, then one WebSocket to
//                 /api/grok/voice/<id> carries PCM16 up and PCM16 + JSON
//                 control down — the browser-side frame protocol in
//                 shared/grokVoiceProtocol.ts, so every participant utterance
//                 crosses the server's crisis join point (GrokVoiceManager.
//                 onUserTurn → runCrisisPipeline), transcripts are persisted
//                 by the proxy, tools execute server-side, and usage is
//                 metered into live_usage. Nothing is posted to /logs/batch:
//                 the proxy is the writer, as it is for a real browser.
//
//   gpt-live-*    OpenAI GPT-Live. The browser owns a WebRTC session that the
//                 server mints (POST /api/live/session) and observes through a
//                 sideband attach. liveVoiceClient.ts drives it headlessly
//                 (werift WebRTC + WASM Opus, TTS audio in); on this backend
//                 the runner also records which layer answered each turn and
//                 adds the GPT-Live checks in liveVoiceChecks.ts.
//
// Turn-taking on Grok is the proxy's server VAD, so the harness behaves like
// a microphone: TTS PCM16 at 24 kHz streamed as ~100 ms frames at real-time
// pace, followed by enough silence for the VAD to close the turn. The end of
// the assistant's turn is read from the proxy's own events (final assistant
// `transcript`, then `response_done`); a tool-only response is followed by
// the model's spoken continuation, so the beat waits for the first response
// that actually said something. `--voice-text-turns` swaps the audio for the
// typed-text path (POST /api/grok/session/:id/text + /logs/batch, exactly what
// the browser does for typed input) — a cheaper fallback, never the default.
//
// Audio in both directions is teed into the ordinary session recording route
// (POST /api/sessions/:id/audio) so eval recordings stay playable in admin
// SessionDetail like any other session's.
import type OpenAI from 'openai';
import WebSocket from 'ws';
import type { CostTracker, RedteamConfig } from './config.js';
import type { Agent, HarnessClient } from './harnessClient.js';
import { generatePersonaTurn } from './personaDriver.js';
import { runJudge } from './judge.js';
import { Timeline } from './voice/timeline.js';
import { expectedOpening, openingDisclosureAssertion, openingSpokenAssertion } from './voice/openingSpoken.js';
import type { RunMetrics, TurnFacts } from './voice/metrics.js';
import { applyCondition } from './voice/acoustics.js';
import { voiceExpectation } from './voice/scenarios.js';
import type { HistoryTurn } from './voice/sessionInput.js';
import {
  cutAssertions,
  liveScenarioAssertions,
  probeAssertions,
  resourceCardShownIn,
  withLayer,
  type LiveBeatRecord,
  type ProbeResult,
  type TurnLayerInfo,
} from './liveVoiceChecks.js';
import type { LiveSessionTiming } from './liveVoiceClient.js';
import { beginTextHandoff, finishTextHandoff, type HandoffRecord, type PendingHandoff } from './textHandoffChecks.js';
import { runAssertionRecordingJudge } from './yesNoJudge.js';
import {
  type AssertionContext,
  type AssertionResult,
  type Beat,
  type CapturedEmission,
  type Scenario,
  type ScenarioResult,
  type Turn,
  scoreToBand,
  SEVERITY_RANK,
} from './types.js';

export const VOICE_SAMPLE_RATE = 24_000; // OpenAI TTS pcm + Grok proxy wire rate (GROK_SAMPLE_RATE)
const TTS_MODEL = 'gpt-4o-mini-tts';
const TTS_VOICE = 'alloy';
const BEAT_TIMEOUT_MS = 90_000;
const READY_TIMEOUT_MS = 25_000;
/** ~100 ms of PCM16 at the wire rate — the browser worklet's frame size. */
export const FRAME_BYTES = (VOICE_SAMPLE_RATE / 10) * 2;
/** Trailing silence after each utterance: comfortably past the proxy's default
 *  500 ms `silence_duration_ms` plus the model's own end-of-speech latency. */
const TRAILING_SILENCE_MS = 1_500;
/** Recording upload chunking (the audio route's JSON limit is 8 MB). */
const UPLOAD_CHUNK_BYTES = 48_000;

export type VoiceBackend = 'grok' | 'live';

// ---------------------------------------------------------------------------
// Pure helpers (unit-tested offline in voiceClient.test.ts)
// ---------------------------------------------------------------------------

/** Which voice backend a configured ai_model selects, or null when the value
 *  names neither (then no voice session can start and the runner says so). */
export function detectVoiceBackend(aiModel: string | null | undefined): VoiceBackend | null {
  if (!aiModel) return null;
  if (aiModel.startsWith('grok-voice') && !aiModel.startsWith('grok-voice-transcribe')) return 'grok';
  if (aiModel.startsWith('gpt-live')) return 'live';
  return null;
}

/** Split a PCM16 buffer into fixed-size binary frames (16-bit aligned; the
 *  last frame may be short). This is what goes down the proxy socket. */
export function framePcm(pcm: Buffer, frameBytes = FRAME_BYTES): Buffer[] {
  const even = frameBytes - (frameBytes % 2);
  const out: Buffer[] = [];
  for (let off = 0; off < pcm.length; off += even) {
    out.push(pcm.subarray(off, Math.min(off + even, pcm.length)));
  }
  return out;
}

/** Split a PCM buffer into base64 chunks of at most chunkBytes (16-bit
 *  aligned) for the recording upload route. */
export function chunkBase64Pcm(pcm: Buffer, chunkBytes = UPLOAD_CHUNK_BYTES): string[] {
  return framePcm(pcm, chunkBytes).map((f) => f.toString('base64'));
}

/** ms of PCM16 silence at the voice sample rate (lets server VAD close the turn). */
export function silencePcm(ms: number, sampleRate = VOICE_SAMPLE_RATE): Buffer {
  return Buffer.alloc(Math.floor((sampleRate * ms) / 1000) * 2);
}

/** Wall-clock duration of a PCM16 mono buffer, in ms. */
export function pcmDurationMs(pcm: Buffer, sampleRate = VOICE_SAMPLE_RATE): number {
  return (pcm.length / 2 / sampleRate) * 1000;
}

/** What the voice runner consumes, mapped from the proxy's server→browser
 *  messages (shared/grokVoiceProtocol.ts). Non-final transcript fragments are
 *  captions only and are dropped here, like the browser drops them from the
 *  record. */
export type VoiceSignal =
  | { kind: 'ready'; model: string; resumed: boolean }
  /** The proxy's own link to xAI dropped / came back (docs/grok-voice.md section 3). */
  | { kind: 'link'; state: 'reconnecting' | 'restored' }
  | { kind: 'assistant-audio'; pcm: Buffer }
  | { kind: 'assistant-text'; text: string; itemId: string }
  | { kind: 'user-transcript'; text: string; itemId: string }
  | { kind: 'speech-started' }
  | { kind: 'response-done' }
  | { kind: 'tool-call'; name: string }
  | { kind: 'closed'; reason: string }
  | { kind: 'error'; message: string }
  | { kind: 'other' };

/** Map one JSON control frame from the Grok proxy to a VoiceSignal. Binary
 *  frames (assistant PCM) never reach this function. */
export function parseGrokServerMessage(msg: Record<string, unknown>): VoiceSignal {
  const type = typeof msg.type === 'string' ? msg.type : '';
  switch (type) {
    case 'ready':
      return { kind: 'ready', model: typeof msg.model === 'string' ? msg.model : '', resumed: msg.resumed === true };
    case 'link':
      return { kind: 'link', state: msg.state === 'reconnecting' ? 'reconnecting' : 'restored' };
    case 'transcript': {
      if (msg.final !== true || typeof msg.text !== 'string') return { kind: 'other' };
      const itemId = typeof msg.itemId === 'string' ? msg.itemId : '';
      if (msg.role === 'user') return { kind: 'user-transcript', text: msg.text, itemId };
      if (msg.role === 'assistant') return { kind: 'assistant-text', text: msg.text, itemId };
      return { kind: 'other' };
    }
    case 'speech_started':
      return { kind: 'speech-started' };
    case 'response_done':
      return { kind: 'response-done' };
    case 'tool_call':
      return { kind: 'tool-call', name: typeof msg.name === 'string' ? msg.name : '' };
    case 'closed':
      return { kind: 'closed', reason: typeof msg.reason === 'string' ? msg.reason : '' };
    case 'error':
      return { kind: 'error', message: typeof msg.message === 'string' ? msg.message : 'voice proxy error' };
    default:
      return { kind: 'other' };
  }
}

/** Sleep until `at` (epoch ms) — drift-free pacing for the frame stream. */
function sleepUntil(at: number): Promise<void> {
  const ms = at - Date.now();
  return ms <= 0 ? Promise.resolve() : new Promise((r) => setTimeout(r, ms));
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ---------------------------------------------------------------------------
// Grok proxy session
// ---------------------------------------------------------------------------

export interface BeatTurn {
  /** What the persona actually said per the proxy's transcription (the
   *  prod-fidelity text the crisis pipeline scored); falls back to the TTS
   *  input when the transcript never arrived. */
  userText: string;
  assistantText: string;
  /** Tool calls the model made during this beat (names, in order). */
  toolCalls: string[];
  /** Assistant turns that completed BEFORE the persona spoke this beat —
   *  server steers, tool continuations, refusal-loop recoveries. The
   *  participant heard them, so they belong in the transcript, attributed to
   *  the previous beat. */
  unsolicited: string[];
  /** Set when the backend ended the session during this beat (GPT-Live
   *  `session.closed reason=content`: OpenAI's content filter, the incident
   *  class the browser answers with the text hand-off). The beat's assertions
   *  still run on what was said and scored; later beats cannot. */
  terminated?: string;
  /** GPT-Live: which layer answered this beat (voice model or delegated
   *  backend), read from the data channel. */
  layer?: TurnLayerInfo;
  /** GPT-Live: layer of the `unsolicited` turns (late backend work). */
  unsolicitedLayer?: TurnLayerInfo;
  /** GPT-Live: an `error` with code content_filter arrived during this beat
   *  (OpenAI's moderation stopped a generation, possibly mid-sentence). */
  moderationStopped?: boolean;
}

/** How long the assistant must have been silent (no audio, no transcript
 *  delta) before the persona starts a turn, like a participant waiting for
 *  the assistant to finish. Bounded so a chatty steer loop cannot stall. */
const QUIET_BEFORE_SPEAKING_MS = 1_200;
const QUIET_WAIT_CAP_MS = 20_000;

export interface VoiceSessionOptions {
  /** Drive turns through the typed-text path instead of audio. */
  textTurns: boolean;
  /** GPT-Live only: start as a crisis RECOVERY voice session (`recovery:
   *  true`): narrow crisis prompt, no history, speak-first nudge instead of
   *  the opening preamble. Since ai-therapist-356 the browser starts one only
   *  when the deployment has typed chat disabled, so the scenario runners no
   *  longer do; voice/delegationProbe.ts still does, deliberately. */
  recovery?: boolean;
  /** GPT-Live evaluation (src/redteam/voice): the run's shared timeline. */
  timeline?: Timeline;
  /** GPT-Live CRAWL/WALK: prior turns seeded as text in session.input; the
   *  opening line is skipped (the conversation is already under way). */
  history?: HistoryTurn[];
  /** GPT-Live WALK: transform applied to each synthesized utterance. */
  audioTransform?: (pcm: Buffer) => Buffer;
  /** GPT-Live RUN: every decoded assistant frame, for the simulated caller. */
  onAssistantPcm?: (pcm: Buffer) => void;
  /** GPT-Live RUN: pulled every 20 ms when no utterance is queued; a 20 ms
   *  PCM frame of simulated-caller audio, or undefined for silence. */
  micSource?: () => Buffer | undefined;
}

/** What the live API answered to a server-side backend update. Pure. */
export function classifyDelegationUpdateOutcome(
  emissions: CapturedEmission[],
  sessionId: string,
): { outcome: 'accepted' | 'rejected' | 'pending'; detail: string } {
  for (const e of emissions) {
    const payload = (e.payload ?? {}) as {
      sessionId?: string;
      eventType?: string;
      error?: { code?: string; message?: string; client_event_id?: string };
    };
    if (payload.sessionId !== sessionId) continue;
    if (e.event === 'sideband:error') {
      const err = payload.error ?? {};
      return {
        outcome: 'rejected',
        detail: `the live API rejected the server's session.update: ${err.code ?? 'error'}: ${String(err.message ?? '').slice(0, 200)}`,
      };
    }
    if (e.event === 'session:openai-update' && payload.eventType === 'session.updated') {
      return { outcome: 'accepted', detail: 'the live API answered session.updated to the server-side backend update' };
    }
  }
  return { outcome: 'pending', detail: 'no session.updated and no error yet' };
}

/**
 * Does the live API accept the server's own backend updates?
 *
 * The admin trigger-tool pin (and its restore), the admin instructions update
 * and switch_language all go through sidebandManager.updateDelegation. Until
 * 2026-11-18 that event omitted `session.delegation.type`, and the API
 * answered "Missing required parameter: 'session.delegation.type'" to every
 * one of them. A unit test holds the event shape; this holds the thing the
 * unit test cannot, which is that the real API takes it. It re-sends the
 * session's existing `tool_choice: 'auto'`, so it changes nothing.
 */
export async function serverDelegationUpdateAssertion(
  emissions: CapturedEmission[],
  sessionId: string,
  waitMs = 8_000,
): Promise<AssertionResult> {
  const id = 'live-server-delegation-update-accepted';
  const since = emissions.length;
  try {
    const { sidebandManager } = await import('../server/services/sidebandManager.service.js');
    await sidebandManager.updateDelegation(sessionId, { tool_choice: 'auto' }, 'Red-team backend update check');
  } catch (err) {
    return {
      id,
      passed: true,
      gating: false,
      detail: `skipped: the sideband could not send a backend update (${(err as Error).message})`,
    };
  }
  const until = Date.now() + waitMs;
  for (;;) {
    const r = classifyDelegationUpdateOutcome(emissions.slice(since), sessionId);
    if (r.outcome !== 'pending') return { id, passed: r.outcome === 'accepted', gating: true, detail: r.detail };
    if (Date.now() > until) {
      // No answer either way is not the bug this holds (a rejected update
      // answers at once with an error): reported, not gating.
      return { id, passed: false, gating: false, detail: `no session.updated and no error within ${waitMs} ms` };
    }
    await sleep(100);
  }
}

/** What the harness does when a voice backend ends the session mid-beat.
 *  Mirrors the browser (App.tsx handleModerationTermination, ai-therapist-356):
 *  a GPT-Live content-filter cut, or the vendor's session ceiling on a session
 *  flagged high, goes straight to the text hand-off (POST /api/chat/start with
 *  `continued_from`); no recovery voice session is started. Anything else is
 *  an ordinary end. The voice conversation is over either way: the spoken
 *  beats that remain cannot be spoken. Pure, unit-tested. */
export function planAfterTermination(
  backend: 'grok' | 'live',
  reason: string,
  /** The session was flagged high: an `expired` close is handed off only then
   *  (App.tsx crisisActiveRef); a content cut is handed off regardless. */
  crisisHigh = false,
): 'handoff' | 'stop' {
  if (backend !== 'live') return 'stop';
  if (reason === 'content') return 'handoff';
  if (reason === 'expired' && crisisHigh) return 'handoff';
  return 'stop';
}

/** What the scenario runner needs from a voice backend; the Grok proxy
 *  session below and the GPT-Live session (liveVoiceClient.ts) both provide it. */
export interface VoiceTransport {
  readonly sessionId: string;
  /** Resolved model id the session runs on. */
  readonly model: string;
  /** Lower bound on participant turns the server has scored so far. */
  readonly userTurns: number;
  speakBeat(text: string, beatId?: string): Promise<BeatTurn>;
  end(): Promise<void>;
  /** Sever the browser-side socket and reconnect it (Grok only). */
  dropClientAndReconnect?(gapMs: number): Promise<void>;
  /** Sever the server's xAI socket and wait for the proxy to resume it (Grok only). */
  dropUpstreamAndAwaitResume?(): Promise<void>;
  /** GPT-Live: which layer spoke the opening line. */
  readonly openingLayer?: TurnLayerInfo | null;
  /** GPT-Live: function calls that arrived with no delegation id. */
  readonly undelegatedToolCalls?: string[];
  /** GPT-Live: send the client events a participant's browser must not use. */
  runClientProbes?(): Promise<ProbeResult[]>;
  /** GPT-Live: collect speech that lands after the last beat's reply. */
  drainTrailing?(maxMs?: number): Promise<{ text: string; layer?: TurnLayerInfo }>;
  /** GPT-Live: wall-clock marks (the cut, a recovery start's opening). */
  readonly timing?: LiveSessionTiming;
}

/** How long the harness gives the proxy to resume its xAI link. */
const RESUME_TIMEOUT_MS = 40_000;

export class GrokVoiceSession implements VoiceTransport {
  private ws!: WebSocket;
  private signals: VoiceSignal[] = [];
  /** Read position into `signals` — persists ACROSS beats so a beat never
   *  re-consumes the previous beat's buffered events. */
  private cursor = 0;
  private waiters: Array<() => void> = [];
  private closed = false;
  private closeReason: string | null = null;
  /** Resolved model id as reported by the proxy's `ready`. */
  model = '';
  /** Participant turns the proxy has transcribed (audio mode): the crisis
   *  pipeline runs once per turn, so this is the expected risk_score_history
   *  row count for the session. */
  userTurns = 0;
  /** Mixed conversation audio pending upload (persona TTS + assistant PCM, in
   *  wall-clock arrival order — turns don't overlap in a VAD conversation). */
  private pendingPcm: Buffer[] = [];
  private assistantAudio: Buffer[] = [];
  /** Last time the assistant produced audio or a transcript delta. */
  private lastAssistantActivityAt = 0;
  /** Kept so a dropped socket can be re-opened with the same session cookie. */
  private wsUrl = '';
  private cookieHeader = '';

  private constructor(
    readonly sessionId: string,
    private readonly agent: Agent,
    private readonly openai: OpenAI,
    private readonly cost: CostTracker,
    private readonly opts: VoiceSessionOptions,
  ) {}

  /** Create the session through the real route (all gates, prompt assembly,
   *  DB rows), open the proxy WebSocket with the agent's session cookie, and
   *  wait for `ready` plus the server-authored opening line. */
  static async start(
    client: HarnessClient,
    agent: Agent,
    openai: OpenAI,
    cost: CostTracker,
    opts: VoiceSessionOptions,
  ): Promise<{ session: GrokVoiceSession; opening: string }> {
    if (!client.baseUrl)
      throw new Error('voice pipeline needs a listening server (HarnessClient.listen) for the WebSocket upgrade');

    const res = await agent.post('/api/grok/session').send({ language: 'en' });
    if (res.status !== 201 || typeof res.body?.session_id !== 'string' || typeof res.body?.ws_path !== 'string') {
      throw new Error(`POST /api/grok/session failed: ${res.status} ${JSON.stringify(res.body).slice(0, 300)}`);
    }
    const sessionId = res.body.session_id as string;
    const wsUrl = client.baseUrl.replace(/^http/, 'ws') + (res.body.ws_path as string);

    const vs = new GrokVoiceSession(sessionId, agent, openai, cost, opts);
    vs.wsUrl = wsUrl;
    vs.cookieHeader = client.cookieHeader(agent);
    vs.openSocket();

    // `ready` means the upstream xAI session is configured; the proxy then
    // injects the opening line and the model speaks first, exactly as for a
    // browser. Nothing may be sent before that reply completes or it would be
    // a barge-in.
    try {
      await vs.awaitReady();
      const opening = await vs.awaitAssistantTurn(Date.now() + BEAT_TIMEOUT_MS, false);
      return { session: vs, opening: opening.assistantText };
    } catch (err) {
      // The session row exists: end it, or the participant's one-active-
      // session gate blocks every later start.
      await vs.end().catch(() => {});
      throw err;
    }
  }

  /** Open (or re-open) the proxy socket with the session cookie, exactly as
   *  the browser does; the signal handlers are the same for every socket. */
  private openSocket(): void {
    const ws = new WebSocket(this.wsUrl, { headers: { Cookie: this.cookieHeader } });
    this.ws = ws;
    this.closed = false;
    this.closeReason = null;
    ws.on('message', (data, isBinary) => {
      if (this.ws !== ws) return; // a superseded socket's late frames
      if (isBinary) {
        const buf = Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer);
        this.lastAssistantActivityAt = Date.now();
        this.push({ kind: 'assistant-audio', pcm: Buffer.from(buf) });
        return;
      }
      try {
        const msg = JSON.parse(data.toString()) as Record<string, unknown>;
        // REDTEAM_VOICE_DEBUG=1 → log control frames to diagnose protocol drift.
        if (process.env.REDTEAM_VOICE_DEBUG) console.log(`[voice:proxy] ${JSON.stringify(msg).slice(0, 200)}`);
        if (msg.type === 'transcript' && msg.role === 'assistant') this.lastAssistantActivityAt = Date.now();
        this.push(parseGrokServerMessage(msg));
      } catch {
        /* non-JSON text frame */
      }
    });
    ws.on('close', (code, reason) => {
      if (this.ws !== ws) return;
      this.closed = true;
      this.closeReason = this.closeReason ?? `${code} ${reason.toString()}`;
      this.wake();
    });
    ws.on('error', (err) => {
      if (this.ws === ws) this.push({ kind: 'error', message: err.message });
    });
    ws.on('unexpected-response', (_req, resp) => {
      this.push({ kind: 'error', message: `proxy upgrade rejected: HTTP ${resp.statusCode}` });
      try {
        ws.terminate();
      } catch {
        /* already gone */
      }
    });
  }

  /** Consume signals up to the proxy's `ready`; returns whether it was a re-attach. */
  private async awaitReady(): Promise<boolean> {
    const readyAt = Date.now() + READY_TIMEOUT_MS;
    for (;;) {
      const i = await this.nextSignalIndex(this.cursor, readyAt, 'waiting for proxy ready');
      if (i === -1) continue;
      const s = this.signals[i];
      this.cursor = i + 1;
      if (s.kind === 'ready') {
        this.model = s.model;
        return s.resumed;
      }
      if (s.kind === 'error') throw new Error(`voice proxy error before ready: ${s.message}`);
      if (s.kind === 'closed') throw new Error(`voice proxy closed before ready: ${s.reason}`);
    }
  }

  /**
   * `--voice-drop-client-midway`: kill the socket the way a network fault
   * would (no close frame), wait `gapMs`, re-open it with the same cookie and
   * expect the proxy to re-attach it to the live xAI session (`ready` with
   * `resumed: true`). Everything the assistant said in the gap is lost to
   * this client, as it would be to a browser; the proxy still persisted it.
   */
  async dropClientAndReconnect(gapMs: number): Promise<void> {
    const old = this.ws;
    console.log(`[redteam:voice] severing the client socket for ${this.sessionId} (gap ${gapMs} ms)`);
    old.terminate();
    const closedBy = Date.now() + 5_000;
    while (!this.closed && Date.now() < closedBy) await sleep(20);
    await sleep(gapMs);
    this.openSocket();
    const resumed = await this.awaitReady();
    if (!resumed) throw new Error('proxy answered the reconnect with a fresh ready, not a re-attach');
    console.log(`[redteam:voice] client socket re-attached to ${this.sessionId}`);
  }

  /**
   * `--voice-drop-upstream-midway`: sever the proxy's xAI socket through the
   * manager's test hook (the harness runs in-process) and wait for the link
   * to be reported reconnecting then restored.
   */
  async dropUpstreamAndAwaitResume(): Promise<void> {
    const { grokVoiceManager } = await import('../server/services/grokVoiceManager.service.js');
    const before = grokVoiceManager.getLinkStats(this.sessionId);
    console.log(
      `[redteam:voice] severing the xAI socket for ${this.sessionId} (conversation ${before?.conversationId ?? 'none'})`,
    );
    if (!grokVoiceManager._dropUpstreamForTests(this.sessionId)) throw new Error('no upstream socket to drop');
    const deadline = Date.now() + RESUME_TIMEOUT_MS;
    let sawReconnecting = false;
    for (;;) {
      const i = await this.nextSignalIndex(this.cursor, deadline, 'waiting for the proxy to resume its xAI link');
      if (i === -1) continue;
      const s = this.signals[i];
      this.cursor = i + 1;
      if (s.kind === 'link') {
        if (s.state === 'reconnecting') {
          sawReconnecting = true;
          continue;
        }
        if (!sawReconnecting) throw new Error('link restored before any reconnecting notice');
        break;
      }
      if (s.kind === 'closed') throw new Error(`voice session closed by server during resume: ${s.reason}`);
      // Whatever else arrives in the gap (a late audio tail, an error relay)
      // is kept for the recording and otherwise skipped: the assistant was
      // quiet when the link was cut, so nothing here is a reply to a beat.
      if (s.kind === 'assistant-audio') this.assistantAudio.push(s.pcm);
      if (s.kind === 'assistant-text')
        console.log(`[redteam:voice] assistant spoke during the resume gap: "${s.text.slice(0, 80)}"`);
    }
    const after = grokVoiceManager.getLinkStats(this.sessionId);
    console.log(
      `[redteam:voice] xAI link restored for ${this.sessionId}: conversation ${after?.conversationId ?? 'none'}` +
        ` (${after?.conversationId === before?.conversationId ? 'same id, resumed' : 'NEW id, not resumed'}),` +
        ` ${after?.replayedItems ?? 0} replayed items, resume #${after?.upstreamResumes ?? 0}`,
    );
  }

  /** Wait until the assistant has been quiet for QUIET_BEFORE_SPEAKING_MS
   *  (bounded) so the persona does not barge in on a steer or continuation. */
  private async waitForQuiet(): Promise<void> {
    const cap = Date.now() + QUIET_WAIT_CAP_MS;
    while (Date.now() - this.lastAssistantActivityAt < QUIET_BEFORE_SPEAKING_MS && Date.now() < cap) {
      await sleep(100);
    }
  }

  /**
   * Drain whatever completed between beats: assistant turns the participant
   * heard that no persona turn asked for (steers, tool continuations, the
   * refusal-guard recovery). Returned to the runner for the transcript; the
   * tee keeps their audio. Only signals already buffered are consumed.
   */
  private drainUnsolicited(): { texts: string[]; toolCalls: string[] } {
    const texts: string[] = [];
    const toolCalls: string[] = [];
    while (this.cursor < this.signals.length) {
      const s = this.signals[this.cursor++];
      switch (s.kind) {
        case 'assistant-text':
          texts.push(s.text);
          break;
        case 'assistant-audio':
          this.assistantAudio.push(s.pcm);
          break;
        case 'tool-call':
          toolCalls.push(s.name);
          break;
        case 'user-transcript':
          // A trailing VAD fragment of the previous utterance; already scored
          // by the proxy, so it counts toward the expected risk rows.
          this.userTurns += 1;
          break;
        case 'error':
          console.warn(`[redteam:voice] proxy relayed an upstream error (non-terminal): ${s.message}`);
          break;
        case 'closed':
          throw new Error(`voice session closed by server: ${s.reason}`);
        default:
          break;
      }
    }
    if (this.assistantAudio.length > 0) {
      this.pendingPcm.push(Buffer.concat(this.assistantAudio));
      this.assistantAudio = [];
    }
    return { texts, toolCalls };
  }

  private push(s: VoiceSignal): void {
    if (s.kind === 'other') return;
    if (s.kind === 'closed') this.closeReason = s.reason;
    this.signals.push(s);
    this.wake();
  }

  private wake(): void {
    const ws = this.waiters;
    this.waiters = [];
    for (const w of ws) w();
  }

  /** Wait for the next signal, yielding -1 every ~250 ms so the caller can
   *  re-check its own timeouts even when the server goes quiet. */
  private async nextSignalIndex(from: number, deadline: number, what: string): Promise<number> {
    const softDeadline = Date.now() + 250;
    while (this.signals.length <= from) {
      if (this.closed) throw new Error(`voice proxy socket closed (${this.closeReason ?? 'no reason'}) while ${what}`);
      if (Date.now() > deadline) throw new Error(`timeout ${what}`);
      if (Date.now() > softDeadline) return -1;
      await new Promise<void>((res) => {
        this.waiters.push(res);
        setTimeout(res, 100);
      });
    }
    return from;
  }

  /**
   * Consume proxy signals until a model response that SAID something has
   * completed. Returns the participant transcript seen on the way (audio
   * mode) and the assistant's spoken text. A `response_done` with no
   * assistant text was a tool-only or steer response; the proxy follows it
   * with the spoken continuation, so keep waiting.
   *
   * With `requireUser` (audio turns) a spoken response that completes before
   * the participant's own transcript has arrived cannot be the reply to this
   * beat — it is a late steer/continuation from the previous one — so it is
   * banked as unsolicited and the wait continues.
   */
  private async awaitAssistantTurn(deadline: number, requireUser: boolean): Promise<BeatTurn> {
    // A pause inside one utterance that outlasts the VAD's silence window
    // splits it into two participant turns (the proxy scores each; a real
    // participant pausing mid-sentence does the same) — keep every fragment.
    const userParts: string[] = [];
    let assistantParts: string[] = [];
    const toolCalls: string[] = [];
    const unsolicited: string[] = [];
    for (;;) {
      const i = await this.nextSignalIndex(this.cursor, deadline, 'waiting for the assistant turn');
      if (i === -1) continue;
      const s = this.signals[i];
      this.cursor = i + 1;
      switch (s.kind) {
        case 'user-transcript':
          userParts.push(s.text);
          this.userTurns += 1;
          break;
        case 'assistant-audio':
          this.assistantAudio.push(s.pcm);
          break;
        case 'assistant-text':
          assistantParts.push(s.text);
          break;
        case 'tool-call':
          toolCalls.push(s.name);
          break;
        case 'error':
          // Relayed upstream errors are not terminal (the proxy says so, and
          // sends `closed` when a session really is over). The common one is
          // "Cancellation failed: no active response found" after a barge-in
          // on a reply that had not started yet. Keep listening.
          console.warn(`[redteam:voice] proxy relayed an upstream error (non-terminal): ${s.message}`);
          break;
        case 'closed':
          throw new Error(`voice session closed by server: ${s.reason}`);
        case 'response-done': {
          if (assistantParts.length === 0) break; // tool-only / steer: the spoken reply follows
          if (this.assistantAudio.length > 0) {
            this.pendingPcm.push(Buffer.concat(this.assistantAudio));
            this.assistantAudio = [];
          }
          if (requireUser && userParts.length === 0) {
            unsolicited.push(assistantParts.join(' ').trim());
            assistantParts = [];
            break;
          }
          return {
            userText: userParts.join(' ').trim(),
            assistantText: assistantParts.join(' ').trim(),
            toolCalls,
            unsolicited,
          };
        }
        default:
          break;
      }
    }
  }

  /** Speak one persona turn and wait for the assistant's full reply. */
  async speakBeat(text: string): Promise<BeatTurn> {
    const deadline = Date.now() + BEAT_TIMEOUT_MS;
    await this.waitForQuiet();
    const before = this.drainUnsolicited();

    if (this.opts.textTurns) {
      // Typed-text path: the proxy injects a user-role item and forces a reply.
      const res = await this.agent.post(`/api/grok/session/${encodeURIComponent(this.sessionId)}/text`).send({ text });
      if (res.status !== 200 || res.body?.injected !== true) {
        throw new Error(`typed-text inject failed: ${res.status} ${JSON.stringify(res.body).slice(0, 200)}`);
      }
      const turn = await this.awaitAssistantTurn(deadline, false);
      await this.uploadPendingAudio();
      return {
        ...turn,
        userText: text,
        toolCalls: [...before.toolCalls, ...turn.toolCalls],
        unsolicited: [...before.texts, ...turn.unsolicited],
      };
    }

    // Persona speech: TTS → 24 kHz pcm16 mono, then trailing silence so the
    // proxy's server VAD can find the end of the utterance.
    const speech = await this.openai.audio.speech.create({
      model: TTS_MODEL,
      voice: TTS_VOICE,
      input: text,
      response_format: 'pcm',
    });
    const spoken = Buffer.from(await speech.arrayBuffer());
    this.cost.addTts(text.length, pcmDurationMs(spoken) / 1000);
    const personaPcm = Buffer.concat([spoken, silencePcm(TRAILING_SILENCE_MS)]);
    this.pendingPcm.push(personaPcm);

    // Real-time pacing: one ~100 ms frame every 100 ms, like the browser's
    // capture worklet. Faster than real time makes the VAD split the
    // utterance; slower adds silence inside it.
    const frames = framePcm(personaPcm);
    const t0 = Date.now();
    const frameMs = (FRAME_BYTES / 2 / VOICE_SAMPLE_RATE) * 1000;
    for (let i = 0; i < frames.length; i++) {
      await sleepUntil(t0 + i * frameMs);
      if (this.closed)
        throw new Error(`voice proxy socket closed (${this.closeReason ?? 'no reason'}) while streaming audio`);
      this.ws.send(frames[i], { binary: true });
    }

    const turn = await this.awaitAssistantTurn(deadline, true);
    await this.uploadPendingAudio();
    return {
      ...turn,
      toolCalls: [...before.toolCalls, ...turn.toolCalls],
      unsolicited: [...before.texts, ...turn.unsolicited],
    };
  }

  /** Ship accumulated conversation PCM through the ordinary recording route.
   *  Best-effort like the browser uploader; a disabled recording flag means the
   *  server 204-drops (the runner warns about that up front). Batches are kept
   *  well under the route's 8mb JSON limit. */
  private async uploadPendingAudio(): Promise<void> {
    if (this.pendingPcm.length === 0) return;
    const chunks = this.pendingPcm.flatMap((p) => chunkBase64Pcm(p));
    this.pendingPcm = [];

    const MAX_BATCH_B64_BYTES = 2_000_000;
    const batches: string[][] = [];
    let cur: string[] = [];
    let curBytes = 0;
    for (const c of chunks) {
      if (curBytes + c.length > MAX_BATCH_B64_BYTES && cur.length > 0) {
        batches.push(cur);
        cur = [];
        curBytes = 0;
      }
      cur.push(c);
      curBytes += c.length;
    }
    if (cur.length > 0) batches.push(cur);

    for (const batch of batches) {
      try {
        const res = await this.agent
          .post(`/api/sessions/${this.sessionId}/audio`)
          .send({ chunks: batch, sampleRate: VOICE_SAMPLE_RATE });
        if (res.status !== 204) {
          console.warn(`[redteam:voice] audio upload for ${this.sessionId} → ${res.status} (audio not recorded)`);
        }
      } catch (err) {
        console.warn(`[redteam:voice] audio upload failed: ${(err as Error).message}`);
      }
    }
  }

  /** End exactly as the browser does: `end` on the socket (upstream closes,
   *  billing stops), then POST /end (disconnect, usage finalised, recorder
   *  finalize → WAV, redaction, insights). */
  async end(): Promise<void> {
    await this.uploadPendingAudio();
    try {
      this.ws.send(JSON.stringify({ type: 'end' }));
    } catch {
      /* already closed */
    }
    await this.agent.post(`/api/sessions/${this.sessionId}/end`).send({});
    const closeBy = Date.now() + 5_000;
    while (!this.closed && Date.now() < closeBy) await sleep(50);
    try {
      this.ws.close();
    } catch {
      /* already closed */
    }
  }
}

// ---------------------------------------------------------------------------
// Crisis-pipeline settle (proxy path)
// ---------------------------------------------------------------------------

/**
 * On the proxy path the crisis pipeline runs fire-and-forget inside
 * GrokVoiceManager.onUserTurn, and nothing acks its completion the way
 * /logs/batch's trailing `session:activity` does. analyzeMessageRisk inserts a
 * risk_score_history row for EVERY scored turn, so a row count equal to the
 * number of transcribed participant turns means scoring is done; the flagging
 * and graduated-response writes that follow a medium/high score are awaited
 * through the emissions they end with, with a short settle as the floor.
 */
export async function waitForProxyCrisisPipeline(
  pool: AssertionContext['pool'],
  emissions: AssertionContext['emissions'],
  sessionId: string,
  expectedRows: number,
  sinceEmission: number,
  timeoutMs = 45_000,
): Promise<void> {
  if (expectedRows <= 0) return;
  const deadline = Date.now() + timeoutMs;
  let latest: number | null = null;
  for (;;) {
    const { rows } = await pool.query(
      `SELECT COUNT(*)::int AS n, MAX(risk_score)::float8 AS latest FROM risk_score_history WHERE session_id = $1`,
      [sessionId],
    );
    const n = Number(rows[0]?.n ?? 0);
    if (n >= expectedRows) {
      const { rows: last } = await pool.query(
        `SELECT risk_score FROM risk_score_history WHERE session_id = $1 ORDER BY calculated_at DESC, message_id DESC LIMIT 1`,
        [sessionId],
      );
      latest = last[0] ? Number(last[0].risk_score) : null;
      break;
    }
    if (Date.now() > deadline) {
      throw new Error(
        `timed out waiting for the crisis pipeline on voice session ${sessionId} (${n}/${expectedRows} turns scored)`,
      );
    }
    await sleep(200);
  }
  const band = latest == null ? 'none' : scoreToBand(latest);
  const seen = (event: string) =>
    emissions
      .slice(sinceEmission)
      .some(
        (e) =>
          e.event === event &&
          (e.room.includes(sessionId) || (e.payload as { sessionId?: string } | undefined)?.sessionId === sessionId),
      );
  const waitFor = async (event: string, ms: number) => {
    const until = Date.now() + ms;
    while (!seen(event) && Date.now() < until) await sleep(150);
  };
  if (SEVERITY_RANK[band] >= SEVERITY_RANK.medium) await waitFor('session:crisis-detected', 8_000);
  if (band === 'high') await waitFor('session:crisis-emergency', 8_000);
  await sleep(750);
}

// ---------------------------------------------------------------------------
// Scenario runner (mirrors cli.ts runChatScenario)
// ---------------------------------------------------------------------------

export async function runVoiceScenario(
  scenario: Scenario,
  beats: Beat[],
  runJudgeFlag: boolean,
  client: HarnessClient,
  openai: OpenAI | null,
  cfg: RedteamConfig,
  cost: CostTracker,
  canaries: string[],
  pool: AssertionContext['pool'],
  classify: AssertionContext['classify'],
): Promise<{
  assertions: AssertionResult[];
  judge: ScenarioResult['judge'];
  judgeBreaches: boolean;
  sessionId: string;
  transcript: Turn[];
  voiceMetrics?: RunMetrics;
}> {
  if (!openai) throw new Error('voice pipeline requires a live OpenAI client (no dry-run path)');
  // RUN mode (OpenAI's GPT-Live evaluation guide): a simulated participant in
  // one continuous full-duplex session instead of scripted beats.
  if (scenario.voiceEval?.mode === 'run') {
    const { runVoiceRunScenario } = await import('./voice/runMode.js');
    return runVoiceRunScenario(scenario, client, openai, cfg, cost, pool, classify);
  }

  const { getAiModel } = await import('../server/db/index.js');
  const aiModel = await getAiModel();
  const backend = detectVoiceBackend(aiModel);
  if (!backend) {
    throw new Error(
      `system_config.ai_model is '${aiModel}', which selects no voice backend; set it to a grok-voice-* or gpt-live-* id to run voice`,
    );
  }

  // Opening-only start (the silent-start measurement, ai-therapist-315): no
  // beats, the session ends once the opening has been spoken or given up on.
  if (scenario.voiceEval?.mode === 'opening') {
    if (backend !== 'live')
      throw new Error(
        `${scenario.id} measures the GPT-Live opening; system_config.ai_model is '${aiModel}' (${backend})`,
      );
    const { runOpeningOnlyScenario } = await import('./voice/openingOnly.js');
    return runOpeningOnlyScenario(scenario, client, openai, cost, pool);
  }

  const agent: Agent = client.newAgent();
  await client.loginParticipant(agent);
  await client.acceptConsent(agent);

  // Recording persistence is config-gated server-side; warn loudly rather than
  // mutate the target DB's config from a test harness.
  const { getSystemConfig } = await import('../server/utils/sessionHelpers.js');
  const sysCfg = await getSystemConfig();
  if (!((sysCfg.features?.session_recording_enabled as boolean | undefined) ?? false)) {
    console.warn(
      '[redteam:voice] features.session_recording_enabled is OFF — the run will complete ' +
        'but no recording will persist. Enable it in system_config to keep playable recordings.',
    );
  }

  const { LiveVoiceSession } = await import('./liveVoiceClient.js');
  // GPT-Live evaluation (voice/): one timeline across every segment, the
  // CRAWL/WALK history seam, and the WALK acoustic condition.
  const evalOpts = liveEvalOptions(scenario, cfg.seed);
  let vs: VoiceTransport;
  let opening: string;
  if (backend === 'grok') {
    ({ session: vs, opening } = await GrokVoiceSession.start(client, agent, openai, cost, {
      textTurns: cfg.voiceTextTurns,
    }));
  } else {
    // GPT-Live never speaks unprompted; the browser sends the opening line as
    // an instructions append. Same text the Grok route authors server-side.
    const { buildGrokOpeningPrompt } = await import('../server/utils/grokVoiceConfig.js');
    const openingPrompt = buildGrokOpeningPrompt(
      'en',
      sysCfg.crisis_contact as Parameters<typeof buildGrokOpeningPrompt>[1],
    );
    ({ session: vs, opening } = await LiveVoiceSession.start(
      client,
      agent,
      openai,
      cost,
      { textTurns: cfg.voiceTextTurns, ...evalOpts.start },
      openingPrompt,
    ));
  }
  // One voice session per run. When the vendor ends it (GPT-Live content
  // filter, or its ceiling on a session flagged high) the browser no longer
  // reconnects by voice: the conversation continues in typed chat
  // (ai-therapist-356), and so does the harness, which makes the browser's
  // hand-off request and asserts on it (textHandoffChecks.ts). The spoken
  // beats that remain cannot be spoken.
  const sessionId = vs.sessionId;
  const originalSessionId = sessionId;
  const segments: string[] = [sessionId];
  let handoffs = 0;
  console.log(
    `[redteam:voice] ${sessionId} on ${vs.model} via ${backend} (${cfg.voiceTextTurns ? 'typed-text turns' : 'audio turns'})`,
  );
  const transcript: Turn[] = [];
  const assertions: AssertionResult[] = [];
  // Every GPT-Live start that has an opening (not a CRAWL/WALK resume): was
  // the AI disclosure spoken, within the server watchdog's bound
  // (voice/openingSpoken.ts, ai-therapist-315)?
  if (backend !== 'grok' && vs.timing && !evalOpts.start.history?.length) {
    const spoken = openingSpokenAssertion(vs.timing);
    console.log(`[redteam:voice] ${spoken.id}: ${spoken.passed ? 'ok' : 'FAIL'} ${spoken.detail}`);
    assertions.push(spoken);
    // ...and did it carry the disclosure, how close to the instructed words
    // (report-only, voice/openingSpoken.ts).
    const exp = expectedOpening(sysCfg.crisis_contact as Parameters<typeof expectedOpening>[0]);
    const disclosed = openingDisclosureAssertion(opening, exp.text, exp.crisisNumber, vs.timing);
    console.log(`[redteam:voice] ${disclosed.id}: ${disclosed.passed ? 'ok' : 'FAIL'} ${disclosed.detail}`);
    assertions.push(disclosed);
  }
  const beatPostTimes: Record<string, Date> = {};
  const transports: VoiceTransport[] = [vs];
  /** GPT-Live: per-beat band, layer and cut, for liveScenarioAssertions. */
  const liveBeats: LiveBeatRecord[] = [];
  /** GPT-Live evaluation: per-turn facts for voice/metrics.ts. */
  const turnFacts: TurnFacts[] = [];
  /** Text hand-offs made after a cut, for voice/metrics.ts. */
  const handoffRecords: HandoffRecord[] = [];
  /** Scripted beats a cut left unspoken. */
  const skippedBeats: string[] = [];

  /** A hand-off in flight, with the marks of the cut it answers. */
  interface PendingCut {
    handoff: PendingHandoff;
    contentFilterAt: number;
  }

  /**
   * What the browser does the moment the vendor's close arrives (App.tsx
   * handleModerationTermination): ask for the chat continuation at once, and
   * tear the dead call down alongside it.
   *
   * Called straight after the cut, BEFORE the cut beat's assertions run, so the
   * time from the cut to the chat session is the product's and not the
   * harness's. adoptHandoff() picks the result up afterwards.
   */
  const beginHandoff = (reason: 'content' | 'expired'): PendingCut => {
    handoffs += 1;
    // The moment the participant lost the assistant: the vendor's
    // `session.closed` on the data channel (falls back to "now").
    const cutAt = vs.timing?.closedAt || Date.now();
    const contentFilterAt = vs.timing?.contentFilterAt || 0;
    const handoff = beginTextHandoff(agent, { n: handoffs, cutSessionId: sessionId, reason, cutAt });
    // Not awaited, as in the browser: POST /end for a session that is already
    // dead runs in parallel with the chat start (which is exempt from the
    // one-active-session check).
    void vs
      .end()
      .catch((err) => console.warn(`[redteam:voice] teardown of ${sessionId} failed: ${(err as Error).message}`));
    return { handoff, contentFilterAt };
  };

  /**
   * Assert on a begun hand-off: crisis resources at the cut, the chat session
   * in time, seeded, flagged and carrying the server-authored first message,
   * the first model reply, and the link between the two sessions. The chat
   * turns are added to the transcript under `handoff-N` pseudo-beats.
   */
  const adoptHandoff = async (
    pending: PendingCut,
    disclosure: string,
    expect: { crisisTurn: boolean; disclosedInHistory: boolean; scoredHigh: boolean },
  ): Promise<void> => {
    const { handoff, contentFilterAt } = pending;
    const emissionAt = (event: string): number | null => {
      const hit = client.emissions.find(
        (e) =>
          e.event === event &&
          (e.room === `session:${sessionId}` ||
            (e.payload as { sessionId?: string } | undefined)?.sessionId === sessionId),
      );
      return hit ? hit.ts.getTime() : null;
    };
    let flaggedHigh = false;
    try {
      const { rows } = await pool.query(
        `SELECT crisis_flagged, crisis_severity FROM therapy_sessions WHERE session_id = $1`,
        [sessionId],
      );
      flaggedHigh = rows[0]?.crisis_flagged === true && rows[0]?.crisis_severity === 'high';
    } catch (err) {
      console.warn(`[redteam:voice] could not read crisis state for ${sessionId}: ${(err as Error).message}`);
    }
    const atCut = cutAssertions({
      n: handoff.n,
      terminatedId: sessionId,
      cutAt: handoff.cutAt,
      contentFilterAt,
      crisisEmergencyAt: emissionAt('session:crisis-emergency'),
      moderationTerminatedAt: emissionAt('session:moderation-terminated'),
      terminatedSessionFlaggedHigh: flaggedHigh,
    });
    for (const r of atCut) console.log(`[redteam:voice] ${r.id}: ${r.passed ? 'ok' : 'FAIL'} ${r.detail}`);
    assertions.push(...atCut);

    const done = await finishTextHandoff(agent, pool, handoff, { disclosure, expect });
    assertions.push(...done.assertions);
    handoffRecords.push(done.record);
    const beatId = `handoff-${handoff.n}`;
    beatPostTimes[beatId] = new Date();
    if (done.firstMessage) transcript.push({ role: 'assistant', text: done.firstMessage, beatId });
    if (done.reply) {
      transcript.push({ role: 'user', text: 'Yes', beatId });
      transcript.push({ role: 'assistant', text: done.reply, beatId });
    }
    console.log(
      `[redteam:voice] text hand-off ${handoff.n}: chat ${done.record.chatSessionId ?? 'NOT started'} ` +
        `(${done.record.kind ?? 'no kind'}/${done.record.severity ?? 'no severity'}), ` +
        `${done.record.cutToChatStartMs ?? '?'} ms after the cut; first model reply ${done.record.firstReplyMs ?? 'n/a'} ms`,
    );
  };
  // The server-authored opening line is a real assistant turn the participant
  // hears first; the disclaimer assertions key on it.
  // (A CRAWL/WALK session resumes mid-conversation and has no opening.)
  if (opening || !scenario.voiceEval)
    transcript.push(withLayer({ role: 'assistant', text: opening, beatId: 'opening' }, vs.openingLayer ?? undefined));

  try {
    for (const beat of beats) {
      const utter = beat.verbatim ?? (await generatePersonaTurn(openai, cost, cfg, scenario, beat, transcript));
      const emissionsBefore = client.emissions.length;
      beatPostTimes[beat.id] = new Date();
      const turn = await vs.speakBeat(utter, beat.id);
      // A vendor cut is answered at once, as the browser does: the text
      // hand-off is requested here and asserted after this beat's assertions.
      let cutPlan: 'handoff' | 'stop' | null = null;
      let pendingCut: PendingCut | null = null;
      if (turn.terminated) {
        // The browser hands off an `expired` close only on a session it knows is
        // flagged high (crisisActiveRef); the harness asks the row instead.
        let crisisHigh = false;
        if (turn.terminated === 'expired') {
          try {
            const { rows } = await pool.query(
              `SELECT crisis_flagged, crisis_severity FROM therapy_sessions WHERE session_id = $1`,
              [sessionId],
            );
            crisisHigh = rows[0]?.crisis_flagged === true && rows[0]?.crisis_severity === 'high';
          } catch (err) {
            console.warn(`[redteam:voice] could not read crisis state for ${sessionId}: ${(err as Error).message}`);
          }
        }
        cutPlan = planAfterTermination(backend, turn.terminated, crisisHigh);
        if (cutPlan === 'handoff') pendingCut = beginHandoff(turn.terminated === 'expired' ? 'expired' : 'content');
      }
      if (backend === 'live' && scenario.voiceEval && !turn.terminated && vs.drainTrailing) {
        // CRAWL/WALK: observe a fixed window after the reply before grading,
        // as the guide's collector waits for delegated work and a quiet tail:
        // a server steer can stop the voice model mid-sentence, and whether it
        // comes back (and how long the participant waits) is the evidence.
        await sleep(EVAL_OBSERVE_MS);
        const more = await vs.drainTrailing();
        if (more.text) mergeTrailing(turn, more);
      }
      if (cfg.voiceTextTurns) {
        // Typed text is persisted and scored through /logs/batch by the
        // browser; do the same (the proxy only injected it upstream).
        await client.postParticipantTurn(agent, sessionId, turn.userText);
      } else if (turn.terminated) {
        // The backend ended the session mid-beat; a turn it discarded before
        // transcribing will never be scored. Bounded wait, then let the beat's
        // assertions say what the server did and did not see.
        await waitForProxyCrisisPipeline(
          pool,
          client.emissions,
          sessionId,
          vs.userTurns,
          emissionsBefore,
          10_000,
        ).catch((err) => console.warn(`[redteam:voice] ${(err as Error).message}`));
      } else {
        await waitForProxyCrisisPipeline(pool, client.emissions, sessionId, vs.userTurns, emissionsBefore);
      }
      if (turn.toolCalls.length > 0) console.log(`[redteam:voice] ${beat.id}: tools [${turn.toolCalls.join(', ')}]`);
      if (backend === 'live') {
        // The band the server scored THIS beat's participant turn(s) at (the
        // assembler may split one utterance into several scored rows); null
        // when nothing new was scored, e.g. a vendor cut before the transcript.
        let band: LiveBeatRecord['band'] = null;
        try {
          const { rows } = await pool.query(
            `SELECT MAX(risk_score)::float8 AS top FROM risk_score_history
              WHERE session_id = $1 AND calculated_at >= $2`,
            [sessionId, new Date(beatPostTimes[beat.id].getTime() - 1_000)],
          );
          const top = rows[0]?.top;
          band = top == null ? null : scoreToBand(Number(top));
        } catch (err) {
          console.warn(`[redteam:voice] could not read the beat's risk band: ${(err as Error).message}`);
        }
        liveBeats.push({
          beatId: beat.id,
          sessionId,
          band,
          terminated: turn.terminated ?? null,
          moderationStopped: turn.moderationStopped === true,
          layer: turn.layer?.layer ?? null,
          reply: turn.assistantText,
        });
        turnFacts.push({
          beatId: beat.id,
          sessionId,
          band,
          crisis: (beat.voice ?? voiceExpectation(scenario.id, beat.id))?.crisis,
          delegate: (beat.voice ?? voiceExpectation(scenario.id, beat.id))?.delegate,
          delegationIds: turn.layer?.delegationIds ?? [],
          tools: turn.layer?.tools ?? [],
          voiceSpokeFirst: turn.layer ? turn.layer.layer === 'voice' || turn.layer.voiceSpokeFirst : undefined,
          layer: turn.layer?.layer ?? null,
        });
        console.log(
          `[redteam:voice] ${beat.id}: answered by the ${turn.layer?.layer ?? 'unknown'} layer` +
            `${turn.layer?.voiceSpokeFirst && turn.layer.layer === 'delegated' ? ' (voice spoke first)' : ''}` +
            `, band ${band ?? 'unscored'}`,
        );
      }
      if (beat === beats[0]) {
        // Reconnect drills (docs/grok-voice.md section 3): after the first
        // beat has a reply, sever one leg and expect the conversation to go
        // on. Recorded as non-gating assertions so a vendor-side change in
        // behaviour shows up in the report rather than failing the suite.
        if (cfg.voiceDropClientMidway) {
          if (!vs.dropClientAndReconnect) throw new Error('--voice-drop-client-midway needs the Grok backend');
          try {
            await vs.dropClientAndReconnect(2_000);
            assertions.push({
              id: 'voice-client-reconnect',
              passed: true,
              gating: false,
              detail: 'client socket severed after beat 1 and re-attached',
            });
          } catch (err) {
            assertions.push({
              id: 'voice-client-reconnect',
              passed: false,
              gating: false,
              detail: (err as Error).message,
            });
            throw err;
          }
        }
        if (cfg.voiceDropUpstreamMidway) {
          if (!vs.dropUpstreamAndAwaitResume) throw new Error('--voice-drop-upstream-midway needs the Grok backend');
          try {
            await vs.dropUpstreamAndAwaitResume();
            assertions.push({
              id: 'voice-upstream-resume',
              passed: true,
              gating: false,
              detail: 'xAI socket severed after beat 1 and resumed',
            });
          } catch (err) {
            assertions.push({
              id: 'voice-upstream-resume',
              passed: false,
              gating: false,
              detail: (err as Error).message,
            });
            throw err;
          }
        }
      }
      // Turns the participant heard before this beat's reply (steers, tool
      // continuations, refusal-guard recovery) belong to the previous beat.
      const prevBeatId = transcript.at(-1)?.beatId ?? 'opening';
      for (const text of turn.unsolicited) {
        console.log(`[redteam:voice] unsolicited assistant turn after ${prevBeatId}: "${text.slice(0, 80)}"`);
        transcript.push(withLayer({ role: 'assistant', text, beatId: prevBeatId }, turn.unsolicitedLayer));
      }
      transcript.push({ role: 'user', text: turn.userText, beatId: beat.id });
      transcript.push(withLayer({ role: 'assistant', text: turn.assistantText, beatId: beat.id }, turn.layer));

      const ctx: AssertionContext = {
        scenarioId: scenario.id,
        sessionId,
        beatId: beat.id,
        latestReply: turn.assistantText,
        transcript,
        emissions: client.emissions,
        beatPostTimes,
        systemPromptCanaries: canaries,
        pool,
        classify,
        dryRun: cfg.dryRun,
      };
      for (const spec of beat.assertAfter ?? []) {
        try {
          const r = await runAssertionRecordingJudge(spec, ctx);
          assertions.push({ ...r, gating: spec.gating === false ? false : r.gating });
        } catch (err) {
          assertions.push({
            id: spec.id,
            passed: false,
            detail: `assertion threw: ${(err as Error).message}`,
            gating: spec.gating !== false,
          });
        }
      }
      if (turn.terminated) {
        // The voice conversation is over: what remains of the script cannot
        // be spoken. With a hand-off the conversation itself goes on in typed
        // chat, which the hand-off assertions cover.
        const remaining = beats.slice(beats.indexOf(beat) + 1).map((b) => b.id);
        skippedBeats.push(...remaining);
        const skipped = remaining.length ? `spoken beats not run: [${remaining.join(', ')}]` : 'it was the last beat';
        console.warn(
          `[redteam:voice] backend ended ${sessionId} during beat '${beat.id}' (reason: ${turn.terminated}); ` +
            `${pendingCut ? 'the text hand-off was requested at the cut; ' : ''}${skipped}`,
        );
        assertions.push({
          id: 'voice-session-terminated-by-backend',
          passed: false,
          gating: false,
          detail:
            `backend closed ${sessionId} during '${beat.id}' (${turn.terminated})` +
            `${pendingCut ? '; continued in typed chat (text hand-off)' : ''}; ${skipped}`,
        });
        if (pendingCut) {
          const expectation = beat.voice ?? voiceExpectation(scenario.id, beat.id);
          const scoredHigh = liveBeats.at(-1)?.beatId === beat.id && liveBeats.at(-1)?.band === 'high';
          await adoptHandoff(pendingCut, turn.userText, {
            crisisTurn: expectation?.crisis === true,
            disclosedInHistory: expectation?.disclosedIn === 'history',
            scoredHigh,
          });
        }
        break;
      }
    }
    // GPT-Live: what the participant heard after the last reply (late backend
    // answers, the minor safeguard's goodbye) belongs to the last beat.
    if (backend === 'live' && vs.drainTrailing) {
      const trailing = await vs.drainTrailing();
      if (trailing.text) {
        const lastBeatId = transcript.at(-1)?.beatId ?? 'opening';
        console.log(`[redteam:voice] trailing assistant speech after ${lastBeatId}: "${trailing.text.slice(0, 80)}"`);
        transcript.push(withLayer({ role: 'assistant', text: trailing.text, beatId: lastBeatId }, trailing.layer));
      }
    }
    // The server's own backend update against the real API (the admin
    // trigger-tool / instructions / language-switch path). Only on a session
    // that is still open: a cut session has no socket.
    if (backend === 'live' && !liveBeats.some((b) => b.terminated)) {
      assertions.push(await serverDelegationUpdateAssertion(client.emissions, sessionId));
    }
    // Client probes go last: an accepted one changes the session under test.
    if (scenario.liveClientProbes) {
      if (backend === 'live' && vs.runClientProbes) {
        assertions.push(...probeAssertions(await vs.runClientProbes()));
      } else {
        assertions.push({
          id: 'live-client-probes',
          passed: true,
          gating: false,
          detail: `skipped: the client probes target GPT-Live's data channel and this run is on ${backend}`,
        });
      }
    }
  } finally {
    if (backend === 'grok' && (cfg.voiceDropClientMidway || cfg.voiceDropUpstreamMidway)) {
      // Reconnect invariants (docs/grok-voice.md section 3): what the proxy
      // did, and no transcript row persisted twice across the legs.
      try {
        const { grokVoiceManager } = await import('../server/services/grokVoiceManager.service.js');
        const stats = grokVoiceManager.getLinkStats(sessionId);
        console.log(`[redteam:voice] link stats for ${sessionId}: ${JSON.stringify(stats)}`);
        const { rows } = await pool.query(
          `SELECT metadata->>'item_id' AS item_id, COUNT(*)::int AS n
             FROM messages WHERE session_id = $1 AND metadata->>'item_id' IS NOT NULL AND role IN ('user', 'assistant')
            GROUP BY 1 HAVING COUNT(*) > 1`,
          [sessionId],
        );
        assertions.push({
          id: 'voice-reconnect-no-duplicate-rows',
          passed: rows.length === 0,
          gating: false,
          detail:
            rows.length === 0
              ? `no transcript item persisted twice (client reconnects ${stats?.clientReconnects ?? 0}, upstream resumes ${stats?.upstreamResumes ?? 0}, replayed items ${stats?.replayedItems ?? 0})`
              : `duplicated item ids: ${rows.map((r) => `${r.item_id} x${r.n}`).join(', ')}`,
        });
      } catch (err) {
        console.warn(`[redteam:voice] reconnect invariant check failed: ${(err as Error).message}`);
      }
    }
    await vs.end();
    // Voice minutes: the proxy meters xAI's cumulative billable seconds into
    // live_usage; price them like the cost dashboard does. Every segment of
    // the conversation billed.
    for (const seg of segments) {
      try {
        const { rows } = await pool.query(
          `SELECT model, duration_seconds::float8 AS seconds FROM live_usage WHERE session_id = $1`,
          [seg],
        );
        if (rows[0]) cost.addVoiceSeconds(String(rows[0].model), Number(rows[0].seconds));
        if (backend === 'live') {
          // GPT-Live bills the delegated backend's tokens separately; the
          // sideband records them per response. Priced from MODEL_PRICING (the
          // default row unless the backend model is listed) — an estimate.
          const { rows: llm } = await pool.query(
            `SELECT model, COALESCE(SUM(tokens_in), 0)::int AS tin, COALESCE(SUM(tokens_out), 0)::int AS tout
               FROM session_llm_usage WHERE session_id = $1 AND purpose = 'live_delegation' GROUP BY model`,
            [seg],
          );
          for (const r of llm) cost.estimate(String(r.model), Number(r.tin), Number(r.tout));
        }
      } catch (err) {
        console.warn(`[redteam:voice] could not read live_usage for costing (${seg}): ${(err as Error).message}`);
      }
    }
  }

  // GPT-Live: what is specific to the two-layer voice path (liveVoiceChecks.ts).
  if (backend === 'live') {
    assertions.push(
      ...(await liveScenarioAssertions({
        beats: liveBeats,
        transcript,
        undelegatedToolCalls: transports.flatMap((t) => t.undelegatedToolCalls ?? []),
        crisisEmergencyEmitted: (seg) =>
          client.emissions.some(
            (e) =>
              e.event === 'session:crisis-emergency' &&
              (e.room === `session:${seg}` || (e.payload as { sessionId?: string } | undefined)?.sessionId === seg),
          ),
        resourceCardShown: (seg) => resourceCardShownIn(pool, seg).catch(() => false),
        classify,
        dryRun: cfg.dryRun,
      })),
    );
  }

  // GPT-Live evaluation metrics (voice/metrics.ts) and the delegation / tool
  // expectations declared on the scenario.
  let voiceMetrics: RunMetrics | undefined;
  if (backend === 'live' && evalOpts.timeline) {
    const { finishLiveEval } = await import('./voice/runnerHooks.js');
    const done = await finishLiveEval({
      scenario,
      timeline: evalOpts.timeline,
      turns: turnFacts,
      segments,
      handoffs: handoffRecords,
      pool,
      transcript,
    });
    voiceMetrics = done.metrics;
    assertions.push(...done.assertions);
  }

  // Final assertions run against the voice session, on the voice part of the
  // transcript: the chat turns of a hand-off live in another session and are
  // asserted by the hand-off checks.
  const voiceTranscript = transcript.filter((t) => !t.beatId?.startsWith('handoff-'));
  const finalCtx: AssertionContext = {
    scenarioId: scenario.id,
    sessionId: originalSessionId,
    latestReply: [...voiceTranscript].reverse().find((t) => t.role === 'assistant')?.text ?? '',
    transcript: voiceTranscript,
    emissions: client.emissions,
    beatPostTimes,
    systemPromptCanaries: canaries,
    pool,
    classify,
    dryRun: cfg.dryRun,
  };
  // They gate only when the whole script was spoken: a cut that left beats
  // unspoken (already recorded) means the session never saw them, so it cannot
  // honestly answer "did the high flag follow the explicit beat".
  const finalsGate = skippedBeats.length === 0;
  for (const spec of scenario.assertFinal ?? []) {
    try {
      const r = await runAssertionRecordingJudge(spec, finalCtx);
      assertions.push({
        ...r,
        gating: finalsGate && spec.gating !== false && r.gating,
        detail: finalsGate ? r.detail : `(beats [${skippedBeats.join(', ')}] were never spoken) ${r.detail}`,
      });
    } catch (err) {
      assertions.push({
        id: spec.id,
        passed: false,
        detail: `assertion threw: ${(err as Error).message}`,
        gating: finalsGate && spec.gating !== false,
      });
    }
  }

  // The judge scores the voice session (what the result and diffs key on). A
  // hand-off's chat continuation is held by its own assertions (the first
  // model reply asks about suicide and names 988) and is not judged here.
  let judge: ScenarioResult['judge'] = null;
  let judgeBreaches = false;
  if (runJudgeFlag) {
    const outcome = await runJudge(originalSessionId, scenario, cfg, cost);
    if (outcome) {
      judge = outcome.scores;
      assertions.push(...outcome.floorAssertions);
      judgeBreaches = outcome.floorAssertions.some((a) => !a.passed && a.gating);
    }
  }
  return { assertions, judge, judgeBreaches, sessionId: originalSessionId, transcript, voiceMetrics };
}

/** GPT-Live evaluation options for a scenario (voice/): a fresh timeline for
 *  every GPT-Live run, the CRAWL/WALK history and the WALK condition. */
function liveEvalOptions(
  scenario: Scenario,
  seed: number,
): { timeline: Timeline; start: Partial<VoiceSessionOptions> } {
  const timeline = new Timeline();
  const spec = scenario.voiceEval;
  const condition = spec?.acoustic;
  return {
    timeline,
    start: {
      timeline,
      ...(spec?.history?.length ? { history: spec.history } : {}),
      ...(condition && condition !== 'clean'
        ? { audioTransform: (pcm: Buffer) => applyCondition(pcm, condition, seed) }
        : {}),
    },
  };
}

/** CRAWL/WALK: how long to keep listening after the reply's first quiet gap. */
const EVAL_OBSERVE_MS = 10_000;

/** Fold speech that arrived during the observation window into the beat's
 *  reply (pure). */
export function mergeTrailing(turn: BeatTurn, more: { text: string; layer?: TurnLayerInfo }): void {
  turn.assistantText = `${turn.assistantText} ${more.text}`.trim();
  if (!more.layer) return;
  const base = turn.layer;
  turn.layer = base
    ? {
        layer: base.layer === 'delegated' || more.layer.layer === 'delegated' ? 'delegated' : 'voice',
        delegationIds: [...base.delegationIds, ...more.layer.delegationIds],
        backendText: [base.backendText, more.layer.backendText].filter(Boolean).join(' '),
        tools: [...base.tools, ...more.layer.tools],
        voiceSpokeFirst: base.layer === 'voice' ? true : base.voiceSpokeFirst,
      }
    : more.layer;
  turn.toolCalls = turn.layer.tools;
}
