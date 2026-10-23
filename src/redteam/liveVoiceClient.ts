// GPT-Live transport for the red-team voice harness (ai-therapist-213/245).
//
// Production GPT-Live sessions are browser-owned WebRTC calls: the browser
// builds an SDP offer carrying an Opus audio track and the `oai-events` data
// channel, POSTs it to OUR `/api/live/session` (which runs every gate, creates
// the OpenAI session with the project key, attaches the server sideband, and
// returns the SDP answer), then speaks and listens over the peer connection.
// The server never sees the media; it sees transcripts through the sideband,
// and that is where crisis detection, persistence, tools and metering live.
//
// This module is a headless browser for that flow: werift provides the WebRTC
// stack (ICE/DTLS/SRTP/SCTP) in pure TypeScript and opusscript a WASM Opus
// codec, so no native build is needed. Persona speech is TTS PCM16 at 24 kHz,
// Opus-encoded in 20 ms frames and written as RTP at real-time pace; the
// assistant's Opus comes back as RTP, is decoded for the recording tee, and
// its transcript arrives on the data channel as `session.output_transcript.
// delta` fragments. GPT-Live is full duplex: there is no response-done event,
// so the end of the assistant's turn is read as a quiet gap in its transcript
// stream, mirroring how the server's TranscriptAssembler closes turns.
import type OpenAI from 'openai';
import { createRequire } from 'node:module';
import {
  RTCPeerConnection,
  RTCRtpCodecParameters,
  MediaStreamTrack,
  RtpPacket,
  RtpHeader,
  type RTCDataChannel,
} from 'werift';
import type { CostTracker } from './config.js';
import type { Agent, HarnessClient } from './harnessClient.js';
import {
  VOICE_SAMPLE_RATE,
  chunkBase64Pcm,
  silencePcm,
  pcmDurationMs,
  type BeatTurn,
  type VoiceTransport,
  type VoiceSessionOptions,
} from './voiceClient.js';

// opusscript is CommonJS with `export =`; load it the CJS way under ESM.
const require = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-var-requires
const OpusScript = require('opusscript') as typeof import('opusscript');

const TTS_MODEL = 'gpt-4o-mini-tts';
const TTS_VOICE = 'alloy';
const BEAT_TIMEOUT_MS = 90_000;
const STARTED_TIMEOUT_MS = 25_000;
/** Opus RTP clock is always 48 kHz: 20 ms = 960 ticks, whatever the input rate. */
const OPUS_RTP_CLOCK = 48_000;
const FRAME_MS = 20;
const RTP_TICKS_PER_FRAME = (OPUS_RTP_CLOCK * FRAME_MS) / 1000;
const PCM_SAMPLES_PER_FRAME = (VOICE_SAMPLE_RATE * FRAME_MS) / 1000;
const PCM_BYTES_PER_FRAME = PCM_SAMPLES_PER_FRAME * 2;
const OPUS_PAYLOAD_TYPE = 111;
const TRAILING_SILENCE_MS = 1_500;
/** No assistant transcript fragment for this long closes its turn (the
 *  server's assembler uses 900 ms; the harness waits longer so it never
 *  cuts a reply that the server would have kept whole). */
const ASSISTANT_TURN_GAP_MS = 2_500;
const QUIET_BEFORE_SPEAKING_MS = 1_500;
const QUIET_WAIT_CAP_MS = 20_000;

type LiveEvent = { type?: string; delta?: unknown; start_ms?: unknown; end_ms?: unknown; session?: unknown; error?: unknown; reason?: unknown };

export interface Fragment { text: string; startMs: number }

