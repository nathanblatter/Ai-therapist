// Voice pipeline (ai-therapist-124 phase 2): a Node-side stand-in for the
// participant browser. Mints the real ephemeral secret via POST /token,
// connects to OpenAI Realtime over WebSocket (media arrives as
// response.output_audio.delta events instead of WebRTC RTP), speaks persona
// turns via OpenAI TTS into input_audio_buffer.append, and tees BOTH audio
// directions into the ordinary session recording path
// (POST /api/sessions/:id/audio → recorder.service → WAV in object storage) —
// so eval recordings are playable in admin SessionDetail like any other
// session's. Transcripts flow through POST /logs/batch exactly as the browser
// posts them, so crisis detection, assertions, and the judge see the normal
// shape.
//
// Known fidelity limits (see plans/covalStyleEvalsPlan.md):
// - No WebRTC call id → the server sideband (tools/steering) does not attach.
// - Turn-taking is HARNESS-DRIVEN, not VAD-driven: the harness appends TTS
//   audio faster than real time, which makes prod's semantic VAD split one
//   utterance into several turns — each new speech_started cancels the
//   in-flight response and no reply ever completes (verified live,
//   2026-08-15). So after connect we session.update turn_detection off and
//   drive input_audio_buffer.commit + response.create explicitly. Exercising
//   real VAD would require real-time-paced streaming (minutes per beat) —
//   a possible future --realtime-pacing flag, deliberately not the default.
import type OpenAI from 'openai';
import WebSocket from 'ws';
import type { CostTracker, RedteamConfig } from './config.js';
import type { Agent, HarnessClient } from './harnessClient.js';
import { generatePersonaTurn } from './personaDriver.js';
import { runJudge } from './judge.js';
import type {
  AssertionContext,
  AssertionResult,
  Beat,
  Scenario,
  ScenarioResult,
  Turn,
} from './types.js';

export const VOICE_SAMPLE_RATE = 24_000; // OpenAI TTS pcm + Realtime pcm16 default
const TTS_MODEL = 'gpt-4o-mini-tts';
const TTS_VOICE = 'alloy';
const BEAT_TIMEOUT_MS = 90_000;
const APPEND_CHUNK_BYTES = 48_000; // 1s of 24kHz pcm16 per append frame

// ---------------------------------------------------------------------------
// Pure helpers (unit-tested offline in voiceClient.test.ts)
// ---------------------------------------------------------------------------

/** Split a PCM buffer into base64 frames of at most chunkBytes (16-bit aligned). */
export function chunkBase64Pcm(pcm: Buffer, chunkBytes = APPEND_CHUNK_BYTES): string[] {
  const even = chunkBytes - (chunkBytes % 2);
  const out: string[] = [];
  for (let off = 0; off < pcm.length; off += even) {
    out.push(pcm.subarray(off, Math.min(off + even, pcm.length)).toString('base64'));
  }
  return out;
}

/** ms of PCM16 silence at the voice sample rate (helps VAD find end-of-speech). */
export function silencePcm(ms: number, sampleRate = VOICE_SAMPLE_RATE): Buffer {
  return Buffer.alloc(Math.floor((sampleRate * ms) / 1000) * 2);
}

export type RealtimeSignal =
  | { kind: 'assistant-audio'; b64: string }
  | { kind: 'assistant-text'; text: string }
  | { kind: 'user-transcript'; text: string }
  | { kind: 'committed' }
  | { kind: 'response-done' }
  | { kind: 'error'; message: string }
  | { kind: 'other' };

/** Map a raw Realtime server event to the signals the voice runner consumes.
 *  Handles both the GA names (response.output_audio.*) and the older beta
 *  names (response.audio.*) so a server-side rename doesn't silently mute us. */
export function parseRealtimeEvent(ev: Record<string, unknown>): RealtimeSignal {
  const type = typeof ev.type === 'string' ? ev.type : '';
  switch (type) {
    case 'response.output_audio.delta':
    case 'response.audio.delta':
      return typeof ev.delta === 'string' ? { kind: 'assistant-audio', b64: ev.delta } : { kind: 'other' };
    case 'response.output_audio_transcript.done':
    case 'response.audio_transcript.done':
      return typeof ev.transcript === 'string' ? { kind: 'assistant-text', text: ev.transcript } : { kind: 'other' };
    case 'conversation.item.input_audio_transcription.completed':
      return typeof ev.transcript === 'string' ? { kind: 'user-transcript', text: ev.transcript } : { kind: 'other' };
    case 'input_audio_buffer.committed':
      return { kind: 'committed' };
    case 'response.done':
      return { kind: 'response-done' };
    case 'error': {
      const err = ev.error as { message?: string } | undefined;
      return { kind: 'error', message: err?.message ?? 'realtime error' };
    }
    default:
      return { kind: 'other' };
  }
}

