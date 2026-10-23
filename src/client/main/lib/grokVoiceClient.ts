// Browser side of the Grok Voice proxy (docs/grok-voice.md, protocol in
// shared/grokVoiceProtocol.ts).
//
// One WebSocket to OUR server carries microphone PCM16 up and assistant PCM16
// down as binary frames, with JSON control messages in between. There is no
// WebRTC here and no credential: the server dials xAI. Audio is handled with
// the Web Audio API at the wire sample rate so no resampling code is needed —
// an AudioContext constructed at 24 kHz resamples the microphone for us, and
// plays 24 kHz buffers natively.
//
// Capture runs in an AudioWorklet (built from an inline module so the build
// needs no extra file; CSP allows blob: workers). Playback schedules each
// incoming chunk back-to-back on the context clock, which gives gapless audio
// with a small jitter margin, and can be flushed instantly when the server
// reports the participant started speaking (barge-in) or cancelled a reply.
//
// The assistant audio is also routed into a MediaStream so the existing
// VoiceOrb visualiser and the session-recording tee (audioTee.ts) work exactly
// as they do for the WebRTC remote track.
//
// Reconnection (docs/grok-voice.md section 3): a dropped socket is re-opened
// with backoff for up to RECONNECT_WINDOW_MS. The server keeps the xAI session
// alive for its own (admin-configured) window and re-attaches the new socket
// to it, so the conversation continues where it was; the audio graph is never
// torn down in between. The server refuses with a 44xx close code when the
// session is unknown, already attached or ended, and those are final. The
// server also reports its own link to xAI (`link` messages), which the UI
// shows the same way.

import { GROK_SAMPLE_RATE, type GrokClientMessage, type GrokServerMessage } from '../../../shared/grokVoiceProtocol';

export interface GrokVoiceHandlers {
  onMessage: (msg: GrokServerMessage) => void;
  /**
   * Transport is gone for good: the server said `closed`, refused a
   * reconnect, or the reconnect window ran out. `clean` when the server said
   * `closed` first. Never called for a drop that was recovered.
   */
  onClose: (info: { code: number; reason: string; clean: boolean }) => void;
  onError: (message: string) => void;
  /**
   * Link state for the UI: `reconnecting` when this socket dropped and is
   * being re-opened, or the server reports its xAI link down; `restored` once
   * audio can flow again.
   */
  onLink?: (state: 'reconnecting' | 'restored') => void;
}

/** How long a dropped socket is retried before the session is given up. Just
 *  under the server's default window (reconnect_window_s = 75) so a refusal
 *  comes from us, with a clear reason, rather than from a race with its timer. */
export const RECONNECT_WINDOW_MS = 70_000;
/** Backoff before retry n (index 0 = before the first retry); the last value repeats. */
const RECONNECT_BACKOFF_MS = [500, 1_000, 2_000, 4_000, 8_000];
/** Each retry must reach `ready` within this. */
const RECONNECT_READY_TIMEOUT_MS = 10_000;

/** Close codes the server uses for refused attaches (grokVoiceManager.service.ts). */
function isFinalCloseCode(code: number): boolean {
  return code >= 4400 && code < 4500;
}

/** ~100 ms of PCM16 at the wire rate per frame: few enough frames, low latency. */
const CAPTURE_FRAME_SAMPLES = Math.round(GROK_SAMPLE_RATE / 10);

// The worklet accumulates 128-sample render quanta into wire frames and posts
// Int16 buffers. Kept as a string so it ships inside the main bundle.
const CAPTURE_WORKLET_SOURCE = `
class GrokCaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.frame = new Int16Array(${CAPTURE_FRAME_SAMPLES});
    this.filled = 0;
  }
  process(inputs) {
    const input = inputs[0];
    if (!input || !input[0]) return true;
    const channel = input[0];
    for (let i = 0; i < channel.length; i++) {
      const s = Math.max(-1, Math.min(1, channel[i]));
      this.frame[this.filled++] = s < 0 ? s * 0x8000 : s * 0x7fff;
      if (this.filled === this.frame.length) {
        this.port.postMessage(this.frame.buffer.slice(0));
        this.filled = 0;
      }
    }
    return true;
  }
}
registerProcessor('grok-capture', GrokCaptureProcessor);
`;

