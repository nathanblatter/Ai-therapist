// Derived acoustic features from the participant-only recording track
// (Phase 2 telemetry, migration 095). Computes the vocal-indicator measures
// declared in the Phase 2 IRB application (pitch variability, speaking
// rate/pause structure, loudness/energy, spectral proxy) and stores ONLY the
// derived numbers — the audio itself never leaves object storage.
//
// IRB gate: no-ops unless system_config features.telemetry_acoustic_features
// is true (default false; Phase 2 approval required before enabling).
//
// Runs fire-and-forget from the session-end handler, chained after
// recorder.service.finalize so the participant WAV is already uploaded.
import { getObjectStream } from '../config/objectStorage.js';
import {
  getParticipantRecordingForSession,
  upsertSessionAcousticFeatures,
} from '../db/index.js';
import { getSystemConfig } from '../utils/sessionHelpers.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('acoustic');

const FRAME_MS = 30;
const HOP_MS = 15;
// Runs of silence at least this long count as pauses.
const MIN_PAUSE_MS = 300;
// Plausible speech F0 range; autocorrelation peaks outside it are discarded.
const F0_MIN_HZ = 60;
const F0_MAX_HZ = 400;

export interface AcousticFeatures {
  duration_ms: number;
  sample_rate: number;
  frames: number;
  rms_mean: number;
  rms_sd: number;
  silence_ratio: number;
  pause_count: number;
  pause_mean_ms: number;
  speech_segments_per_min: number;
  voiced_fraction: number;
  f0_median_hz: number | null;
  f0_iqr_hz: number | null;
  zcr_mean: number;
  zcr_sd: number;
}

function mean(xs: number[]): number {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
}

function sd(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((a, b) => a + (b - m) * (b - m), 0) / (xs.length - 1));
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor(p * (sorted.length - 1))));
  return sorted[idx];
}

/** Best autocorrelation-peak F0 for one frame, or null if unvoiced. */
function frameF0(frame: Float32Array, sampleRate: number): number | null {
  const minLag = Math.floor(sampleRate / F0_MAX_HZ);
  const maxLag = Math.min(frame.length - 1, Math.ceil(sampleRate / F0_MIN_HZ));
  if (maxLag <= minLag) return null;

  let energy = 0;
  for (let i = 0; i < frame.length; i++) energy += frame[i] * frame[i];
  if (energy === 0) return null;

  let bestLag = 0;
  let bestCorr = 0;
  for (let lag = minLag; lag <= maxLag; lag++) {
    let corr = 0;
    for (let i = 0; i < frame.length - lag; i++) corr += frame[i] * frame[i + lag];
    const normalized = corr / energy;
    if (normalized > bestCorr) {
      bestCorr = normalized;
      bestLag = lag;
    }
  }
  // Voicing threshold: periodic frames correlate strongly at the pitch lag.
  return bestCorr > 0.5 && bestLag > 0 ? sampleRate / bestLag : null;
}

/**
 * Compute derived acoustic measures from mono PCM samples. Pure function —
 * exported for unit tests.
 */
