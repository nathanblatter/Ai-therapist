// WALK acoustic conditions for synthesized caller audio.
//
// OpenAI's "GPT-Live evaluation guide" (WALK mode) replays the same
// single-turn tasks from saved recordings and varies the acoustic conditions:
// clean, noisy, telephony, background speech, echo, packet loss. Approved
// HUMAN recordings are the guide's default and strongly preferred; synthetic
// recordings with acoustic effects are its fallback when none are available.
// This project has no approved participant-style recordings (see
// docs/redteam.md "WALK"), so this module is that fallback: deterministic
// effects applied to our TTS persona audio before it is streamed. The preset
// parameters follow the reference harness's presets (read, not vendored:
// white noise at an absolute RMS, a 300-3400 Hz band with 8 kHz
// sample-and-hold and a G.711 mu-law round trip, 20 ms frame drops in short
// bursts, a 120 ms echo); the implementation is ours.
//
// All effects are pure functions of (pcm, seed) over PCM16 mono at 24 kHz.

export type AcousticCondition = 'clean' | 'noisy' | 'telephony' | 'packet_loss' | 'echo' | 'background_speech';

export const ACOUSTIC_CONDITIONS: AcousticCondition[] = [
  'clean',
  'noisy',
  'telephony',
  'packet_loss',
  'echo',
  'background_speech',
];

const SAMPLE_RATE = 24_000;
const FRAME_SAMPLES = (SAMPLE_RATE * 20) / 1000;

/** mulberry32: small, seedable, deterministic. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function toFloat(pcm: Buffer): Float64Array {
  const n = Math.floor(pcm.length / 2);
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) out[i] = pcm.readInt16LE(i * 2);
  return out;
}

function toPcm(x: Float64Array): Buffer {
  const out = Buffer.alloc(x.length * 2);
  for (let i = 0; i < x.length; i++) out.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(x[i]))), i * 2);
  return out;
}

/** Uniform white noise at an absolute RMS (PCM16 units), added everywhere,
 *  silences included, like a room the participant sits in. */
export function addNoise(pcm: Buffer, rms: number, seed: number): Buffer {
  const x = toFloat(pcm);
  const r = rng(seed);
  // Uniform on [-a, a] has RMS a / sqrt(3).
  const a = rms * Math.sqrt(3);
  for (let i = 0; i < x.length; i++) x[i] += (r() * 2 - 1) * a;
  return toPcm(x);
}

function onePoleLowPass(x: Float64Array, cutoffHz: number): Float64Array {
  const dt = 1 / SAMPLE_RATE;
  const rc = 1 / (2 * Math.PI * cutoffHz);
  const alpha = dt / (rc + dt);
  const y = new Float64Array(x.length);
  let prev = 0;
  for (let i = 0; i < x.length; i++) {
    prev = prev + alpha * (x[i] - prev);
    y[i] = prev;
  }
  return y;
}

function onePoleHighPass(x: Float64Array, cutoffHz: number): Float64Array {
  const dt = 1 / SAMPLE_RATE;
  const rc = 1 / (2 * Math.PI * cutoffHz);
  const alpha = rc / (rc + dt);
  const y = new Float64Array(x.length);
  let prevY = 0;
  let prevX = 0;
  for (let i = 0; i < x.length; i++) {
    prevY = alpha * (prevY + x[i] - prevX);
    prevX = x[i];
    y[i] = prevY;
  }
  return y;
}

function muLaw(v: number): number {
  const MU = 255;
  const s = Math.max(-1, Math.min(1, v / 32768));
  const enc = (Math.sign(s) * Math.log1p(MU * Math.abs(s))) / Math.log1p(MU);
  // 8-bit quantisation of the companded value, then expand.
  const q = Math.round(enc * 127) / 127;
  return Math.sign(q) * ((Math.pow(1 + MU, Math.abs(q)) - 1) / MU) * 32768;
}

/** Narrowband telephone channel: 300-3400 Hz, 8 kHz sample-and-hold, G.711
 *  mu-law round trip, make-up gain. */
export function telephony(pcm: Buffer): Buffer {
  let x = toFloat(pcm);
  x = onePoleHighPass(onePoleHighPass(x, 300), 300);
  x = onePoleLowPass(onePoleLowPass(x, 3400), 3400);
  const hold = SAMPLE_RATE / 8000;
  for (let i = 0; i < x.length; i++) {
    if (i % hold === 0) x[i] = muLaw(x[i] * 1.8);
    else x[i] = x[i - (i % hold)];
  }
  return toPcm(x);
}

/** Zero whole 20 ms frames: each frame starts a burst with probability
 *  `rate`; bursts are `burst` frames long. */
export function packetLoss(pcm: Buffer, rate: number, burst: number, seed: number): Buffer {
  const out = Buffer.from(pcm);
  const r = rng(seed ^ 0xa0d10);
  const frames = Math.floor(pcm.length / 2 / FRAME_SAMPLES);
  let left = 0;
  for (let f = 0; f < frames; f++) {
    if (left === 0 && r() < rate) left = burst;
    if (left > 0) {
      out.fill(0, f * FRAME_SAMPLES * 2, (f + 1) * FRAME_SAMPLES * 2);
      left -= 1;
    }
  }
  return out;
}

/** The caller's own signal fed back after `delayMs`, scaled by `decay`. */
export function echo(pcm: Buffer, delayMs: number, decay: number): Buffer {
  const x = toFloat(pcm);
  const d = Math.round((SAMPLE_RATE * delayMs) / 1000);
  const y = new Float64Array(x.length);
  for (let i = 0; i < x.length; i++) y[i] = x[i] + (i >= d ? x[i - d] * decay : 0);
  return toPcm(y);
}

/** A second, quieter talker under the caller. No bundled recording: two
 *  slowly modulated harmonic tones in the speech band stand in for babble
 *  (the reference harness falls back to the same idea). Deliberately carries
 *  no words, so nothing it "says" could be attributed to the participant. */
export function backgroundSpeech(pcm: Buffer, level: number, seed: number): Buffer {
  const x = toFloat(pcm);
  const r = rng(seed);
  const f1 = 160 + r() * 40;
  const f2 = 280 + r() * 60;
  for (let i = 0; i < x.length; i++) {
    const t = i / SAMPLE_RATE;
    const env = 0.5 + 0.5 * Math.sin(2 * Math.PI * 3.1 * t) * Math.sin(2 * Math.PI * 0.7 * t);
    const v =
      Math.sin(2 * Math.PI * f1 * t) + 0.6 * Math.sin(2 * Math.PI * f2 * t) + 0.3 * Math.sin(4 * Math.PI * f2 * t);
    x[i] += level * env * v;
  }
  return toPcm(x);
}

/** Apply one named condition (seeded so a rerun hears the same audio). */
export function applyCondition(pcm: Buffer, condition: AcousticCondition, seed = 7): Buffer {
  switch (condition) {
    case 'clean':
      return pcm;
    case 'noisy':
      return addNoise(pcm, 1200, seed);
    case 'telephony':
      return telephony(pcm);
    case 'packet_loss':
      return packetLoss(pcm, 0.08, 2, seed);
    case 'echo':
      return echo(pcm, 120, 0.35);
    case 'background_speech':
      return backgroundSpeech(pcm, 1800, seed);
  }
}
