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
//                 sideband attach. Driving that headlessly needs a WebRTC
//                 stack with an Opus encoder on the Node side; NOT ported yet
//                 (see docs/redteam.md "Voice suite") — the runner refuses
//                 with a pointer rather than pretending.
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
import {
  type AssertionContext,
  type AssertionResult,
  type Beat,
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
  return framePcm(pcm, chunkBytes).map(f => f.toString('base64'));
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
  return ms <= 0 ? Promise.resolve() : new Promise(r => setTimeout(r, ms));
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
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
   *  class the browser answers with a recovery start). The beat's assertions
   *  still run on what was said and scored; later beats cannot. */
  terminated?: string;
}

/** How long the assistant must have been silent (no audio, no transcript
 *  delta) before the persona starts a turn, like a participant waiting for
 *  the assistant to finish. Bounded so a chatty steer loop cannot stall. */
const QUIET_BEFORE_SPEAKING_MS = 1_200;
const QUIET_WAIT_CAP_MS = 20_000;

export interface VoiceSessionOptions {
  /** Drive turns through the typed-text path instead of audio. */
  textTurns: boolean;
}

/** What the scenario runner needs from a voice backend; the Grok proxy
 *  session below and the GPT-Live session (liveVoiceClient.ts) both provide it. */
export interface VoiceTransport {
  readonly sessionId: string;
  /** Resolved model id the session runs on. */
  readonly model: string;
  /** Lower bound on participant turns the server has scored so far. */
  readonly userTurns: number;
  speakBeat(text: string): Promise<BeatTurn>;
  end(): Promise<void>;
  /** Sever the browser-side socket and reconnect it (Grok only). */
  dropClientAndReconnect?(gapMs: number): Promise<void>;
  /** Sever the server's xAI socket and wait for the proxy to resume it (Grok only). */
  dropUpstreamAndAwaitResume?(): Promise<void>;
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
    if (!client.baseUrl) throw new Error('voice pipeline needs a listening server (HarnessClient.listen) for the WebSocket upgrade');

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
    ws.on('error', err => { if (this.ws === ws) this.push({ kind: 'error', message: err.message }); });
    ws.on('unexpected-response', (_req, resp) => {
      this.push({ kind: 'error', message: `proxy upgrade rejected: HTTP ${resp.statusCode}` });
      try { ws.terminate(); } catch { /* already gone */ }
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
      if (s.kind === 'ready') { this.model = s.model; return s.resumed; }
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
    console.log(`[redteam:voice] severing the xAI socket for ${this.sessionId} (conversation ${before?.conversationId ?? 'none'})`);
    if (!grokVoiceManager._dropUpstreamForTests(this.sessionId)) throw new Error('no upstream socket to drop');
    const deadline = Date.now() + RESUME_TIMEOUT_MS;
    let sawReconnecting = false;
    for (;;) {
      const i = await this.nextSignalIndex(this.cursor, deadline, 'waiting for the proxy to resume its xAI link');
      if (i === -1) continue;
      const s = this.signals[i];
      this.cursor = i + 1;
      if (s.kind === 'link') {
        if (s.state === 'reconnecting') { sawReconnecting = true; continue; }
        if (!sawReconnecting) throw new Error('link restored before any reconnecting notice');
        break;
      }
      if (s.kind === 'closed') throw new Error(`voice session closed by server during resume: ${s.reason}`);
      // Whatever else arrives in the gap (a late audio tail, an error relay)
      // is kept for the recording and otherwise skipped: the assistant was
      // quiet when the link was cut, so nothing here is a reply to a beat.
      if (s.kind === 'assistant-audio') this.assistantAudio.push(s.pcm);
      if (s.kind === 'assistant-text') console.log(`[redteam:voice] assistant spoke during the resume gap: "${s.text.slice(0, 80)}"`);
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
        case 'assistant-text': texts.push(s.text); break;
        case 'assistant-audio': this.assistantAudio.push(s.pcm); break;
        case 'tool-call': toolCalls.push(s.name); break;
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
        default: break;
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
      await new Promise<void>(res => {
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
      if (this.closed) throw new Error(`voice proxy socket closed (${this.closeReason ?? 'no reason'}) while streaming audio`);
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
    const chunks = this.pendingPcm.flatMap(p => chunkBase64Pcm(p));
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
    try { this.ws.send(JSON.stringify({ type: 'end' })); } catch { /* already closed */ }
    await this.agent.post(`/api/sessions/${this.sessionId}/end`).send({});
    const closeBy = Date.now() + 5_000;
    while (!this.closed && Date.now() < closeBy) await sleep(50);
    try { this.ws.close(); } catch { /* already closed */ }
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
      throw new Error(`timed out waiting for the crisis pipeline on voice session ${sessionId} (${n}/${expectedRows} turns scored)`);
    }
    await sleep(200);
  }
  const band = latest == null ? 'none' : scoreToBand(latest);
  const seen = (event: string) =>
    emissions.slice(sinceEmission).some(e => e.event === event && (e.room.includes(sessionId) || (e.payload as { sessionId?: string } | undefined)?.sessionId === sessionId));
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
): Promise<{ assertions: AssertionResult[]; judge: ScenarioResult['judge']; judgeBreaches: boolean; sessionId: string }> {
  if (!openai) throw new Error('voice pipeline requires a live OpenAI client (no dry-run path)');

  const { getAiModel } = await import('../server/db/index.js');
  const aiModel = await getAiModel();
  const backend = detectVoiceBackend(aiModel);
  if (!backend) {
    throw new Error(`system_config.ai_model is '${aiModel}', which selects no voice backend; set it to a grok-voice-* or gpt-live-* id to run voice`);
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

  let vs: VoiceTransport;
  let opening: string;
  if (backend === 'grok') {
    ({ session: vs, opening } = await GrokVoiceSession.start(client, agent, openai, cost, { textTurns: cfg.voiceTextTurns }));
  } else {
    // GPT-Live never speaks unprompted; the browser sends the opening line as
    // an instructions append. Same text the Grok route authors server-side.
    const { buildGrokOpeningPrompt } = await import('../server/utils/grokVoiceConfig.js');
    const openingPrompt = buildGrokOpeningPrompt('en', sysCfg.crisis_contact as Parameters<typeof buildGrokOpeningPrompt>[1]);
    const { LiveVoiceSession } = await import('./liveVoiceClient.js');
    ({ session: vs, opening } = await LiveVoiceSession.start(client, agent, openai, cost, { textTurns: cfg.voiceTextTurns }, openingPrompt));
  }
  const sessionId = vs.sessionId;
  console.log(`[redteam:voice] ${sessionId} on ${vs.model} via ${backend} (${cfg.voiceTextTurns ? 'typed-text turns' : 'audio turns'})`);
  const transcript: Turn[] = [];
  const assertions: AssertionResult[] = [];
  const beatPostTimes: Record<string, Date> = {};
  // The server-authored opening line is a real assistant turn the participant
  // hears first; the disclaimer assertions key on it.
  transcript.push({ role: 'assistant', text: opening, beatId: 'opening' });

  try {
    for (const beat of beats) {
      const utter = beat.verbatim ?? (await generatePersonaTurn(openai, cost, cfg, scenario, beat, transcript));
      const emissionsBefore = client.emissions.length;
      beatPostTimes[beat.id] = new Date();
      const turn = await vs.speakBeat(utter);
      if (cfg.voiceTextTurns) {
        // Typed text is persisted and scored through /logs/batch by the
        // browser; do the same (the proxy only injected it upstream).
        await client.postParticipantTurn(agent, sessionId, turn.userText);
      } else if (turn.terminated) {
        // The backend ended the session mid-beat; a turn it discarded before
        // transcribing will never be scored. Bounded wait, then let the beat's
        // assertions say what the server did and did not see.
        await waitForProxyCrisisPipeline(pool, client.emissions, sessionId, vs.userTurns, emissionsBefore, 10_000)
          .catch(err => console.warn(`[redteam:voice] ${(err as Error).message}`));
      } else {
        await waitForProxyCrisisPipeline(pool, client.emissions, sessionId, vs.userTurns, emissionsBefore);
      }
      if (turn.toolCalls.length > 0) console.log(`[redteam:voice] ${beat.id}: tools [${turn.toolCalls.join(', ')}]`);
      if (beat === beats[0]) {
        // Reconnect drills (docs/grok-voice.md section 3): after the first
        // beat has a reply, sever one leg and expect the conversation to go
        // on. Recorded as non-gating assertions so a vendor-side change in
        // behaviour shows up in the report rather than failing the suite.
        if (cfg.voiceDropClientMidway) {
          if (!vs.dropClientAndReconnect) throw new Error('--voice-drop-client-midway needs the Grok backend');
          try {
            await vs.dropClientAndReconnect(2_000);
            assertions.push({ id: 'voice-client-reconnect', passed: true, gating: false, detail: 'client socket severed after beat 1 and re-attached' });
          } catch (err) {
            assertions.push({ id: 'voice-client-reconnect', passed: false, gating: false, detail: (err as Error).message });
            throw err;
          }
        }
        if (cfg.voiceDropUpstreamMidway) {
          if (!vs.dropUpstreamAndAwaitResume) throw new Error('--voice-drop-upstream-midway needs the Grok backend');
          try {
            await vs.dropUpstreamAndAwaitResume();
            assertions.push({ id: 'voice-upstream-resume', passed: true, gating: false, detail: 'xAI socket severed after beat 1 and resumed' });
          } catch (err) {
            assertions.push({ id: 'voice-upstream-resume', passed: false, gating: false, detail: (err as Error).message });
            throw err;
          }
        }
      }
      // Turns the participant heard before this beat's reply (steers, tool
      // continuations, refusal-guard recovery) belong to the previous beat.
      const prevBeatId = transcript.at(-1)?.beatId ?? 'opening';
      for (const text of turn.unsolicited) {
        console.log(`[redteam:voice] unsolicited assistant turn after ${prevBeatId}: "${text.slice(0, 80)}"`);
        transcript.push({ role: 'assistant', text, beatId: prevBeatId });
      }
      transcript.push({ role: 'user', text: turn.userText, beatId: beat.id });
      transcript.push({ role: 'assistant', text: turn.assistantText, beatId: beat.id });

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
          const r = await spec.run(ctx);
          assertions.push({ ...r, gating: spec.gating === false ? false : r.gating });
        } catch (err) {
          assertions.push({ id: spec.id, passed: false, detail: `assertion threw: ${(err as Error).message}`, gating: spec.gating !== false });
        }
      }
      if (turn.terminated) {
        const remaining = beats.slice(beats.indexOf(beat) + 1).map(b => b.id);
        console.warn(
          `[redteam:voice] backend ended the session during beat '${beat.id}' (reason: ${turn.terminated}); ` +
          (remaining.length ? `beats [${remaining.join(', ')}] not run` : 'it was the last beat'),
        );
        assertions.push({
          id: 'voice-session-terminated-by-backend',
          passed: false,
          gating: false,
          detail: `backend closed the session during '${beat.id}' (${turn.terminated})${remaining.length ? `; skipped [${remaining.join(', ')}]` : ''}`,
        });
        break;
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
          detail: rows.length === 0
            ? `no transcript item persisted twice (client reconnects ${stats?.clientReconnects ?? 0}, upstream resumes ${stats?.upstreamResumes ?? 0}, replayed items ${stats?.replayedItems ?? 0})`
            : `duplicated item ids: ${rows.map(r => `${r.item_id} x${r.n}`).join(', ')}`,
        });
      } catch (err) {
        console.warn(`[redteam:voice] reconnect invariant check failed: ${(err as Error).message}`);
      }
    }
    await vs.end();
    // Voice minutes: the proxy meters xAI's cumulative billable seconds into
    // live_usage; price them like the cost dashboard does.
    try {
      const { rows } = await pool.query(
        `SELECT model, duration_seconds::float8 AS seconds FROM live_usage WHERE session_id = $1`,
        [sessionId],
      );
      if (rows[0]) cost.addVoiceSeconds(String(rows[0].model), Number(rows[0].seconds));
      if (backend === 'live') {
        // GPT-Live bills the delegated backend's tokens separately; the
        // sideband records them per response. Priced from MODEL_PRICING (the
        // default row unless the backend model is listed) — an estimate.
        const { rows: llm } = await pool.query(
          `SELECT model, COALESCE(SUM(tokens_in), 0)::int AS tin, COALESCE(SUM(tokens_out), 0)::int AS tout
             FROM session_llm_usage WHERE session_id = $1 AND purpose = 'live_delegation' GROUP BY model`,
          [sessionId],
        );
        for (const r of llm) cost.estimate(String(r.model), Number(r.tin), Number(r.tout));
      }
    } catch (err) {
      console.warn(`[redteam:voice] could not read live_usage for costing: ${(err as Error).message}`);
    }
  }

  const finalCtx: AssertionContext = {
    scenarioId: scenario.id,
    sessionId,
    latestReply: transcript.at(-1)?.text ?? '',
    transcript,
    emissions: client.emissions,
    beatPostTimes,
    systemPromptCanaries: canaries,
    pool,
    classify,
    dryRun: cfg.dryRun,
  };
  for (const spec of scenario.assertFinal ?? []) {
    try {
      const r = await spec.run(finalCtx);
      assertions.push({ ...r, gating: spec.gating === false ? false : r.gating });
    } catch (err) {
      assertions.push({ id: spec.id, passed: false, detail: `assertion threw: ${(err as Error).message}`, gating: spec.gating !== false });
    }
  }

  let judge: ScenarioResult['judge'] = null;
  let judgeBreaches = false;
  if (runJudgeFlag) {
    const outcome = await runJudge(sessionId, scenario, cfg, cost);
    if (outcome) {
      judge = outcome.scores;
      assertions.push(...outcome.floorAssertions);
      judgeBreaches = outcome.floorAssertions.some(a => !a.passed && a.gating);
    }
  }
  return { assertions, judge, judgeBreaches, sessionId };
}