// ---------------------------------------------------------------------------
// Voice session
// ---------------------------------------------------------------------------

interface BeatTurn {
  /** What the persona actually said per the session's own transcription (the
   *  prod-fidelity text for /logs/batch); falls back to the TTS input. */
  userText: string;
  assistantText: string;
}

export class VoiceSession {
  private ws!: WebSocket;
  private signals: RealtimeSignal[] = [];
  /** Read position into `signals` — persists ACROSS beats so a beat never
   *  re-consumes the previous beat's buffered events (a reset-to-zero cursor
   *  made every beat replay beat 1's response; caught in the first live run). */
  private cursor = 0;
  private waiters: Array<() => void> = [];
  private closed = false;
  /** Mixed conversation audio pending upload (persona TTS + assistant PCM, in
   *  wall-clock arrival order — turns don't overlap in a VAD conversation). */
  private pendingPcm: Buffer[] = [];

  private constructor(
    readonly sessionId: string,
    private readonly agent: Agent,
    private readonly openai: OpenAI,
    private readonly cost: CostTracker,
  ) {}

  /** Mint the ephemeral secret through the real /token route (prod instructions,
   *  tools, semantic VAD, voice) and open the Realtime WebSocket with it. */
  static async start(agent: Agent, openai: OpenAI, cost: CostTracker): Promise<VoiceSession> {
    const tokenRes = await agent.post('/token').send({});
    if (tokenRes.status !== 200 || typeof tokenRes.body?.value !== 'string' || !tokenRes.body?.session?.id) {
      throw new Error(`/token failed: ${tokenRes.status} ${JSON.stringify(tokenRes.body).slice(0, 300)}`);
    }
    const ephemeralKey = tokenRes.body.value as string;
    const sessionId = tokenRes.body.session.id as string;
    const model = (tokenRes.body.session.model as string | undefined) ?? 'gpt-realtime-2.1-mini';

    const vs = new VoiceSession(sessionId, agent, openai, cost);
    vs.ws = new WebSocket(`wss://api.openai.com/v1/realtime?model=${encodeURIComponent(model)}`, {
      headers: { Authorization: `Bearer ${ephemeralKey}` },
    });
    vs.ws.on('message', raw => {
      try {
        const ev = JSON.parse(raw.toString()) as Record<string, unknown>;
        // REDTEAM_VOICE_DEBUG=1 → log raw event types (and error payloads) to
        // diagnose protocol drift without dumping audio deltas.
        if (process.env.REDTEAM_VOICE_DEBUG) {
          console.log(`[voice:event] ${String(ev.type)}${ev.type === 'error' ? ' ' + JSON.stringify(ev.error) : ''}`);
        }
        vs.push(parseRealtimeEvent(ev));
      } catch {
        /* non-JSON frame */
      }
    });
    vs.ws.on('close', () => { vs.closed = true; vs.wake(); });
    vs.ws.on('error', err => { vs.push({ kind: 'error', message: err.message }); });

    await new Promise<void>((resolve, reject) => {
      vs.ws.once('open', resolve);
      vs.ws.once('error', reject);
      setTimeout(() => reject(new Error('realtime WS connect timeout')), 15_000);
    });

    // Harness-driven turns (see header): disable server VAD for this
    // connection; every other session parameter from the minted secret stays.
    vs.ws.send(JSON.stringify({
      type: 'session.update',
      session: { type: 'realtime', audio: { input: { turn_detection: null } } },
    }));
    return vs;
  }

  private push(s: RealtimeSignal): void {
    if (s.kind === 'other') return;
    this.signals.push(s);
    this.wake();
  }

  private wake(): void {
    const ws = this.waiters;
    this.waiters = [];
    for (const w of ws) w();
  }

  /** Wait for the next signal, yielding -1 every ~250ms so the caller can
   *  re-check timeouts even when the server goes quiet. */
  private async nextSignalIndex(from: number, deadline: number): Promise<number> {
    const softDeadline = Date.now() + 250;
    while (this.signals.length <= from) {
      if (this.closed) throw new Error('realtime WS closed mid-beat');
      if (Date.now() > deadline) throw new Error('beat timeout waiting for realtime events');
      if (Date.now() > softDeadline) return -1;
      await new Promise<void>(res => {
        this.waiters.push(res);
        setTimeout(res, 100);
      });
    }
    return from;
  }

