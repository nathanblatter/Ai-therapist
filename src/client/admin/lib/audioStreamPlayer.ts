// Gapless playback of streamed PCM16 audio chunks (from the participant's teed
// assistant audio). Schedules each chunk back-to-back on a Web Audio timeline.

type WebkitWindow = Window & { webkitAudioContext?: typeof AudioContext };

export class AudioStreamPlayer {
  private ctx: AudioContext | null = null;
  private nextTime = 0;

  /** Create/resume the AudioContext. Must be called from a user gesture. */
  start(): void {
    if (!this.ctx) {
      const AudioCtx = window.AudioContext || (window as WebkitWindow).webkitAudioContext!;
      this.ctx = new AudioCtx();
    }
    void this.ctx.resume();
    this.nextTime = this.ctx.currentTime;
  }

  /** Decode and schedule one base64 PCM16 chunk for playback. */
  push(base64Pcm16: string, sampleRate: number): void {
    if (!this.ctx) return;
    const float = base64ToFloat32(base64Pcm16);
    if (float.length === 0) return;

    const buffer = this.ctx.createBuffer(1, float.length, sampleRate);
    buffer.getChannelData(0).set(float);

    const src = this.ctx.createBufferSource();
    src.buffer = buffer;
    src.connect(this.ctx.destination);

    const now = this.ctx.currentTime;
    // If playback fell behind (network gap), resync with a small lead buffer.
    if (this.nextTime < now) this.nextTime = now + 0.05;
    src.start(this.nextTime);
    this.nextTime += buffer.duration;
  }

  stop(): void {
    if (this.ctx) {
      void this.ctx.close();
      this.ctx = null;
    }
    this.nextTime = 0;
  }
}

function base64ToFloat32(b64: string): Float32Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  const pcm = new Int16Array(bytes.buffer);
  const float = new Float32Array(pcm.length);
  for (let i = 0; i < pcm.length; i++) float[i] = pcm[i] / 0x8000;
  return float;
}