type WebkitWindow = Window & { webkitAudioContext?: typeof AudioContext };

export class GrokVoiceClient {
  private ws: WebSocket | null = null;
  private ctx: AudioContext | null = null;
  private micSource: MediaStreamAudioSourceNode | null = null;
  private captureNode: AudioWorkletNode | ScriptProcessorNode | null = null;
  private captureSink: GainNode | null = null;
  private playbackGain: GainNode | null = null;
  private playbackDestination: MediaStreamAudioDestinationNode | null = null;
  private scheduled: AudioBufferSourceNode[] = [];
  private nextPlayAt = 0;
  private ready = false;
  private closedByServer = false;
  private stopped = false;
  private audioStarted = false;
  private reconnecting = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly wsPath: string,
    private readonly mic: MediaStream,
    private readonly handlers: GrokVoiceHandlers,
  ) {}

  /** Assistant audio as a MediaStream (for the orb and the recording tee). */
  get remoteStream(): MediaStream | null {
    return this.playbackDestination?.stream ?? null;
  }

  /** Open the socket and start the audio graph. Resolves on the `ready` message. */
  async connect(timeoutMs = 20_000): Promise<void> {
    if (this.stopped) throw new Error('client already stopped');
    await this.openSocket(timeoutMs);
  }

  /**
   * One socket attempt: open, (first time) start audio, wait for `ready`.
   * Rejects on timeout, error, or a close before ready; the caller decides
   * whether that is fatal (first connect) or one failed retry.
   */
  private openSocket(timeoutMs: number): Promise<void> {
    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${proto}//${window.location.host}${this.wsPath}`);
    ws.binaryType = 'arraybuffer';
    this.ws = ws;

    return new Promise<void>((resolve, reject) => {
      let settled = false;
      // Set when this attempt gives up on its own (ready timeout): the close
      // that follows is ours, not a drop to recover from.
      let abandoned = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        abandoned = true;
        try {
          ws.close(1000, 'ready timeout');
        } catch {
          /* ignore */
        }
        reject(new Error('Voice service did not become ready in time'));
      }, timeoutMs);

      ws.onopen = () => {
        if (this.audioStarted) return;
        this.audioStarted = true;
        this.startAudio().catch((err) => {
          this.audioStarted = false;
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          reject(err instanceof Error ? err : new Error(String(err)));
        });
      };
      ws.onmessage = (e: MessageEvent) => {
        if (e.data instanceof ArrayBuffer) {
          this.enqueuePlayback(e.data);
          return;
        }
        let msg: GrokServerMessage;
        try {
          msg = JSON.parse(String(e.data)) as GrokServerMessage;
        } catch {
          return;
        }
        if (msg.type === 'ready') {
          this.ready = true;
          if (!settled) {
            settled = true;
            clearTimeout(timer);
            resolve();
          }
        } else if (msg.type === 'speech_started' || msg.type === 'clear_audio') {
          this.flushPlayback();
        } else if (msg.type === 'closed') {
          this.closedByServer = true;
        } else if (msg.type === 'link') {
          // The server's own link to xAI. Nothing we say reaches the model
          // while it is down; drop whatever was queued to play so the
          // restored conversation does not start with stale audio.
          if (msg.state === 'reconnecting') this.flushPlayback();
          this.handlers.onLink?.(msg.state);
        } else if (msg.type === 'error' && !settled) {
          settled = true;
          clearTimeout(timer);
          reject(new Error(msg.message));
        }
        this.handlers.onMessage(msg);
      };
      ws.onerror = () => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          reject(new Error('Voice connection failed'));
        } else if (!this.reconnecting) {
          this.handlers.onError('Voice connection error');
        }
      };
      ws.onclose = (e: CloseEvent) => {
        this.ready = false;
        if (this.ws === ws) this.ws = null;
        if (abandoned) return;
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          reject(new Error(`Voice connection closed before ready (${e.code})`));
          return;
        }
        this.handleDrop(e.code, e.reason);
      };
    });
  }

  /** A socket that had reached `ready` closed. Recover it, or report the end. */
  private handleDrop(code: number, reason: string): void {
    if (this.stopped) return;
    if (this.closedByServer || isFinalCloseCode(code)) {
      this.handlers.onClose({ code, reason, clean: this.closedByServer });
      return;
    }
    if (this.reconnecting) return; // a retry attempt closing is handled by its own promise
    this.reconnecting = true;
    this.flushPlayback();
    this.handlers.onLink?.('reconnecting');
    void this.reconnectLoop(code, reason);
  }

  private async reconnectLoop(code: number, reason: string): Promise<void> {
    const deadline = Date.now() + RECONNECT_WINDOW_MS;
    for (let attempt = 0; ; attempt++) {
      const backoff = RECONNECT_BACKOFF_MS[Math.min(attempt, RECONNECT_BACKOFF_MS.length - 1)];
      await new Promise<void>((res) => {
        this.reconnectTimer = setTimeout(res, backoff);
      });
      this.reconnectTimer = null;
      if (this.stopped) return;
      if (Date.now() > deadline) break;
      try {
        await this.openSocket(Math.min(RECONNECT_READY_TIMEOUT_MS, Math.max(1_000, deadline - Date.now())));
        this.reconnecting = false;
        this.handlers.onLink?.('restored');
        return;
      } catch (err) {
        if (this.stopped) return;
        const m = /closed before ready \((\d+)\)/.exec(err instanceof Error ? err.message : '');
        const closeCode = m ? Number(m[1]) : 0;
        if (isFinalCloseCode(closeCode)) {
          // The server refused: unknown, already attached, or ended (the
          // window ran out server-side). Final.
          this.reconnecting = false;
          this.handlers.onClose({ code: closeCode, reason: 'refused', clean: false });
          return;
        }
      }
    }
    this.reconnecting = false;
    this.handlers.onClose({ code, reason: reason || 'reconnect window elapsed', clean: false });
  }

  private async startAudio(): Promise<void> {
    const AudioCtx = window.AudioContext || (window as WebkitWindow).webkitAudioContext!;
    const ctx = new AudioCtx({ sampleRate: GROK_SAMPLE_RATE });
    this.ctx = ctx;
    if (ctx.state === 'suspended') await ctx.resume();

    // Playback chain: sources → gain → (speakers + MediaStream for orb/tee).
    this.playbackGain = ctx.createGain();
    this.playbackDestination = ctx.createMediaStreamDestination();
    this.playbackGain.connect(ctx.destination);
    this.playbackGain.connect(this.playbackDestination);
    this.nextPlayAt = 0;

    // Capture chain: mic → worklet → muted sink (a node with no output path is
    // not processed by every engine, so it terminates into a silent gain).
    this.micSource = ctx.createMediaStreamSource(this.mic);
    this.captureSink = ctx.createGain();
    this.captureSink.gain.value = 0;
    this.captureSink.connect(ctx.destination);

    if (ctx.audioWorklet) {
      const url = URL.createObjectURL(new Blob([CAPTURE_WORKLET_SOURCE], { type: 'application/javascript' }));
      try {
        await ctx.audioWorklet.addModule(url);
      } finally {
        URL.revokeObjectURL(url);
      }
      const node = new AudioWorkletNode(ctx, 'grok-capture', {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        channelCount: 1,
      });
      node.port.onmessage = (e: MessageEvent<ArrayBuffer>) => this.sendPcm(e.data);
      this.micSource.connect(node);
      node.connect(this.captureSink);
      this.captureNode = node;
    } else {
      // Older engines: ScriptProcessor (deprecated but universal), same as
      // audioTee.ts uses for the recording tap.
      const node = ctx.createScriptProcessor(2048, 1, 1);
      node.onaudioprocess = (e: AudioProcessingEvent) => {
        const input = e.inputBuffer.getChannelData(0);
        const pcm = new Int16Array(input.length);
        for (let i = 0; i < input.length; i++) {
          const s = Math.max(-1, Math.min(1, input[i]));
          pcm[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
        }
        this.sendPcm(pcm.buffer);
      };
      this.micSource.connect(node);
      node.connect(this.captureSink);
      this.captureNode = node;
    }
  }

  private sendPcm(buf: ArrayBuffer): void {
    // A disabled track yields silence, which would still cost bandwidth and
    // give the server VAD something to chew on; skip it entirely.
    const track = this.mic.getAudioTracks()[0];
    if (!track || !track.enabled) return;
    if (!this.ready || !this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    // Backpressure: never let a slow link queue seconds of stale audio.
    if (this.ws.bufferedAmount > 200_000) return;
    this.ws.send(buf);
  }

  private enqueuePlayback(data: ArrayBuffer): void {
    const ctx = this.ctx;
    const gain = this.playbackGain;
    if (!ctx || !gain || data.byteLength < 2) return;
    const samples = data.byteLength >> 1;
    const view = new DataView(data);
    const buffer = ctx.createBuffer(1, samples, GROK_SAMPLE_RATE);
    const channel = buffer.getChannelData(0);
    for (let i = 0; i < samples; i++) channel[i] = view.getInt16(i * 2, true) / 0x8000;

    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(gain);
    // Schedule back-to-back; if we fell behind, restart with a short lead so
    // the first chunk after a pause is not clipped by the clock.
    const now = ctx.currentTime;
    if (this.nextPlayAt < now + 0.02) this.nextPlayAt = now + 0.06;
    source.start(this.nextPlayAt);
    this.nextPlayAt += buffer.duration;
    this.scheduled.push(source);
    source.onended = () => {
      const i = this.scheduled.indexOf(source);
      if (i >= 0) this.scheduled.splice(i, 1);
    };
  }

  /** Drop everything queued for playback (barge-in, interrupt). */
  flushPlayback(): void {
    for (const s of this.scheduled) {
      try {
        s.stop();
      } catch {
        /* already ended */
      }
    }
    this.scheduled = [];
    this.nextPlayAt = 0;
  }

  /** Force the microphone off (time-limit wrap-up). */
  muteMic(): void {
    for (const t of this.mic.getAudioTracks()) t.enabled = false;
    this.sendControl({ type: 'mic', on: false });
  }

  private sendControl(msg: GrokClientMessage): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      try {
        this.ws.send(JSON.stringify(msg));
      } catch {
        /* closing */
      }
    }
  }

  /** Participant ended the session: tell the server, then let it close us. */
  end(): void {
    this.sendControl({ type: 'end' });
  }

  /** Tear down audio and the socket. Safe to call more than once. */
  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.ready = false;
    this.reconnecting = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.flushPlayback();
    try {
      this.captureNode?.disconnect();
    } catch {
      /* ignore */
    }
    if (this.captureNode && 'port' in this.captureNode) {
      (this.captureNode as AudioWorkletNode).port.onmessage = null;
    } else if (this.captureNode) {
      (this.captureNode as ScriptProcessorNode).onaudioprocess = null;
    }
    try {
      this.micSource?.disconnect();
    } catch {
      /* ignore */
    }
    try {
      this.captureSink?.disconnect();
    } catch {
      /* ignore */
    }
    try {
      this.playbackGain?.disconnect();
    } catch {
      /* ignore */
    }
    this.captureNode = null;
    this.micSource = null;
    this.captureSink = null;
    this.playbackGain = null;
    this.playbackDestination = null;
    if (this.ctx) {
      void this.ctx.close().catch(() => {});
      this.ctx = null;
    }
    if (this.ws) {
      const ws = this.ws;
      this.ws = null;
      try {
        if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) ws.close(1000, 'client stop');
      } catch {
        /* ignore */
      }
    }
  }
}