  /** TTS the persona text, stream it into the input buffer, wait for the
   *  assistant's full reply. Audio in both directions is teed for upload. */
  async speakBeat(text: string): Promise<BeatTurn> {
    const deadline = Date.now() + BEAT_TIMEOUT_MS;

    // Persona speech: TTS → 24kHz pcm16 mono, padded with trailing silence so
    // semantic VAD can find the end of the utterance.
    const speech = await this.openai.audio.speech.create({
      model: TTS_MODEL,
      voice: TTS_VOICE,
      input: text,
      response_format: 'pcm',
    });
    const personaPcm = Buffer.concat([Buffer.from(await speech.arrayBuffer()), silencePcm(400)]);
    this.cost.estimate(TTS_MODEL, Math.ceil(text.length / 4), 0);
    this.pendingPcm.push(personaPcm);

    for (const b64 of chunkBase64Pcm(personaPcm)) {
      this.ws.send(JSON.stringify({ type: 'input_audio_buffer.append', audio: b64 }));
    }
    // Harness-driven turn (VAD disabled at connect): commit and ask for the reply.
    this.ws.send(JSON.stringify({ type: 'input_audio_buffer.commit' }));
    this.ws.send(JSON.stringify({ type: 'response.create' }));

    // Consume signals until the response completes.
    let userText = '';
    let assistantText = '';
    const assistantAudio: Buffer[] = [];

    for (;;) {
      const i = await this.nextSignalIndex(this.cursor, deadline);
      if (i === -1) continue; // soft tick
      const s = this.signals[i];
      this.cursor = i + 1;
      switch (s.kind) {
        case 'committed': break;
        case 'user-transcript': userText = s.text; break;
        case 'assistant-audio': assistantAudio.push(Buffer.from(s.b64, 'base64')); break;
        case 'assistant-text': assistantText = s.text; break;
        case 'error': throw new Error(`realtime error: ${s.message}`);
        case 'response-done': {
          if (assistantAudio.length > 0) this.pendingPcm.push(Buffer.concat(assistantAudio));
          await this.uploadPendingAudio();
          return { userText: userText || text, assistantText };
        }
      }
    }
  }

  /** Ship accumulated conversation PCM through the ordinary recording route.
   *  Best-effort like the browser uploader; a disabled recording flag means the
   *  server 204-drops (the runner warns about that up front). Batches are kept
   *  well under the route's 8mb JSON limit — a whole beat's audio in one POST
   *  413s (caught live). */
  private async uploadPendingAudio(): Promise<void> {
    if (this.pendingPcm.length === 0) return;
    const chunks = this.pendingPcm.flatMap(p => chunkBase64Pcm(p));
    this.pendingPcm = [];

    const MAX_BATCH_B64_BYTES = 2_000_000; // well under the audio route's 8mb parser
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
        // 204 = recorded; anything else means the server dropped the audio
        // (recording disabled, ownership, finalized) — say so instead of
        // leaving a silent recording-less run.
        if (res.status !== 204) {
          console.warn(`[redteam:voice] audio upload for ${this.sessionId} → ${res.status} (audio not recorded)`);
        }
      } catch (err) {
        console.warn(`[redteam:voice] audio upload failed: ${(err as Error).message}`);
      }
    }
  }

  /** End through the normal participant path: closes the WS and triggers
   *  recorder finalize (WAV → object storage), redaction, insights. */
  async end(): Promise<void> {
    await this.uploadPendingAudio();
    try { this.ws.close(); } catch { /* already closed */ }
    await this.agent.post(`/api/sessions/${this.sessionId}/end`).send({});
  }
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

  const vs = await VoiceSession.start(agent, openai, cost);
  const sessionId = vs.sessionId;
  const transcript: Turn[] = [];
  const assertions: AssertionResult[] = [];
  const beatPostTimes: Record<string, Date> = {};

  try {
    for (const beat of beats) {
      const utter = beat.verbatim ?? (await generatePersonaTurn(openai, cost, cfg, scenario, beat, transcript));
      const turn = await vs.speakBeat(utter);

      // Post both sides through /logs/batch like the browser (this is what
      // drives crisis detection and what the judge reads).
      beatPostTimes[beat.id] = new Date();
      await client.postParticipantTurn(agent, sessionId, turn.userText);
      if (turn.assistantText) await client.postAssistantTurn(agent, sessionId, turn.assistantText);
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
    }
  } finally {
    await vs.end();
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
      judgeBreaches = outcome.breaches.length > 0;
    }
  }
  return { assertions, judge, judgeBreaches, sessionId };
}
