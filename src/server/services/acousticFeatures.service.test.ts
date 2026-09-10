// Unit coverage for the acoustic-feature DSP core: WAV parsing and the
// derived measures on synthetic signals with known ground truth.
import { describe, it, expect } from 'vitest';
import { computeAcousticFeatures, parseWav } from './acousticFeatures.service.js';

const SR = 16_000;

/** Synthetic mono signal: seconds of a sine at hz, or silence when hz=0. */
function tone(seconds: number, hz: number, amplitude = 0.5): Int16Array {
  const out = new Int16Array(Math.round(seconds * SR));
  if (hz === 0) return out;
  for (let i = 0; i < out.length; i++) {
    out[i] = Math.round(Math.sin((2 * Math.PI * hz * i) / SR) * amplitude * 32767);
  }
  return out;
}

function concat(...parts: Int16Array[]): Int16Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Int16Array(total);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

/** Standard 44-byte mono PCM16 WAV wrapper (mirrors recorder.service buildWav). */
function buildWav(samples: Int16Array, sampleRate: number): Buffer {
  const dataLen = samples.length * 2;
  const buf = Buffer.alloc(44 + dataLen);
  buf.write('RIFF', 0, 'ascii');
  buf.writeUInt32LE(36 + dataLen, 4);
  buf.write('WAVE', 8, 'ascii');
  buf.write('fmt ', 12, 'ascii');
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(1, 22); // mono
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36, 'ascii');
  buf.writeUInt32LE(dataLen, 40);
  for (let i = 0; i < samples.length; i++) buf.writeInt16LE(samples[i], 44 + i * 2);
  return buf;
}

describe('computeAcousticFeatures', () => {
  it('recovers the fundamental of a pure tone', () => {
    const f = computeAcousticFeatures(tone(2, 150), SR);
    expect(f.f0_median_hz).not.toBeNull();
    expect(f.f0_median_hz!).toBeGreaterThan(140);
    expect(f.f0_median_hz!).toBeLessThan(160);
    expect(f.voiced_fraction).toBeGreaterThan(0.9);
    expect(f.silence_ratio).toBeLessThan(0.1);
    expect(f.duration_ms).toBe(2000);
  });

  it('detects a mid-signal pause and its rough duration', () => {
    const f = computeAcousticFeatures(concat(tone(1, 150), tone(0.6, 0), tone(1, 150)), SR);
    expect(f.pause_count).toBe(1);
    expect(f.pause_mean_ms).toBeGreaterThan(400);
    expect(f.pause_mean_ms).toBeLessThan(800);
    expect(f.silence_ratio).toBeGreaterThan(0.15);
    expect(f.silence_ratio).toBeLessThan(0.35);
  });

  it('does not count leading silence as a pause', () => {
    const f = computeAcousticFeatures(concat(tone(1, 0), tone(1, 150)), SR);
    expect(f.pause_count).toBe(0);
  });

  it('reports no pitch for pure silence', () => {
    const f = computeAcousticFeatures(tone(1, 0), SR);
    expect(f.f0_median_hz).toBeNull();
    expect(f.silence_ratio).toBe(1);
    expect(f.rms_mean).toBe(0);
  });

  it('handles an empty buffer without dividing by zero', () => {
    const f = computeAcousticFeatures(new Int16Array(0), SR);
    expect(f.frames).toBe(0);
    expect(f.duration_ms).toBe(0);
    expect(f.silence_ratio).toBe(1);
    expect(f.f0_median_hz).toBeNull();
  });
});

describe('parseWav', () => {
  it('round-trips samples through the recorder WAV format', () => {
    const samples = tone(0.5, 220);
    const parsed = parseWav(buildWav(samples, SR));
    expect(parsed.sampleRate).toBe(SR);
    expect(parsed.samples.length).toBe(samples.length);
    expect(Array.from(parsed.samples.slice(0, 20))).toEqual(Array.from(samples.slice(0, 20)));
  });

  it('parses and analyzes end-to-end', () => {
    const parsed = parseWav(buildWav(tone(1, 200), SR));
    const f = computeAcousticFeatures(parsed.samples, parsed.sampleRate);
    expect(f.f0_median_hz!).toBeGreaterThan(185);
    expect(f.f0_median_hz!).toBeLessThan(215);
  });

  it('rejects non-WAV buffers', () => {
    expect(() => parseWav(Buffer.from('definitely not audio data, just text padding here'))).toThrow();
  });

  it('rejects stereo files', () => {
    const buf = buildWav(tone(0.1, 100), SR);
    buf.writeUInt16LE(2, 22); // channels = 2
    expect(() => parseWav(buf)).toThrow(/unsupported/);
  });
});