export function computeAcousticFeatures(samples: Int16Array, sampleRate: number): AcousticFeatures {
  const frameLen = Math.max(1, Math.round((FRAME_MS / 1000) * sampleRate));
  const hopLen = Math.max(1, Math.round((HOP_MS / 1000) * sampleRate));
  const durationMs = Math.round((samples.length / sampleRate) * 1000);

  const floats = new Float32Array(samples.length);
  for (let i = 0; i < samples.length; i++) floats[i] = samples[i] / 32768;

  const rmsPerFrame: number[] = [];
  const zcrPerFrame: number[] = [];
  const frameStarts: number[] = [];
  for (let start = 0; start + frameLen <= floats.length; start += hopLen) {
    let sumSq = 0;
    let crossings = 0;
    for (let i = start; i < start + frameLen; i++) {
      sumSq += floats[i] * floats[i];
      if (i > start && floats[i - 1] < 0 !== floats[i] < 0) crossings++;
    }
    rmsPerFrame.push(Math.sqrt(sumSq / frameLen));
    zcrPerFrame.push(crossings / frameLen);
    frameStarts.push(start);
  }

  // Adaptive speech/silence threshold: a fraction of the loud-frame level,
  // floored so a near-silent recording doesn't classify noise as speech.
  const sortedRms = [...rmsPerFrame].sort((a, b) => a - b);
  const threshold = Math.max(0.004, 0.15 * percentile(sortedRms, 0.95));
  const speechFlags = rmsPerFrame.map(r => r >= threshold);

  // Pause structure: silent runs of at least MIN_PAUSE_MS between speech.
  const minPauseFrames = Math.max(1, Math.round(MIN_PAUSE_MS / HOP_MS));
  const pauseLengthsMs: number[] = [];
  let speechSegments = 0;
  let run = 0;
  let inSpeechYet = false;
  let prevSpeech = false;
  for (const isSpeech of speechFlags) {
    if (isSpeech) {
      if (!prevSpeech) speechSegments++;
      // Leading silence before any speech is not a pause.
      if (inSpeechYet && run >= minPauseFrames) pauseLengthsMs.push(run * HOP_MS);
      inSpeechYet = true;
      run = 0;
    } else {
      run++;
    }
    prevSpeech = isSpeech;
  }

  // F0 over speech frames only (autocorrelation is meaningless in silence).
  const f0s: number[] = [];
  let voicedCount = 0;
  let speechCount = 0;
  for (let f = 0; f < speechFlags.length; f++) {
    if (!speechFlags[f]) continue;
    speechCount++;
    const f0 = frameF0(floats.subarray(frameStarts[f], frameStarts[f] + frameLen), sampleRate);
    if (f0 !== null) {
      voicedCount++;
      f0s.push(f0);
    }
  }
  f0s.sort((a, b) => a - b);

  const silentFrames = speechFlags.filter(s => !s).length;
  const durationMin = durationMs / 60000;

  return {
    duration_ms: durationMs,
    sample_rate: sampleRate,
    frames: rmsPerFrame.length,
    rms_mean: mean(rmsPerFrame),
    rms_sd: sd(rmsPerFrame),
    silence_ratio: rmsPerFrame.length ? silentFrames / rmsPerFrame.length : 1,
    pause_count: pauseLengthsMs.length,
    pause_mean_ms: mean(pauseLengthsMs),
    speech_segments_per_min: durationMin > 0 ? speechSegments / durationMin : 0,
    voiced_fraction: speechCount > 0 ? voicedCount / speechCount : 0,
    f0_median_hz: f0s.length ? percentile(f0s, 0.5) : null,
    f0_iqr_hz: f0s.length ? percentile(f0s, 0.75) - percentile(f0s, 0.25) : null,
    zcr_mean: mean(zcrPerFrame),
    zcr_sd: sd(zcrPerFrame),
  };
}

interface WavData {
  samples: Int16Array;
  sampleRate: number;
}

/**
 * Minimal RIFF/WAVE parser for the mono PCM16 files recorder.service writes.
 * Exported for unit tests. Throws on anything that isn't mono PCM16.
 */
export function parseWav(buf: Buffer): WavData {
  if (buf.length < 44 || buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('not a RIFF/WAVE file');
  }
  let offset = 12;
  let sampleRate = 0;
  let bitsPerSample = 0;
  let channels = 0;
  let data: Buffer | null = null;
  while (offset + 8 <= buf.length) {
    const chunkId = buf.toString('ascii', offset, offset + 4);
    const chunkSize = buf.readUInt32LE(offset + 4);
    const body = offset + 8;
    if (chunkId === 'fmt ') {
      channels = buf.readUInt16LE(body + 2);
      sampleRate = buf.readUInt32LE(body + 4);
      bitsPerSample = buf.readUInt16LE(body + 14);
    } else if (chunkId === 'data') {
      data = buf.subarray(body, Math.min(body + chunkSize, buf.length));
    }
    offset = body + chunkSize + (chunkSize % 2);
  }
  if (!data || sampleRate === 0) throw new Error('missing fmt/data chunk');
  if (channels !== 1 || bitsPerSample !== 16) {
    throw new Error(`unsupported format: ${channels}ch/${bitsPerSample}bit`);
  }
  const samples = new Int16Array(data.length >> 1);
  for (let i = 0; i < samples.length; i++) samples[i] = data.readInt16LE(i * 2);
  return { samples, sampleRate };
}

async function streamToBuffer(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

/**
 * Extract and store acoustic features for one session's participant track.
 * Fire-and-forget from the session-end handler; never throws.
 */
export async function generateAcousticFeaturesAsync(sessionId: string): Promise<void> {
  try {
    const config = await getSystemConfig();
    const features = (config.features as Record<string, unknown>) ?? {};
    if (features.telemetry_acoustic_features !== true) return;

    const recording = await getParticipantRecordingForSession(sessionId);
    if (!recording?.objectKey || recording.status !== 'ready') {
      log.info(`No ready participant track for ${sessionId}; skipping acoustic features`);
      return;
    }

    const { body } = await getObjectStream(recording.objectKey);
    const wav = parseWav(await streamToBuffer(body));
    const computed = computeAcousticFeatures(wav.samples, wav.sampleRate);
    await upsertSessionAcousticFeatures(sessionId, 'complete', computed as unknown as Record<string, unknown>);
    log.info(`Acoustic features stored for ${sessionId} (${computed.frames} frames)`);
  } catch (err) {
    log.error({ err }, `Acoustic feature extraction failed for ${sessionId}`);
    try {
      await upsertSessionAcousticFeatures(sessionId, 'failed', {
        error: err instanceof Error ? err.message.slice(0, 300) : String(err).slice(0, 300),
      });
    } catch {
      // Best-effort failure marker only.
    }
  }
}