/** Assemble transcript fragments into one turn (unit-tested offline). */
export function joinFragments(frags: Fragment[]): string {
  // Sort by start_ms, concatenate exactly as received (fragments carry their
  // own whitespace) — the same rule the server's TranscriptAssembler applies.
  return [...frags].sort((a, b) => a.startMs - b.startMs).map(f => f.text).join('').trim();
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

export class LiveVoiceSession implements VoiceTransport {
  private pc!: RTCPeerConnection;
  private dc!: RTCDataChannel;
  private track!: MediaStreamTrack;
  private encoder = new OpusScript(VOICE_SAMPLE_RATE, 1, OpusScript.Application.VOIP);
  private decoder = new OpusScript(VOICE_SAMPLE_RATE, 1, OpusScript.Application.VOIP);
  private seq = Math.floor(Math.random() * 10_000);
  private ts = Math.floor(Math.random() * 100_000);
  private readonly ssrc = Math.floor(Math.random() * 0xffff_ffff) >>> 0;

  model = 'gpt-live-1';
  /** Beats spoken: the sideband scores at least one assembled turn per beat. */
  userTurns = 0;

  private started = false;
  private closed = false;
  private closeReason: string | null = null;
  private lastError: string | null = null;
  private userFrags: Fragment[] = [];
  private assistantFrags: Fragment[] = [];
  private lastAssistantDeltaAt = 0;
  private lastUserDeltaAt = 0;
  private pendingPcm: Buffer[] = [];
  private assistantPcm: Buffer[] = [];
  /** Microphone pump: PCM frames queued for the next ticks; silence when empty. */
  private micQueue: Buffer[] = [];
  private pumpTimer: NodeJS.Timeout | null = null;
  private lastFrameWasSilence = true;
  private readonly silenceFrame = Buffer.alloc(PCM_BYTES_PER_FRAME);

  /** Assigned once POST /api/live/session returns (the Live id IS our session id). */
  sessionId = '';

  private constructor(
    private readonly agent: Agent,
    private readonly openai: OpenAI,
    private readonly cost: CostTracker,
    private readonly opts: VoiceSessionOptions,
  ) {}

  static async start(
    _client: HarnessClient,
    agent: Agent,
    openai: OpenAI,
    cost: CostTracker,
    opts: VoiceSessionOptions,
    openingPrompt: string,
  ): Promise<{ session: LiveVoiceSession; opening: string }> {
    if (opts.textTurns) {
      throw new Error('--voice-text-turns is a Grok-proxy mode; GPT-Live has no typed-text route (the browser queues text on its own data channel)');
    }
    // Offer first, with the audio track and the data channel negotiated in it,
    // exactly as the browser does. werift gathers ICE inside setLocalDescription.
    const pc = new RTCPeerConnection({
      codecs: {
        audio: [new RTCRtpCodecParameters({ mimeType: 'audio/opus', clockRate: OPUS_RTP_CLOCK, channels: 2, payloadType: OPUS_PAYLOAD_TYPE })],
      },
    });
    const track = new MediaStreamTrack({ kind: 'audio' });
    pc.addTrack(track);
    const dc = pc.createDataChannel('oai-events');

    const vs = new LiveVoiceSession(agent, openai, cost, opts);
    vs.pc = pc;
    vs.dc = dc;
    vs.track = track;
    vs.wire();

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    const sdp = pc.localDescription?.sdp;
    if (!sdp) throw new Error('werift produced no local SDP');

    const res = await agent.post('/api/live/session').send({ sdp, language: 'en' });
    if (res.status !== 201 || typeof res.body?.session_id !== 'string' || typeof res.body?.sdp !== 'string') {
      await pc.close().catch(() => {});
      throw new Error(`POST /api/live/session failed: ${res.status} ${JSON.stringify(res.body).slice(0, 300)}`);
    }
    vs.sessionId = res.body.session_id as string;

    await pc.setRemoteDescription({ type: 'answer', sdp: res.body.sdp as string });
    // A browser microphone streams RTP from the moment the call connects,
    // silence included; GPT-Live expires a session that never receives media
    // (observed: `session.closed reason=expired` ~15 s after start with no
    // inbound RTP). Pump 20 ms frames continuously, speech when queued.
    vs.startPump();

    try {
      const startedBy = Date.now() + STARTED_TIMEOUT_MS;
      while (!vs.started) {
        if (vs.closed) throw new Error(`GPT-Live connection closed before session.started (${vs.closeReason ?? 'no reason'})`);
        if (vs.lastError) throw new Error(`GPT-Live error before session.started: ${vs.lastError}`);
        if (Date.now() > startedBy) throw new Error('timeout waiting for session.started on the data channel');
        await sleep(50);
      }
      // Opening preamble: GPT-Live never speaks unprompted, so the browser sends
      // a trusted instructions append telling the model to speak first.
      vs.sendAppend(openingPrompt);
      const opening = await vs.awaitAssistantTurn(Date.now() + BEAT_TIMEOUT_MS);
      return { session: vs, opening };
    } catch (err) {
      // The session row exists and is billing: end it, or the participant's
      // one-active-session gate blocks every later start.
      await vs.end().catch(() => {});
      throw err;
    }
  }

  private wire(): void {
    this.dc.onmessage = (e: { data: unknown }) => {
      const raw = e?.data;
      const text = typeof raw === 'string' ? raw : Buffer.isBuffer(raw) ? raw.toString() : '';
      if (!text) return;
      let ev: LiveEvent;
      try { ev = JSON.parse(text) as LiveEvent; } catch { return; }
      this.onEvent(ev);
    };
    this.dc.stateChanged.subscribe(state => {
      if (state === 'closed') {
        this.closed = true;
        this.closeReason = this.closeReason ?? 'data channel closed';
      }
    });
    this.pc.ontrack = e => {
      e.track.onReceiveRtp.subscribe(rtp => {
        try {
          const pcm = this.decoder.decode(rtp.payload);
          if (pcm && pcm.length > 0) this.assistantPcm.push(Buffer.from(pcm));
        } catch { /* DTX / comfort noise / undecodable frame */ }
      });
    };
    this.pc.connectionStateChange.subscribe(state => {
      if (process.env.REDTEAM_VOICE_DEBUG) console.log(`[voice:live] connection ${state}`);
      if ((state === 'failed' || state === 'closed') && !this.closed) {
        this.closed = true;
        this.closeReason = this.closeReason ?? `peer connection ${state}`;
      }
    });
  }

  private onEvent(ev: LiveEvent): void {
    const type = typeof ev.type === 'string' ? ev.type : '';
    if (process.env.REDTEAM_VOICE_DEBUG && type !== 'session.output_transcript.delta' && type !== 'session.input_transcript.delta') {
      console.log(`[voice:live] ${JSON.stringify(ev).slice(0, 200)}`);
    }
    switch (type) {
      case 'session.started':
        this.started = true;
        break;
      case 'session.input_transcript.delta':
        this.userFrags.push({ text: String(ev.delta ?? ''), startMs: Number(ev.start_ms ?? 0) });
        this.lastUserDeltaAt = Date.now();
        break;
      case 'session.output_transcript.delta':
        this.assistantFrags.push({ text: String(ev.delta ?? ''), startMs: Number(ev.start_ms ?? 0) });
        this.lastAssistantDeltaAt = Date.now();
        break;
      case 'session.closed':
        this.closed = true;
        this.closeReason = typeof ev.reason === 'string' ? ev.reason : 'session.closed';
        break;
      case 'error': {
        const err = ev.error as { message?: string } | undefined;
        this.lastError = err?.message ?? JSON.stringify(ev).slice(0, 200);
        console.warn(`[redteam:voice] GPT-Live error event: ${this.lastError}`);
        break;
      }
      default:
        break;
    }
  }

  private sendAppend(text: string): void {
    // Same shape as the browser's sendInvisiblePrompt; the API caps appends at
    // 500 tokens, enforced as 1600 chars client-side.
    this.dc.send(JSON.stringify({ type: 'session.instructions.append', delegation_id: null, content: text.slice(0, 1600) }));
  }

  /** Wait until the assistant has said something and then gone quiet. Returns
   *  the assembled assistant text since the last take. */
  /** Reason the backend ended the session mid-conversation, if it did. */
  terminatedBy: string | null = null;

  private async awaitAssistantTurn(deadline: number): Promise<string> {
    for (;;) {
      if (this.closed && this.closeReason === 'content') {
        // OpenAI's content filter ended the session (docs/gpt-live.md,
        // incident 2026-09-11). Report what was said; the runner records the
        // termination rather than treating it as a harness failure.
        this.terminatedBy = 'content';
        const text = joinFragments(this.assistantFrags);
        this.assistantFrags = [];
        return text;
      }
      if (this.closed) throw new Error(`GPT-Live session closed (${this.closeReason ?? 'no reason'}) while waiting for the assistant`);
      if (Date.now() > deadline) throw new Error('timeout waiting for the assistant turn (no output transcript)');
      const quietFor = Date.now() - Math.max(this.lastAssistantDeltaAt, this.lastUserDeltaAt);
      if (this.assistantFrags.length > 0 && quietFor > ASSISTANT_TURN_GAP_MS) {
        const text = joinFragments(this.assistantFrags);
        this.assistantFrags = [];
        if (this.assistantPcm.length > 0) {
          this.pendingPcm.push(Buffer.concat(this.assistantPcm));
          this.assistantPcm = [];
        }
        return text;
      }
      await sleep(100);
    }
  }

  private takeUserText(): string {
    const text = joinFragments(this.userFrags);
    this.userFrags = [];
    return text;
  }

  private async waitForQuiet(): Promise<void> {
    const cap = Date.now() + QUIET_WAIT_CAP_MS;
    while (Date.now() - this.lastAssistantDeltaAt < QUIET_BEFORE_SPEAKING_MS && Date.now() < cap) await sleep(100);
  }

  private startPump(): void {
    if (this.pumpTimer) return;
    let next = Date.now();
    const tick = () => {
      if (this.closed || !this.pumpTimer) return;
      const frame = this.micQueue.shift();
      if (frame) {
        this.writeOpusFrame(frame, this.lastFrameWasSilence);
        this.lastFrameWasSilence = false;
      } else {
        this.writeOpusFrame(this.silenceFrame, false);
        this.lastFrameWasSilence = true;
      }
      next += FRAME_MS;
      // Catch up rather than drift if the event loop stalled.
      this.pumpTimer = setTimeout(tick, Math.max(0, next - Date.now()));
    };
    this.pumpTimer = setTimeout(tick, 0);
  }

  private stopPump(): void {
    if (this.pumpTimer) { clearTimeout(this.pumpTimer); this.pumpTimer = null; }
  }

  private writeOpusFrame(pcmFrame: Buffer, marker: boolean): void {
    const payload = this.encoder.encode(pcmFrame, PCM_SAMPLES_PER_FRAME);
    const header = new RtpHeader({
      version: 2,
      marker,
      payloadType: OPUS_PAYLOAD_TYPE,
      sequenceNumber: this.seq,
      timestamp: this.ts,
      ssrc: this.ssrc,
    });
    this.seq = (this.seq + 1) & 0xffff;
    this.ts = (this.ts + RTP_TICKS_PER_FRAME) >>> 0;
    this.track.writeRtp(new RtpPacket(header, Buffer.from(payload)));
  }

  async speakBeat(text: string): Promise<BeatTurn> {
    const deadline = Date.now() + BEAT_TIMEOUT_MS;
    await this.waitForQuiet();
    // Anything the assistant said since the last beat's reply closed (steers,
    // continuations) belongs to the previous beat.
    const unsolicited: string[] = [];
    if (this.assistantFrags.length > 0) unsolicited.push(joinFragments(this.assistantFrags));
    this.assistantFrags = [];
    // Stray participant fragments from the previous utterance are dropped
    // from the harness view (the server already scored them).
    this.userFrags = [];

    const speech = await this.openai.audio.speech.create({
      model: TTS_MODEL, voice: TTS_VOICE, input: text, response_format: 'pcm',
    });
    const spoken = Buffer.from(await speech.arrayBuffer());
    this.cost.addTts(text.length, pcmDurationMs(spoken) / 1000);
    let pcm = Buffer.concat([spoken, silencePcm(TRAILING_SILENCE_MS)]);
    const pad = pcm.length % PCM_BYTES_PER_FRAME;
    if (pad) pcm = Buffer.concat([pcm, Buffer.alloc(PCM_BYTES_PER_FRAME - pad)]);
    this.pendingPcm.push(pcm);

    // Hand the utterance to the microphone pump and wait for it to play out
    // at real-time pace (the pump sends silence again once the queue drains).
    const frames = pcm.length / PCM_BYTES_PER_FRAME;
    for (let i = 0; i < frames; i++) this.micQueue.push(pcm.subarray(i * PCM_BYTES_PER_FRAME, (i + 1) * PCM_BYTES_PER_FRAME));
    const playoutBy = Date.now() + frames * FRAME_MS + 500;
    while (this.micQueue.length > 0 && Date.now() < playoutBy) {
      if (this.closed && this.closeReason === 'content') break;
      if (this.closed) throw new Error(`GPT-Live session closed (${this.closeReason ?? 'no reason'}) while streaming audio`);
      await sleep(FRAME_MS);
    }
    this.userTurns += 1;

    const assistantText = await this.awaitAssistantTurn(deadline);
    const userText = this.takeUserText();
    if (!userText) console.warn(`[redteam:voice] no input transcript arrived for "${text.slice(0, 60)}..." — using the TTS input text`);
    await this.uploadPendingAudio();
    return {
      userText: userText || text,
      assistantText,
      toolCalls: [],
      unsolicited,
      ...(this.terminatedBy ? { terminated: this.terminatedBy } : {}),
    };
  }

  private async uploadPendingAudio(): Promise<void> {
    if (this.pendingPcm.length === 0) return;
    const chunks = this.pendingPcm.flatMap(p => chunkBase64Pcm(p));
    this.pendingPcm = [];
    const MAX_BATCH_B64_BYTES = 2_000_000;
    const batches: string[][] = [];
    let cur: string[] = [];
    let curBytes = 0;
    for (const c of chunks) {
      if (curBytes + c.length > MAX_BATCH_B64_BYTES && cur.length > 0) { batches.push(cur); cur = []; curBytes = 0; }
      cur.push(c);
      curBytes += c.length;
    }
    if (cur.length > 0) batches.push(cur);
    for (const batch of batches) {
      try {
        const res = await this.agent.post(`/api/sessions/${this.sessionId}/audio`).send({ chunks: batch, sampleRate: VOICE_SAMPLE_RATE });
        if (res.status !== 204) console.warn(`[redteam:voice] audio upload for ${this.sessionId} → ${res.status} (audio not recorded)`);
      } catch (err) {
        console.warn(`[redteam:voice] audio upload failed: ${(err as Error).message}`);
      }
    }
  }

  /** End as the browser does: POST /end (the server sends session.close on
   *  the sideband and waits for session.closed), then drop the transport. */
  async end(): Promise<void> {
    await this.uploadPendingAudio();
    await this.agent.post(`/api/sessions/${this.sessionId}/end`).send({});
    const closeBy = Date.now() + 6_000;
    while (!this.closed && Date.now() < closeBy) await sleep(100);
    this.stopPump();
    try { this.dc.close(); } catch { /* ignore */ }
    await this.pc.close().catch(() => {});
    try { this.encoder.delete(); this.decoder.delete(); } catch { /* ignore */ }
  }
}
