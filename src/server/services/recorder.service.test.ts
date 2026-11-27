import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Mock the storage + db boundaries so the test exercises the real PCM→WAV
// assembly and temp-file lifecycle without touching MinIO or Postgres.
const { putObjectMock, ensureBucketMock, setRecordingMock, setParticipantRecordingMock, flagProblemMock } = vi.hoisted(
  () => ({
    putObjectMock: vi.fn(),
    ensureBucketMock: vi.fn(),
    setRecordingMock: vi.fn(),
    setParticipantRecordingMock: vi.fn(),
    flagProblemMock: vi.fn(),
  }),
);
const { getSystemConfigMock, logWarnMock } = vi.hoisted(() => ({
  getSystemConfigMock: vi.fn(),
  logWarnMock: vi.fn(),
}));

vi.mock('../utils/sessionHelpers.js', () => ({ getSystemConfig: getSystemConfigMock }));
vi.mock('../utils/logger.js', () => ({
  createLogger: () => ({ info: vi.fn(), warn: logWarnMock, error: vi.fn(), debug: vi.fn() }),
}));

vi.mock('../config/objectStorage.js', () => ({
  ensureBucket: ensureBucketMock,
  putObject: putObjectMock,
  RECORDINGS_BUCKET: 'test-bucket',
}));

vi.mock('../db/recording.queries.js', () => ({
  setSessionRecording: setRecordingMock,
  setSessionParticipantRecording: setParticipantRecordingMock,
  flagParticipantAudioProblem: flagProblemMock,
}));

const {
  appendChunk,
  finalize,
  abort,
  hasRecording,
  assessParticipantTrack,
  pcm16RmsDbfs,
  pcm16SumSquares,
  MAX_FILL_SAMPLE_RATE,
  SIDECAR_ATTEMPTS,
  trackSampleRate,
  participantMicEvidence,
  watchForMutedTurn,
  isDigitalSilence,
  MUTED_TURN_WINDOW_MS,
  MUTED_TURN_LEAD_MS,
  MUTED_TURN_CONTINUITY_TOLERANCE_MS,
  MUTED_TURN_TAIL_MS,
} = await import('./recorder.service.js');

// The WAV uploads only; finalize also stores the JSON sidecar (ai-therapist-384).
const wavPuts = () => putObjectMock.mock.calls.filter((c) => c[2] === 'audio/wav');

// Build a base64 PCM16 chunk of `n` samples with a constant value.
function pcmChunk(n: number, value = 1000): string {
  const pcm = new Int16Array(n).fill(value);
  return Buffer.from(pcm.buffer).toString('base64');
}

function parseWav(buf: Buffer) {
  return {
    riff: buf.toString('ascii', 0, 4),
    wave: buf.toString('ascii', 8, 12),
    numChannels: buf.readUInt16LE(22),
    sampleRate: buf.readUInt32LE(24),
    bitsPerSample: buf.readUInt16LE(34),
    dataChunkId: buf.toString('ascii', 36, 40),
    dataSize: buf.readUInt32LE(40),
  };
}

describe('recorder.service', () => {
  beforeEach(() => {
    putObjectMock.mockReset().mockResolvedValue(undefined);
    ensureBucketMock.mockReset().mockResolvedValue(undefined);
    setRecordingMock.mockReset().mockResolvedValue(undefined);
    setParticipantRecordingMock.mockReset().mockResolvedValue(undefined);
  });

  it('buffers chunks and uploads a valid WAV on finalize', async () => {
    const sessionId = `sess-wav-${Date.now()}`;
    const sampleRate = 48000;
    // 3 chunks of 4096 samples → 12288 samples → 24576 PCM bytes.
    appendChunk(sessionId, pcmChunk(4096), sampleRate);
    appendChunk(sessionId, pcmChunk(4096), sampleRate);
    appendChunk(sessionId, pcmChunk(4096), sampleRate);
    expect(hasRecording(sessionId)).toBe(true);

    await finalize(sessionId);

    // Once for the sidecar, once for the WAV (the sidecar goes first).
    expect(ensureBucketMock).toHaveBeenCalledTimes(2);
    expect(wavPuts()).toHaveLength(1);

    const [key, body, contentType] = wavPuts()[0];
    expect(key).toBe(`sessions/${sessionId}/recording.wav`);
    expect(contentType).toBe('audio/wav');

    const wav = parseWav(body as Buffer);
    expect(wav.riff).toBe('RIFF');
    expect(wav.wave).toBe('WAVE');
    expect(wav.dataChunkId).toBe('data');
    expect(wav.numChannels).toBe(1);
    expect(wav.bitsPerSample).toBe(16);
    expect(wav.sampleRate).toBe(sampleRate);
    expect(wav.dataSize).toBe(24576); // 12288 samples * 2 bytes
    expect((body as Buffer).length).toBe(44 + 24576); // header + data

    // duration = 12288 samples / 48000 Hz = 256ms
    expect(setRecordingMock).toHaveBeenCalledWith(
      sessionId,
      expect.objectContaining({
        objectKey: `sessions/${sessionId}/recording.wav`,
        status: 'ready',
        durationMs: 256,
        sampleRate,
      }),
    );

    // Buffer is cleared after finalize.
    expect(hasRecording(sessionId)).toBe(false);
  });

  it('finalize is a no-op for an unknown session', async () => {
    await finalize('does-not-exist');
    expect(putObjectMock).not.toHaveBeenCalled();
    expect(setRecordingMock).not.toHaveBeenCalled();
  });

  it('records status "failed" (and does not throw) when upload fails', async () => {
    const sessionId = `sess-fail-${Date.now()}`;
    putObjectMock.mockRejectedValue(new Error('minio down'));
    appendChunk(sessionId, pcmChunk(2048), 24000);

    await expect(finalize(sessionId)).resolves.toBeUndefined();

    expect(setRecordingMock).toHaveBeenCalledWith(sessionId, { status: 'failed' });
    expect(hasRecording(sessionId)).toBe(false);
  });

  it('ignores straggler chunks that arrive after finalize', async () => {
    const sessionId = `sess-straggler-${Date.now()}`;
    const sampleRate = 48000;
    // 4096 samples → 8192 PCM bytes → the only audio that should be recorded.
    appendChunk(sessionId, pcmChunk(4096), sampleRate);
    await finalize(sessionId);

    // A late HTTP batch lands after the recording closed. It must NOT re-open
    // the stream (which would truncate the file and desync the duration).
    appendChunk(sessionId, pcmChunk(4096), sampleRate);
    expect(hasRecording(sessionId)).toBe(false);

    // Exactly one upload happened, and its duration reflects only the first
    // chunk (8192 bytes / 2 / 48000 = ~85ms), not the straggler.
    expect(wavPuts()).toHaveLength(1);
    expect(setRecordingMock).toHaveBeenCalledWith(
      sessionId,
      expect.objectContaining({
        status: 'ready',
        durationMs: 85,
      }),
    );
  });

  it('abort discards the buffer without uploading', async () => {
    const sessionId = `sess-abort-${Date.now()}`;
    appendChunk(sessionId, pcmChunk(1024), 48000);
    expect(hasRecording(sessionId)).toBe(true);

    abort(sessionId);

    expect(hasRecording(sessionId)).toBe(false);
    await finalize(sessionId); // nothing left to finalize
    expect(putObjectMock).not.toHaveBeenCalled();
  });

  it('finalizes both tracks to their own objects with independent metadata', async () => {
    const sessionId = `sess-dual-${Date.now()}`;
    appendChunk(sessionId, pcmChunk(4096), 48000, 'mixed');
    appendChunk(sessionId, pcmChunk(4096), 48000, 'mixed');
    appendChunk(sessionId, pcmChunk(4096), 48000, 'participant');
    expect(hasRecording(sessionId)).toBe(true);

    await finalize(sessionId);

    const keys = putObjectMock.mock.calls.map((c) => c[0]).sort();
    expect(keys).toEqual([
      `sessions/${sessionId}/participant.wav`,
      `sessions/${sessionId}/recording-tracks.json`,
      `sessions/${sessionId}/recording.wav`,
    ]);
    // mixed: 8192 samples / 48000 = ~171ms; participant: 4096 / 48000 = ~85ms
    expect(setRecordingMock).toHaveBeenCalledWith(
      sessionId,
      expect.objectContaining({
        objectKey: `sessions/${sessionId}/recording.wav`,
        status: 'ready',
        durationMs: 171,
      }),
    );
    expect(setParticipantRecordingMock).toHaveBeenCalledWith(
      sessionId,
      expect.objectContaining({
        objectKey: `sessions/${sessionId}/participant.wav`,
        status: 'ready',
        durationMs: 85,
      }),
    );
    expect(hasRecording(sessionId)).toBe(false);
  });

  it('mixed-only session never touches the participant setter', async () => {
    const sessionId = `sess-mixedonly-${Date.now()}`;
    appendChunk(sessionId, pcmChunk(2048), 48000);
    await finalize(sessionId);
    expect(setParticipantRecordingMock).not.toHaveBeenCalled();
    expect(setRecordingMock).toHaveBeenCalledOnce();
  });

  it('drops participant stragglers after finalize (per-session finalized guard)', async () => {
    const sessionId = `sess-dual-straggler-${Date.now()}`;
    appendChunk(sessionId, pcmChunk(4096), 48000, 'mixed');
    await finalize(sessionId);

    appendChunk(sessionId, pcmChunk(4096), 48000, 'participant');
    expect(hasRecording(sessionId)).toBe(false);
    await finalize(sessionId);
    expect(setParticipantRecordingMock).not.toHaveBeenCalled();
    expect(wavPuts()).toHaveLength(1);
  });

  it('a participant-track upload failure does not mark the mixed track failed', async () => {
    const sessionId = `sess-dual-fail-${Date.now()}`;
    appendChunk(sessionId, pcmChunk(4096), 48000, 'mixed');
    appendChunk(sessionId, pcmChunk(4096), 48000, 'participant');
    putObjectMock
      .mockResolvedValueOnce(undefined) // sidecar
      .mockResolvedValueOnce(undefined) // mixed upload succeeds
      .mockRejectedValueOnce(new Error('minio hiccup')); // participant fails

    await finalize(sessionId);

    expect(setRecordingMock).toHaveBeenCalledWith(sessionId, expect.objectContaining({ status: 'ready' }));
    expect(setParticipantRecordingMock).toHaveBeenCalledWith(sessionId, { status: 'failed' });
  });

  it('abort cleans up both tracks', async () => {
    const sessionId = `sess-dual-abort-${Date.now()}`;
    appendChunk(sessionId, pcmChunk(1024), 48000, 'mixed');
    appendChunk(sessionId, pcmChunk(1024), 48000, 'participant');
    abort(sessionId);
    expect(hasRecording(sessionId)).toBe(false);
    await finalize(sessionId);
    expect(putObjectMock).not.toHaveBeenCalled();
  });
});

describe('a voice session without usable participant audio is flagged (ai-therapist-372)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    putObjectMock.mockReset().mockResolvedValue(undefined);
    ensureBucketMock.mockReset().mockResolvedValue(undefined);
    setRecordingMock.mockReset().mockResolvedValue(undefined);
    setParticipantRecordingMock.mockReset().mockResolvedValue(undefined);
    flagProblemMock.mockReset().mockResolvedValue(true);
    logWarnMock.mockReset();
    getSystemConfigMock.mockReset().mockResolvedValue({ features: { participant_audio_auto_deviation: true } });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  // Append `seconds` of audio in 4096-sample callbacks at 48 kHz, all at the
  // same instant of the (fake) clock.
  function feed(
    sessionId: string,
    track: 'mixed' | 'participant',
    seconds: number,
    opts: { value?: number; muted?: (i: number) => boolean } = {},
  ) {
    const callbacks = Math.ceil((seconds * 48000) / 4096);
    for (let i = 0; i < callbacks; i++) {
      appendChunk(sessionId, pcmChunk(4096, opts.value ?? 1000), 48000, track, { muted: opts.muted?.(i) ?? false });
    }
  }

  const warned = (fragment: string) => logWarnMock.mock.calls.some((c) => String(c[1] ?? c[0]).includes(fragment));

  it('flags the stage case: 0.17 s of participant audio beside a 20 s mix', async () => {
    const sessionId = `sess-372-short-${Date.now()}`;
    feed(sessionId, 'mixed', 20);
    appendChunk(sessionId, pcmChunk(4096), 48000, 'participant');
    appendChunk(sessionId, pcmChunk(4096), 48000, 'participant');

    await finalize(sessionId);

    expect(warned('ended without usable participant audio (short)')).toBe(true);
    expect(flagProblemMock).toHaveBeenCalledOnce();
    expect(flagProblemMock).toHaveBeenCalledWith(
      sessionId,
      expect.objectContaining({ problem: 'short', participantMs: 171 }),
    );
    // The track is still stored: a partial track is evidence, not garbage.
    expect(setParticipantRecordingMock).toHaveBeenCalledWith(sessionId, expect.objectContaining({ status: 'ready' }));
  });

  it('judges "short" against the wall clock when both tracks lost audio alike', async () => {
    const sessionId = `sess-372-wall-${Date.now()}`;
    // 12 s of each track, arriving over 30 s of wall clock: 18 s lost on both.
    feed(sessionId, 'mixed', 6);
    feed(sessionId, 'participant', 6);
    vi.advanceTimersByTime(30_000);
    feed(sessionId, 'mixed', 6);
    feed(sessionId, 'participant', 6);

    await finalize(sessionId);
    expect(flagProblemMock).toHaveBeenCalledWith(
      sessionId,
      expect.objectContaining({ problem: 'short', wallMs: 30_000 }),
    );
  });

  it('a wall clock no longer than the audio is not short', async () => {
    const sessionId = `sess-372-wallok-${Date.now()}`;
    feed(sessionId, 'mixed', 6);
    feed(sessionId, 'participant', 6);
    vi.advanceTimersByTime(6_000);
    feed(sessionId, 'mixed', 6);
    feed(sessionId, 'participant', 6);
    await finalize(sessionId);
    expect(flagProblemMock).not.toHaveBeenCalled();
  });

  it('flags a session with a mix and no participant track at all', async () => {
    const sessionId = `sess-372-missing-${Date.now()}`;
    feed(sessionId, 'mixed', 12);
    await finalize(sessionId);
    expect(flagProblemMock).toHaveBeenCalledWith(sessionId, expect.objectContaining({ problem: 'missing' }));
  });

  it('flags a full-length participant track that is digital silence while the mic was on', async () => {
    const sessionId = `sess-372-silent-${Date.now()}`;
    feed(sessionId, 'mixed', 12);
    feed(sessionId, 'participant', 12, { value: 0 });
    await finalize(sessionId);
    expect(flagProblemMock).toHaveBeenCalledWith(sessionId, expect.objectContaining({ problem: 'silent' }));
  });

  it('does not flag a participant who stayed muted the whole session (zeros by choice)', async () => {
    const sessionId = `sess-372-muted-${Date.now()}`;
    feed(sessionId, 'mixed', 30);
    feed(sessionId, 'participant', 30, { value: 0, muted: () => true });
    await finalize(sessionId);
    expect(flagProblemMock).not.toHaveBeenCalled();
    expect(warned('without usable participant audio')).toBe(false);
  });

  it('judges only the unmuted audio: speech while on, zeros while muted, is fine', async () => {
    const sessionId = `sess-372-mixedmute-${Date.now()}`;
    feed(sessionId, 'mixed', 30);
    feed(sessionId, 'participant', 25, { value: 0, muted: () => true });
    feed(sessionId, 'participant', 5, { value: 2000 });
    await finalize(sessionId);
    expect(flagProblemMock).not.toHaveBeenCalled();
  });

  it('flags zeros recorded while the mic was ON, even with muted stretches around them', async () => {
    const sessionId = `sess-372-onzero-${Date.now()}`;
    feed(sessionId, 'mixed', 30);
    feed(sessionId, 'participant', 20, { value: 0, muted: () => true });
    feed(sessionId, 'participant', 10, { value: 0 });
    await finalize(sessionId);
    expect(flagProblemMock).toHaveBeenCalledWith(sessionId, expect.objectContaining({ problem: 'silent' }));
  });

  it('flags a participant track whose upload failed', async () => {
    const sessionId = `sess-372-failed-${Date.now()}`;
    feed(sessionId, 'mixed', 12);
    feed(sessionId, 'participant', 12);
    putObjectMock
      .mockResolvedValueOnce(undefined) // sidecar
      .mockResolvedValueOnce(undefined) // mix
      .mockRejectedValueOnce(new Error('minio hiccup')); // participant
    await finalize(sessionId);
    expect(flagProblemMock).toHaveBeenCalledWith(sessionId, expect.objectContaining({ problem: 'missing' }));
  });

  it('does not flag a healthy session', async () => {
    const sessionId = `sess-372-ok-${Date.now()}`;
    feed(sessionId, 'mixed', 12);
    feed(sessionId, 'participant', 12);
    await finalize(sessionId);
    expect(flagProblemMock).not.toHaveBeenCalled();
  });

  it('does not judge a session too short to compare', async () => {
    const sessionId = `sess-372-tiny-${Date.now()}`;
    feed(sessionId, 'mixed', 3);
    await finalize(sessionId);
    expect(flagProblemMock).not.toHaveBeenCalled();
  });

  it('the deviation row is OFF by default: the warning is logged, no row is written', async () => {
    let n = 0;
    for (const config of [{ features: {} }, {}, { features: { participant_audio_auto_deviation: 'yes' } }]) {
      getSystemConfigMock.mockResolvedValueOnce(config);
      logWarnMock.mockReset();
      const sessionId = `sess-372-off-${Date.now()}-${n++}`;
      feed(sessionId, 'mixed', 12);
      await finalize(sessionId);
      expect(warned('ended without usable participant audio (missing)')).toBe(true);
    }
    expect(flagProblemMock).not.toHaveBeenCalled();
  });

  it('a config read failure leaves the row off and finalize intact', async () => {
    getSystemConfigMock.mockRejectedValueOnce(new Error('pool timeout'));
    const sessionId = `sess-372-cfgfail-${Date.now()}`;
    feed(sessionId, 'mixed', 12);
    await expect(finalize(sessionId)).resolves.toBeUndefined();
    expect(flagProblemMock).not.toHaveBeenCalled();
  });

  it('a failing flag write never breaks finalize', async () => {
    const sessionId = `sess-372-flagfail-${Date.now()}`;
    feed(sessionId, 'mixed', 12);
    flagProblemMock.mockRejectedValueOnce(new Error('pool timeout'));
    await expect(finalize(sessionId)).resolves.toBeUndefined();
    expect(setRecordingMock).toHaveBeenCalledWith(sessionId, expect.objectContaining({ status: 'ready' }));
  });

  it('assessParticipantTrack thresholds', () => {
    const mix = { durationMs: 60_000 };
    const track = (durationMs: number, unmutedRmsDbfs = -30, unmutedMs = durationMs) => ({
      durationMs,
      unmutedMs,
      unmutedRmsDbfs,
    });
    expect(assessParticipantTrack(null, null)).toBeNull();
    expect(assessParticipantTrack({ durationMs: 9_999 }, null)).toBeNull();
    expect(assessParticipantTrack({ durationMs: 10_000 }, null)).toBe('missing');
    expect(assessParticipantTrack({ durationMs: 9_999 }, null, 10_000)).toBe('missing');
    expect(assessParticipantTrack(mix, null)).toBe('missing');
    expect(assessParticipantTrack(mix, track(47_999))).toBe('short');
    expect(assessParticipantTrack(mix, track(48_000))).toBeNull();
    expect(assessParticipantTrack(mix, track(60_000), 75_000)).toBeNull();
    expect(assessParticipantTrack(mix, track(60_000), 75_001)).toBe('short');
    expect(assessParticipantTrack(mix, track(60_000, -61))).toBe('silent');
    // A participant who speaks little is quiet overall, not silent.
    expect(assessParticipantTrack(mix, track(60_000, -59))).toBeNull();
    expect(assessParticipantTrack(mix, track(60_000, -Infinity))).toBe('silent');
    // Silence is judged only over enough audio recorded with the mic on.
    expect(assessParticipantTrack(mix, track(60_000, -Infinity, 4_999))).toBeNull();
    expect(assessParticipantTrack(mix, track(60_000, -Infinity, 5_000))).toBe('silent');
  });

  it('pcm16RmsDbfs measures full scale, a quiet signal and digital silence', () => {
    const full = Buffer.from(new Int16Array(100).fill(-32768).buffer);
    expect(pcm16RmsDbfs(full)).toBeCloseTo(0, 5);
    const quiet = Buffer.from(new Int16Array(100).fill(328).buffer); // ~ -40 dBFS
    expect(pcm16RmsDbfs(quiet)).toBeCloseTo(-40, 0);
    expect(pcm16RmsDbfs(Buffer.alloc(200))).toBe(-Infinity);
    expect(pcm16RmsDbfs(Buffer.alloc(0))).toBe(-Infinity);
    expect(pcm16SumSquares(full)).toBeCloseTo(100, 5);
  });

  it('measures the level as chunks arrive, so finalize scans no samples', async () => {
    const sessionId = `sess-372-incremental-${Date.now()}`;
    feed(sessionId, 'mixed', 12);
    feed(sessionId, 'participant', 12, { value: 0 });
    const spy = vi.spyOn(Buffer.prototype, 'readInt16LE');
    await finalize(sessionId);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
    expect(flagProblemMock).toHaveBeenCalledWith(sessionId, expect.objectContaining({ problem: 'silent' }));
  });
});

describe('audio sequence checks (ai-therapist-372)', () => {
  beforeEach(() => {
    putObjectMock.mockReset().mockResolvedValue(undefined);
    ensureBucketMock.mockReset().mockResolvedValue(undefined);
    setRecordingMock.mockReset().mockResolvedValue(undefined);
    setParticipantRecordingMock.mockReset().mockResolvedValue(undefined);
    logWarnMock.mockReset();
    getSystemConfigMock.mockReset().mockResolvedValue({ features: {} });
  });

  const dataBytes = () => (wavPuts()[0][1] as Buffer).readUInt32LE(40);

  it('drops a duplicate (a retry the server had already stored) and logs it once per run', async () => {
    const sessionId = `sess-372-dup-${Date.now()}`;
    for (const seq of [0, 1, 2, 0, 1, 3]) appendChunk(sessionId, pcmChunk(100), 48000, 'mixed', { seq });
    await finalize(sessionId);
    expect(dataBytes()).toBe(4 * 200); // 0, 1, 2, 3
    const dupLogs = logWarnMock.mock.calls.filter((c) => String(c[1]).includes('out-of-order or duplicate'));
    expect(dupLogs).toHaveLength(1);
    expect(dupLogs[0][0]).toEqual(expect.objectContaining({ seq: 0, expected: 3 }));
  });

  it('logs a gap with the number of chunks missing and keeps appending', async () => {
    const sessionId = `sess-372-gap-${Date.now()}`;
    for (const seq of [0, 1, 5, 6]) appendChunk(sessionId, pcmChunk(100), 48000, 'participant', { seq });
    await finalize(sessionId);
    expect(dataBytes()).toBe(7 * 200); // the 3 missing chunks are filled with silence (ai-therapist-384)
    const gap = logWarnMock.mock.calls.find((c) => String(c[1]).includes('audio sequence gap'));
    expect(gap?.[0]).toEqual(expect.objectContaining({ seq: 5, expected: 2, missing: 3 }));
    const summary = logWarnMock.mock.calls.find((c) => String(c[1]).includes('arrived with sequence problems'));
    expect(summary?.[0]).toEqual(expect.objectContaining({ gapChunks: 3, gapEvents: 1, staleChunks: 0 }));
  });

  it('numbers the two tracks independently', async () => {
    const sessionId = `sess-372-tracks-${Date.now()}`;
    appendChunk(sessionId, pcmChunk(100), 48000, 'mixed', { seq: 0 });
    appendChunk(sessionId, pcmChunk(100), 48000, 'participant', { seq: 0 });
    appendChunk(sessionId, pcmChunk(100), 48000, 'mixed', { seq: 1 });
    appendChunk(sessionId, pcmChunk(100), 48000, 'participant', { seq: 1 });
    await finalize(sessionId);
    expect(logWarnMock).not.toHaveBeenCalled();
  });

  it('appends legacy batches without seq unchecked', async () => {
    const sessionId = `sess-372-legacy-${Date.now()}`;
    for (let i = 0; i < 3; i++) appendChunk(sessionId, pcmChunk(100), 48000, 'mixed');
    await finalize(sessionId);
    expect(dataBytes()).toBe(3 * 200);
    expect(logWarnMock).not.toHaveBeenCalled();
  });
});

describe('lost audio is filled with silence and described in the sidecar (ai-therapist-384)', () => {
  beforeEach(() => {
    putObjectMock.mockReset().mockResolvedValue(undefined);
    ensureBucketMock.mockReset().mockResolvedValue(undefined);
    setRecordingMock.mockReset().mockResolvedValue(undefined);
    setParticipantRecordingMock.mockReset().mockResolvedValue(undefined);
    logWarnMock.mockReset();
    getSystemConfigMock.mockReset().mockResolvedValue({ features: {} });
  });

  const N = 100; // samples per chunk in these tests
  let counter = 0;
  const sid = (name: string) => `sess-384-${name}-${Date.now()}-${counter++}`;
  /** A chunk whose every sample is seq + 1, so a position shows which chunk landed there. */
  const marked = (seq: number) => pcmChunk(N, seq + 1);
  const send = (
    sessionId: string,
    track: 'mixed' | 'participant',
    seqs: number[],
    extra: { muted?: number[]; pushed?: number; sampleRate?: number } = {},
  ) => {
    for (const seq of seqs) {
      appendChunk(sessionId, marked(seq), extra.sampleRate ?? 48000, track, {
        seq,
        muted: extra.muted?.includes(seq) ?? false,
        ...(extra.pushed === undefined ? {} : { pushed: extra.pushed }),
      });
    }
  };
  function pcmOf(sessionId: string, track: 'mixed' | 'participant'): Int16Array {
    const name = track === 'mixed' ? 'recording.wav' : 'participant.wav';
    const call = putObjectMock.mock.calls.find((c) => c[0] === `sessions/${sessionId}/${name}`);
    if (!call) throw new Error(`no ${name}`);
    const data = (call[1] as Buffer).subarray(44);
    return new Int16Array(data.buffer.slice(data.byteOffset, data.byteOffset + data.length));
  }
  function sidecarOf(sessionId: string) {
    const call = putObjectMock.mock.calls.find((c) => c[0] === `sessions/${sessionId}/recording-tracks.json`);
    if (!call) throw new Error('no sidecar');
    expect(call[2]).toBe('application/json');
    return JSON.parse((call[1] as Buffer).toString('utf8'));
  }
  /** Value of each chunk-sized slot: seq + 1 where real audio landed, 0 where silence was inserted. */
  const slots = (pcm: Int16Array) => {
    const out: number[] = [];
    for (let i = 0; i < pcm.length; i += N) {
      const slot = pcm.subarray(i, i + N);
      expect(slot.length).toBe(N);
      expect(new Set(slot).size).toBe(1); // never a slot straddling two chunks
      out.push(slot[0]);
    }
    return out;
  };

  it('fills the gap of one lost batch with exactly the missing length of silence', async () => {
    const s = sid('one');
    send(s, 'participant', [0, 1, 4, 5]);
    await finalize(s);
    expect(slots(pcmOf(s, 'participant'))).toEqual([1, 2, 0, 0, 5, 6]);
    const t = sidecarOf(s).tracks.participant;
    expect(t).toEqual(
      expect.objectContaining({
        object: 'participant.wav',
        sampleRate: 48000,
        totalSamples: 6 * N,
        sequenced: true,
        chunkSamples: N,
        chunksReceived: 4,
        chunksStale: 0,
        chunksMissing: 2,
        insertedSilenceSamples: 2 * N,
        gapCount: 1,
        gaps: [{ start: 2 * N, length: 2 * N, chunks: 2, reason: 'sequence_gap' }],
        timelineIntact: true,
        complete: false,
      }),
    );
    expect(setParticipantRecordingMock).toHaveBeenCalledWith(
      s,
      expect.objectContaining({ durationMs: Math.round(((6 * N) / 48000) * 1000) }),
    );
  });

  it('fills several gaps, each at its own place', async () => {
    const s = sid('several');
    send(s, 'mixed', [0, 3, 4, 8]);
    await finalize(s);
    expect(slots(pcmOf(s, 'mixed'))).toEqual([1, 0, 0, 4, 5, 0, 0, 0, 9]);
    const t = sidecarOf(s).tracks.mixed;
    expect(t.gaps).toEqual([
      { start: N, length: 2 * N, chunks: 2, reason: 'sequence_gap' },
      { start: 5 * N, length: 3 * N, chunks: 3, reason: 'sequence_gap' },
    ]);
    expect(t.chunksMissing).toBe(5);
    expect(t.insertedSilenceSamples).toBe(5 * N);
  });

  it('fills a gap at the very start, sized by the first chunk that arrives', async () => {
    const s = sid('start');
    send(s, 'participant', [3, 4]);
    await finalize(s);
    expect(slots(pcmOf(s, 'participant'))).toEqual([0, 0, 0, 4, 5]);
    expect(sidecarOf(s).tracks.participant.gaps).toEqual([
      { start: 0, length: 3 * N, chunks: 3, reason: 'sequence_gap' },
    ]);
  });

  it('fills a tail lost at the very end from the count of chunks the client reported', async () => {
    const s = sid('tail');
    send(s, 'participant', [0, 1, 2], { pushed: 6 });
    await finalize(s);
    expect(slots(pcmOf(s, 'participant'))).toEqual([1, 2, 3, 0, 0, 0]);
    const t = sidecarOf(s).tracks.participant;
    expect(t.gaps).toEqual([{ start: 3 * N, length: 3 * N, chunks: 3, reason: 'lost_tail' }]);
    expect(t.clientChunksPushed).toBe(6);
    expect(t.chunksMissing).toBe(3);
    expect(t.complete).toBe(false);
  });

  it('a gap just before the final chunk, and no tail when the client count matches', async () => {
    const s = sid('end');
    send(s, 'participant', [0, 1, 5], { pushed: 6 });
    await finalize(s);
    expect(slots(pcmOf(s, 'participant'))).toEqual([1, 2, 0, 0, 0, 6]);
    expect(sidecarOf(s).tracks.participant.gaps).toHaveLength(1);
  });

  it('caps a huge bogus seq: one fill at most 60 s, the total at the wall-clock span plus 60 s', async () => {
    const s = sid('bogus');
    const rate = 8000;
    send(s, 'participant', [0], { sampleRate: rate });
    send(s, 'participant', [1_000_000_000_000], { sampleRate: rate });
    send(s, 'participant', [2_000_000_000_000], { sampleRate: rate });
    await finalize(s);
    const t = sidecarOf(s).tracks.participant;
    const sixty = 60 * rate;
    expect(t.gaps[0]).toEqual(
      expect.objectContaining({ start: N, length: sixty, capped: true, missingSamples: (1_000_000_000_000 - 1) * N }),
    );
    // The wall-clock span is a few ms here, so the second fill has (almost) nothing left.
    expect(t.gaps[1].capped).toBe(true);
    expect(t.gaps[1].length).toBeLessThan(rate);
    expect(t.insertedSilenceSamples).toBe(sixty + t.gaps[1].length);
    expect(t.totalSamples).toBe(3 * N + t.insertedSilenceSamples);
    expect(pcmOf(s, 'participant').length).toBe(t.totalSamples);
    expect(t.timelineIntact).toBe(false);
  });

  it('a bogus client sample rate does not scale the caps (review of #105)', async () => {
    // The rate is the client's own number: at 1e9 Hz an uncapped rate let one
    // batch ask for 60 s x 1e9 samples (120 GB) of zeros.
    for (const rate of [1e9, 2e9]) {
      const s = sid(`bogus-rate-${rate}`);
      send(s, 'participant', [0], { sampleRate: rate });
      send(s, 'participant', [1_000_000_000_000], { sampleRate: rate });
      await finalize(s);
      const t = sidecarOf(s).tracks.participant;
      expect(t.gaps[0].length).toBe(60 * MAX_FILL_SAMPLE_RATE);
      expect(t.gaps[0].capped).toBe(true);
    }
    const s = sid('bogus-rate-0');
    send(s, 'participant', [0], { sampleRate: 0 });
    send(s, 'participant', [5], { sampleRate: 0 });
    await finalize(s);
    const t = sidecarOf(s).tracks.participant;
    expect(t.insertedSilenceSamples).toBe(0);
    expect(t.timelineIntact).toBe(false);
  });

  it('a single fill stays at 60 s even when the wall-clock span would allow more', async () => {
    const s = sid('bogus-long');
    const rate = 8000;
    const realNow = Date.now();
    send(s, 'participant', [0], { sampleRate: rate });
    // Ten minutes later (relative to the real clock), a bogus index arrives.
    const clock = vi.spyOn(Date, 'now').mockReturnValue(realNow + 10 * 60_000);
    try {
      send(s, 'participant', [1_000_000_000_000], { sampleRate: rate });
    } finally {
      clock.mockRestore();
    }
    await finalize(s);
    const t = sidecarOf(s).tracks.participant;
    expect(t.gaps[0].length).toBe(60 * rate);
    expect(t.gaps[0].capped).toBe(true);
  });

  it('drops stale and duplicate chunks around a gap without moving any audio', async () => {
    const s = sid('stale');
    send(s, 'participant', [0, 1, 4, 2, 4, 3, 5]);
    await finalize(s);
    expect(slots(pcmOf(s, 'participant'))).toEqual([1, 2, 0, 0, 5, 6]);
    const t = sidecarOf(s).tracks.participant;
    expect(t.chunksStale).toBe(3); // the late 2 and 3, the duplicate 4
    expect(t.chunksReceived).toBe(4);
    expect(t.chunksMissing).toBe(2);
  });

  it('keeps the two tracks sample-aligned after a gap on one of them', async () => {
    const s = sid('aligned');
    send(s, 'mixed', [0, 1, 2, 3, 4, 5]);
    send(s, 'participant', [0, 1, 4, 5]);
    await finalize(s);
    const mixed = slots(pcmOf(s, 'mixed'));
    const participant = slots(pcmOf(s, 'participant'));
    expect(participant).toHaveLength(mixed.length);
    participant.forEach((v, i) => {
      if (v !== 0) expect(v).toBe(mixed[i]);
    });
    expect(sidecarOf(s).tracksAligned).toBe(true);
  });

  it('builds the muted ranges from the per-chunk flags, a toggle mid-session and a gap included', async () => {
    const s = sid('muted');
    // on, muted, muted, on, muted, (5 lost), muted, on
    send(s, 'participant', [0, 1, 2, 3, 4, 6, 7], { muted: [1, 2, 4, 6] });
    await finalize(s);
    const t = sidecarOf(s).tracks.participant;
    expect(t.muted).toEqual([
      { start: N, length: 2 * N },
      { start: 4 * N, length: N },
      { start: 6 * N, length: N },
    ]);
    expect(t.mutedSamples).toBe(4 * N);
    expect(t.gaps).toEqual([{ start: 5 * N, length: N, chunks: 1, reason: 'sequence_gap' }]);
  });

  it('an old client without seq is stored exactly as before: no fill, gaps unknown', async () => {
    const s = sid('legacy');
    for (let i = 0; i < 3; i++) appendChunk(s, marked(i), 48000, 'mixed');
    await finalize(s);
    expect(slots(pcmOf(s, 'mixed'))).toEqual([1, 2, 3]);
    const sc = sidecarOf(s);
    expect(sc.tracks.mixed).toEqual(
      expect.objectContaining({
        sequenced: false,
        gaps: [],
        insertedSilenceSamples: 0,
        timelineIntact: false,
        complete: null,
        clientChunksPushed: null,
      }),
    );
    expect(sc.tracksAligned).toBe(false);
  });

  it('writes the sidecar at finalisation: one JSON object of numbers next to the WAVs', async () => {
    const s = sid('sidecar');
    send(s, 'mixed', [0, 1, 2], { pushed: 3 });
    send(s, 'participant', [0, 1, 2], { pushed: 3, muted: [1] });
    await finalize(s);
    const sc = sidecarOf(s);
    expect(sc.version).toBe(1);
    expect(Object.keys(sc.tracks).sort()).toEqual(['mixed', 'participant']);
    expect(sc.tracks.mixed.complete).toBe(true);
    expect(sc.tracks.participant.complete).toBe(true);
    expect(sc.tracksAligned).toBe(true);
    // The only strings are the object names: no content, no identifiers.
    const strings: string[] = [];
    JSON.stringify(sc, (_k, v) => {
      if (typeof v === 'string') strings.push(v);
      return v;
    });
    expect(new Set(strings)).toEqual(new Set(['recording.wav', 'participant.wav']));
    // Written BEFORE both WAVs (review of #105), and each WAV says so.
    expect(putObjectMock.mock.calls[0][0]).toBe(`sessions/${s}/recording-tracks.json`);
    for (const [, , type, meta] of wavPuts()) {
      expect(type).toBe('audio/wav');
      expect(meta).toEqual({ 'track-data': 'stored' });
    }
  });

  it('a sidecar upload failure never marks a track failed', async () => {
    const s = sid('sidecar-fail');
    send(s, 'mixed', [0, 1]);
    putObjectMock.mockImplementation(async (key: string) => {
      if (key.endsWith('.json')) throw new Error('minio hiccup');
    });
    await finalize(s);
    expect(setRecordingMock).toHaveBeenCalledWith(s, expect.objectContaining({ status: 'ready' }));
    expect(setRecordingMock).not.toHaveBeenCalledWith(s, { status: 'failed' });
    // Retried a bounded number of times, then recorded on the WAV (review of #105).
    const sidecarTries = putObjectMock.mock.calls.filter((c) => String(c[0]).endsWith('.json'));
    expect(sidecarTries).toHaveLength(SIDECAR_ATTEMPTS);
    expect(wavPuts()[0][3]).toEqual({ 'track-data': 'missing' });
  });

  it('a sidecar upload that fails once is retried and stored (review of #105)', async () => {
    const s = sid('sidecar-retry');
    send(s, 'participant', [0, 2]);
    let failures = 0;
    putObjectMock.mockImplementation(async (key: string) => {
      if (key.endsWith('.json') && failures++ === 0) throw new Error('minio hiccup');
    });
    await finalize(s);
    expect(putObjectMock.mock.calls.filter((c) => String(c[0]).endsWith('.json'))).toHaveLength(2);
    expect(sidecarOf(s).tracks.participant.gapCount).toBe(1);
    expect(wavPuts()[0][3]).toEqual({ 'track-data': 'stored' });
  });

  it('a 192 kHz track is recorded, and its fills stay within the byte bound (review of #105)', async () => {
    const s = sid('rate-192k');
    const rate = 192000;
    send(s, 'participant', [0, 1, 3], { sampleRate: rate });
    send(s, 'participant', [1_000_000_000_000], { sampleRate: rate });
    await finalize(s);
    const t = sidecarOf(s).tracks.participant;
    expect(t.sampleRate).toBe(rate);
    // An ordinary one-chunk gap is filled exactly.
    expect(t.gaps[0]).toEqual({ start: 2 * N, length: N, chunks: 1, reason: 'sequence_gap' });
    // A huge gap: capped by bytes, at most 60 s x 96 kHz samples (11.52 MB), i.e. 30 s of 192 kHz time.
    // (The wall-clock span here is a few ms, so the total cap leaves it just under that.)
    expect(t.gaps[1].capped).toBe(true);
    expect(t.gaps[1].length).toBeLessThanOrEqual(60 * MAX_FILL_SAMPLE_RATE);
    expect(t.gaps[1].length).toBeGreaterThan(59 * MAX_FILL_SAMPLE_RATE);
    // Every byte of inserted silence on the track: within 60 s x 96 kHz plus the span allowance (< 1 s here).
    expect(t.insertedSilenceSamples * 2).toBeLessThanOrEqual(2 * 61 * MAX_FILL_SAMPLE_RATE);
    expect(pcmOf(s, 'participant').length).toBe(t.totalSamples);
  });

  it('reports the rate a track was opened at, for the route to refuse another (review of #105)', async () => {
    const s = sid('rate');
    expect(trackSampleRate(s, 'participant')).toBeNull();
    send(s, 'participant', [0], { sampleRate: 44100 });
    expect(trackSampleRate(s, 'participant')).toBe(44100);
    expect(trackSampleRate(s, 'mixed')).toBeNull();
    await finalize(s);
    expect(trackSampleRate(s, 'participant')).toBeNull();
  });

  it('a track fed unsequenced and then sequenced batches is not claimed intact (review of #105)', async () => {
    const s = sid('mixed-clients');
    // An older bundle (no seq), then the participant reloads into the new one.
    appendChunk(s, marked(0), 48000, 'participant');
    appendChunk(s, marked(1), 48000, 'participant');
    send(s, 'participant', [0, 1, 3]);
    await finalize(s);
    const t = sidecarOf(s).tracks.participant;
    expect(t.sequenced).toBe('partial');
    expect(t.timelineIntact).toBe(false);
    expect(t.complete).toBeNull();
    expect(sidecarOf(s).tracksAligned).toBe(false);
    // Sequenced only, and unsequenced only, are unchanged.
    const a = sid('seq-only');
    send(a, 'participant', [0, 1]);
    const b = sid('unseq-only');
    appendChunk(b, marked(0), 48000, 'participant');
    await finalize(a);
    await finalize(b);
    expect(sidecarOf(a).tracks.participant).toEqual(
      expect.objectContaining({ sequenced: true, timelineIntact: true, complete: true }),
    );
    expect(sidecarOf(b).tracks.participant).toEqual(
      expect.objectContaining({ sequenced: false, timelineIntact: false, complete: null }),
    );
  });

  it('judges a participant track "short" on the audio received, not on inserted silence', () => {
    const mixed = { durationMs: 20_000 };
    const base = { durationMs: 20_000, unmutedMs: 20_000, unmutedRmsDbfs: -20 };
    expect(assessParticipantTrack(mixed, { ...base, insertedSilenceMs: 15_000 })).toBe('short');
    expect(assessParticipantTrack(mixed, { ...base, insertedSilenceMs: 1_000 })).toBeNull();
  });
});

// Stored beside each GPT-Live participant turn (sidebandManager onUserTurn) so
// a transcript the voice model produced out of a muted microphone's silence
// can be found afterwards. Evidence only: it never gates a turn.
describe('participantMicEvidence: what has arrived of the participant track', () => {
  const sampleRate = 48000;
  const second = () => pcmChunk(sampleRate, 3277); // one second at about -20 dBFS

  it('is null when the session has no participant track here', () => {
    const sessionId = `sess-evidence-none-${Date.now()}`;
    expect(participantMicEvidence(sessionId)).toBeNull();
    // The mix alone says nothing about the microphone.
    appendChunk(sessionId, second(), sampleRate, 'mixed');
    expect(participantMicEvidence(sessionId)).toBeNull();
    abort(sessionId);
  });

  it('a track that has only ever been muted reports no unmuted audio and no level', () => {
    const sessionId = `sess-evidence-muted-${Date.now()}`;
    appendChunk(sessionId, pcmChunk(sampleRate, 0), sampleRate, 'participant', { seq: 0, muted: true });
    appendChunk(sessionId, pcmChunk(sampleRate, 0), sampleRate, 'participant', { seq: 1, muted: true });
    expect(participantMicEvidence(sessionId)).toEqual({
      received_ms: 2000,
      muted_ms: 2000,
      unmuted_ms: 0,
      unmuted_rms_dbfs: null,
    });
    abort(sessionId);
  });

  it('counts unmuted audio and its level once the microphone is on', () => {
    const sessionId = `sess-evidence-on-${Date.now()}`;
    appendChunk(sessionId, pcmChunk(sampleRate, 0), sampleRate, 'participant', { seq: 0, muted: true });
    appendChunk(sessionId, second(), sampleRate, 'participant', { seq: 1 });
    expect(participantMicEvidence(sessionId)).toEqual({
      received_ms: 2000,
      muted_ms: 1000,
      unmuted_ms: 1000,
      unmuted_rms_dbfs: -20,
    });
    abort(sessionId);
  });

  it('an unmuted microphone that delivered exact silence has audio but no level', () => {
    const sessionId = `sess-evidence-silent-${Date.now()}`;
    appendChunk(sessionId, pcmChunk(sampleRate, 0), sampleRate, 'participant', { seq: 0 });
    expect(participantMicEvidence(sessionId)).toMatchObject({ unmuted_ms: 1000, unmuted_rms_dbfs: null });
    abort(sessionId);
  });

  it('is null again once the recording is closed', () => {
    const sessionId = `sess-evidence-closed-${Date.now()}`;
    appendChunk(sessionId, second(), sampleRate, 'participant', { seq: 0 });
    abort(sessionId);
    expect(participantMicEvidence(sessionId)).toBeNull();
  });
});

// ai-therapist-412. The one place allowed to say "nobody spoke". The asymmetry
// under test: `no_speech` only on complete, positive evidence; every missing,
// late, lost or ambiguous case must come back as real speech (null, `speech`
// or `unknown`), because a turn judged `no_speech` is not risk-scored.
describe('watchForMutedTurn: a verdict only on complete evidence the microphone was muted', () => {
  const sampleRate = 48000;
  // 100 ms chunks, four to a batch like the uploader's 400 ms timer, so the
  // tail margin is ten chunks.
  const CHUNK = 4800;
  const CHUNK_MS = 100;
  const silent = () => pcmChunk(CHUNK, 0);
  const voiced = () => pcmChunk(CHUNK, 3277);
  let clock = 1_000_000;
  let n = 0;
  const next = new Map<string, number>();
  const newSession = (name: string) => `sess-muted-turn-${name}-${n++}`;

  interface BatchOpts {
    /** Chunks in the batch (default 4). */
    count?: number;
    /** Wall clock that passes before the batch arrives (default: the audio it carries). */
    dt?: number;
    muted?: boolean;
    /** Chunks captured but not yet sent when the batch was cut. */
    ahead?: number;
    /** Override `pushed`; null leaves it out. */
    pushed?: number | null;
    /** Override the batch's first index (a gap or a repeat). */
    seq?: number;
    /** The chunk to send (default: zeros when muted, a tone when not). */
    pcm?: string;
  }

  /** One HTTP batch arriving `dt` ms after the previous one. */
  function tick(sessionId: string, opts: BatchOpts = {}) {
    const count = opts.count ?? 4;
    const muted = opts.muted ?? true;
    const seq = opts.seq ?? next.get(sessionId) ?? 0;
    clock += opts.dt ?? count * CHUNK_MS;
    const pushed = opts.pushed === undefined ? seq + count + (opts.ahead ?? 0) : opts.pushed;
    for (let i = 0; i < count; i++) {
      appendChunk(sessionId, opts.pcm ?? (muted ? silent() : voiced()), sampleRate, 'participant', {
        seq: seq + i,
        muted,
        batchStart: i === 0,
        ...(pushed === null ? {} : { pushed }),
      });
    }
    next.set(sessionId, seq + count);
  }

  /** `batches` ordinary muted batches: capture running, uploads on time. */
  function run(sessionId: string, batches: number, opts: BatchOpts = {}) {
    for (let i = 0; i < batches; i++) tick(sessionId, opts);
  }

  /** Resolves to the verdict, or 'pending' when the promise has not settled. */
  async function peek(p: Promise<{ verdict: string }> | null): Promise<string | null> {
    if (p === null) return null;
    let verdict = 'pending';
    void p.then((r) => {
      verdict = r.verdict;
    });
    await new Promise((resolve) => setImmediate(resolve));
    return verdict;
  }

  beforeEach(() => {
    clock = 1_000_000;
    next.clear();
    vi.spyOn(Date, 'now').mockImplementation(() => clock);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('the margins', () => {
    expect(MUTED_TURN_TAIL_MS).toBe(1000);
    expect(MUTED_TURN_WINDOW_MS).toBe(120_000);
    expect(MUTED_TURN_LEAD_MS).toBe(5000);
    expect(MUTED_TURN_CONTINUITY_TOLERANCE_MS).toBe(750);
  });

  it('captured without a pause and muted from before the turn until past it: no speech, with the evidence', async () => {
    const sessionId = newSession('muted');
    run(sessionId, 20); // 8 s
    const watch = watchForMutedTurn(sessionId, clock - 1000, 60_000);
    expect(watch).not.toBeNull();
    // First batch after the check began: may have been sent before it.
    tick(sessionId);
    expect(await peek(watch)).toBe('pending');
    // Second batch: sent after the first was answered, so after the check
    // began. It names the index to reach (its `pushed` plus one second).
    tick(sessionId);
    expect(await peek(watch)).toBe('pending');
    run(sessionId, 2);
    expect(await peek(watch)).toBe('pending');
    tick(sessionId);
    expect(await watch).toEqual({
      verdict: 'no_speech',
      // Answered on the chunk that completes the tail, two into the batch.
      evidence: { received_ms: 9800, muted_ms: 9800, unmuted_ms: 0, unmuted_rms_dbfs: null },
    });
    abort(sessionId);
  });

  // The review scenario. A recovery session: the microphone is on with no
  // user gesture, the tee's AudioContext is still suspended, and WebRTC is
  // already carrying live audio to the vendor. The participant speaks, then
  // taps mute; the tap resumes the context and chunks start at index 0, every
  // one of them muted. The words were real.
  describe('a track that does not cover the turn gives no verdict', () => {
    it('the track started after the words were spoken: not a candidate', () => {
      const sessionId = newSession('late-track');
      const spokeAt = clock;
      clock += 3000; // "I want to kill myself", captured by nothing
      run(sessionId, 8); // the tap on mute: chunks from index 0, all muted
      expect(watchForMutedTurn(sessionId, spokeAt)).toBeNull();
      // Nor when the server's estimate of the turn's start is late (the first
      // transcript fragment arrived after the track had started).
      expect(watchForMutedTurn(sessionId, clock - 500)).toBeNull();
      expect(watchForMutedTurn(sessionId, clock)).toBeNull();
      abort(sessionId);
    });

    it('the track started less than the lead margin before the turn: not a candidate', () => {
      const sessionId = newSession('short-lead');
      run(sessionId, 10); // 4 s of track
      expect(watchForMutedTurn(sessionId, clock)).toBeNull();
      abort(sessionId);
    });

    it("the track's first batch alone proves nothing: when it was sent is unbounded", () => {
      const sessionId = newSession('first-batch');
      tick(sessionId);
      clock += 10_000;
      expect(watchForMutedTurn(sessionId, clock)).toBeNull();
      abort(sessionId);
    });

    it('capture suspended mid-session while the participant spoke, then resumed muted: unknown', async () => {
      const sessionId = newSession('suspended');
      run(sessionId, 30); // 12 s captured and uploaded normally, muted
      // The tab goes to the background: the context is suspended for 4 s, the
      // microphone track is live, the participant speaks. Then they mute and
      // capture resumes: the indexes simply carry on.
      const spokeAt = clock + 500;
      clock += 4000;
      run(sessionId, 3);
      const watch = watchForMutedTurn(sessionId, spokeAt, 30);
      expect(watch).not.toBeNull();
      // Everything keeps arriving in order, all muted, well past the tail.
      run(sessionId, 8);
      expect(await peek(watch)).toBe('pending');
      expect((await watch)!.verdict).toBe('unknown');
      abort(sessionId);
    });

    it('capture suspended after the turn started and before it closed: unknown', async () => {
      const sessionId = newSession('suspended-during');
      run(sessionId, 30);
      const startedAt = clock;
      run(sessionId, 2);
      clock += 1500; // suspended
      run(sessionId, 2);
      const watch = watchForMutedTurn(sessionId, startedAt, 30);
      run(sessionId, 8);
      expect((await watch)!.verdict).toBe('unknown');
      abort(sessionId);
    });

    it('capture suspended while the check waits: unknown', async () => {
      const sessionId = newSession('suspended-waiting');
      run(sessionId, 30);
      const watch = watchForMutedTurn(sessionId, clock - 1000, 30);
      tick(sessionId);
      clock += 2000; // suspended
      run(sessionId, 8);
      expect((await watch)!.verdict).toBe('unknown');
      abort(sessionId);
    });

    it('a pause that ended well before the turn does not stand in the way of a later muted turn', async () => {
      const sessionId = newSession('old-pause');
      run(sessionId, 10);
      clock += 4000; // suspended, long before the turn
      run(sessionId, 20); // 8 s captured without a pause since
      const watch = watchForMutedTurn(sessionId, clock - 1000, 60_000);
      run(sessionId, 5);
      expect((await watch)!.verdict).toBe('no_speech');
      abort(sessionId);
    });

    it('an upload that stalled and caught up is not a pause in capture: the audio is all there', async () => {
      const sessionId = newSession('stall');
      run(sessionId, 20);
      const watch = watchForMutedTurn(sessionId, clock - 1000, 60_000);
      tick(sessionId);
      // Nothing for 2.4 s, then one batch carrying all of it.
      tick(sessionId, { count: 24 });
      expect(await peek(watch)).toBe('pending');
      run(sessionId, 3);
      expect((await watch)!.verdict).toBe('no_speech');
      abort(sessionId);
    });

    it('more audio than wall clock (a clock step, or wrong counts): unknown', async () => {
      const sessionId = newSession('clock-step');
      run(sessionId, 20);
      const watch = watchForMutedTurn(sessionId, clock - 1000, 60_000);
      tick(sessionId);
      clock -= 5000;
      tick(sessionId);
      expect((await watch)!.verdict).toBe('unknown');
      abort(sessionId);
    });

    it('chunks of different sizes (a count is not a duration): not a candidate', () => {
      const sessionId = newSession('uneven');
      run(sessionId, 20);
      tick(sessionId, { count: 1, pcm: pcmChunk(CHUNK / 2, 0) });
      run(sessionId, 4);
      expect(watchForMutedTurn(sessionId, clock - 1000)).toBeNull();
      abort(sessionId);
    });
  });

  // "Muted" is the browser's flag, read after the audio was captured. The
  // audio itself is the second factor: a disabled track is exact zeros.
  describe('a chunk flagged muted counts only when it is digital silence', () => {
    it('isDigitalSilence: zeros only', () => {
      expect(isDigitalSilence(Buffer.alloc(0))).toBe(true);
      expect(isDigitalSilence(Buffer.alloc(200_000))).toBe(true);
      const oneBit = Buffer.alloc(200_000);
      oneBit[199_999] = 1;
      expect(isDigitalSilence(oneBit)).toBe(false);
      expect(isDigitalSilence(Buffer.from(silent(), 'base64'))).toBe(true);
      expect(isDigitalSilence(Buffer.from(pcmChunk(CHUNK, 1), 'base64'))).toBe(false);
    });

    it('a muted-flagged chunk with real audio inside the window: not a candidate', () => {
      const sessionId = newSession('flag-lies');
      run(sessionId, 20);
      tick(sessionId, { pcm: voiced() }); // flagged muted, holds a voice
      run(sessionId, 20);
      expect(watchForMutedTurn(sessionId, clock - 1000)).toBeNull();
      abort(sessionId);
    });

    it('even the quietest non-zero audio under a muted flag: not a candidate', () => {
      const sessionId = newSession('flag-quiet');
      run(sessionId, 20);
      tick(sessionId, { pcm: pcmChunk(CHUNK, 1) });
      run(sessionId, 20);
      expect(watchForMutedTurn(sessionId, clock - 1000)).toBeNull();
      abort(sessionId);
    });

    it('a muted-flagged chunk with real audio arriving while the check waits: unknown', async () => {
      const sessionId = newSession('flag-lies-late');
      run(sessionId, 20);
      const watch = watchForMutedTurn(sessionId, clock - 1000, 60_000);
      tick(sessionId);
      tick(sessionId, { pcm: voiced() });
      expect((await watch)!.verdict).toBe('unknown');
      abort(sessionId);
    });

    it('one from before the window does not stand in the way of a later muted turn', async () => {
      const sessionId = newSession('flag-old');
      tick(sessionId, { pcm: voiced() });
      clock += 300_000;
      run(sessionId, 20);
      const watch = watchForMutedTurn(sessionId, clock - 1000, 60_000);
      run(sessionId, 5);
      expect((await watch)!.verdict).toBe('no_speech');
      abort(sessionId);
    });
  });

  it('waits for the chunks the browser had captured but not yet sent (pushed ahead of what arrived)', async () => {
    const sessionId = newSession('behind');
    run(sessionId, 20);
    const watch = watchForMutedTurn(sessionId, clock - 1000, 60_000);
    tick(sessionId);
    // The uploader falls three chunks behind the microphone and stays there:
    // the target is that batch's `pushed` plus the tail.
    tick(sessionId, { dt: 700, ahead: 3 });
    run(sessionId, 3, { ahead: 3 });
    expect(await peek(watch)).toBe('pending');
    tick(sessionId, { ahead: 3 });
    expect((await watch)!.verdict).toBe('no_speech');
    abort(sessionId);
  });

  it('unmuted audio arriving late, after the turn closed, means speech at once', async () => {
    const sessionId = newSession('late-speech');
    run(sessionId, 20);
    const watch = watchForMutedTurn(sessionId, clock - 1000, 60_000);
    tick(sessionId);
    // The participant had unmuted and spoken; the audio only lands now.
    tick(sessionId, { muted: false });
    expect((await watch)!.verdict).toBe('speech');
    abort(sessionId);
  });

  it('unmuted audio already inside the window: not a candidate at all', () => {
    const sessionId = newSession('recent-speech');
    tick(sessionId, { muted: false });
    run(sessionId, 75); // 30 s muted since
    expect(watchForMutedTurn(sessionId, clock - 1000)).toBeNull();
    abort(sessionId);
  });

  it('unmuted audio from before the window does not stand in the way of a later muted turn', async () => {
    const sessionId = newSession('old-speech');
    tick(sessionId, { muted: false });
    clock += 300_000;
    run(sessionId, 20);
    const watch = watchForMutedTurn(sessionId, clock - 1000, 60_000);
    run(sessionId, 5);
    expect((await watch)!.verdict).toBe('no_speech');
    abort(sessionId);
  });

  it('no participant track (recording off, not consented, nothing uploaded): not a candidate', () => {
    const sessionId = newSession('none');
    expect(watchForMutedTurn(sessionId, clock)).toBeNull();
    appendChunk(sessionId, silent(), sampleRate, 'mixed', { seq: 0 });
    clock += 10_000;
    expect(watchForMutedTurn(sessionId, clock)).toBeNull();
    abort(sessionId);
  });

  it('a track without sequence numbers (an older client): not a candidate', () => {
    const sessionId = newSession('legacy');
    for (let i = 0; i < 100; i++) {
      clock += CHUNK_MS;
      appendChunk(sessionId, silent(), sampleRate, 'participant', { muted: true, batchStart: true });
    }
    expect(watchForMutedTurn(sessionId, clock - 1000)).toBeNull();
    abort(sessionId);
  });

  it('a gap while waiting (lost chunks may have been speech): unknown, and no verdict ever again', async () => {
    const sessionId = newSession('gap');
    run(sessionId, 20);
    const watch = watchForMutedTurn(sessionId, clock - 1000, 60_000);
    tick(sessionId);
    tick(sessionId, { seq: next.get(sessionId)! + 4, dt: 800 }); // one batch never arrived
    expect((await watch)!.verdict).toBe('unknown');
    run(sessionId, 30);
    expect(watchForMutedTurn(sessionId, clock - 1000)).toBeNull();
    abort(sessionId);
  });

  it('a gap earlier in the session: not a candidate', () => {
    const sessionId = newSession('early-gap');
    tick(sessionId, { seq: 1 }); // chunk 0 never arrived
    run(sessionId, 30);
    expect(watchForMutedTurn(sessionId, clock - 1000)).toBeNull();
    abort(sessionId);
  });

  it('a repeated (retried) batch while waiting: unknown', async () => {
    const sessionId = newSession('stale');
    run(sessionId, 20);
    const watch = watchForMutedTurn(sessionId, clock - 1000, 60_000);
    tick(sessionId);
    tick(sessionId, { seq: next.get(sessionId)! - 4 }); // the same batch again
    expect((await watch)!.verdict).toBe('unknown');
    abort(sessionId);
  });

  it('one batch after the check is not enough, however much audio it carries', async () => {
    const sessionId = newSession('one-batch');
    run(sessionId, 20);
    const watch = watchForMutedTurn(sessionId, clock - 1000, 20);
    tick(sessionId, { count: 300 });
    expect(await peek(watch)).toBe('pending');
    // Nothing more arrives: the timeout answers unknown.
    expect((await watch)!.verdict).toBe('unknown');
    abort(sessionId);
  });

  it('a second batch that does not say how much the browser had captured: unknown', async () => {
    const sessionId = newSession('no-pushed');
    run(sessionId, 20);
    const watch = watchForMutedTurn(sessionId, clock - 1000, 60_000);
    tick(sessionId);
    tick(sessionId, { pushed: null });
    expect((await watch)!.verdict).toBe('unknown');
    abort(sessionId);
  });

  it('batches that never said how much the browser had captured prove no coverage: not a candidate', () => {
    const sessionId = newSession('never-pushed');
    run(sessionId, 30, { pushed: null });
    expect(watchForMutedTurn(sessionId, clock - 1000)).toBeNull();
    abort(sessionId);
  });

  it('no further audio at all (a stalled upload): unknown at the timeout', async () => {
    const sessionId = newSession('stalled');
    run(sessionId, 20);
    const watch = watchForMutedTurn(sessionId, clock - 1000, 20);
    expect((await watch)!.verdict).toBe('unknown');
    abort(sessionId);
  });

  it('the recording closing while waiting: unknown, with no evidence', async () => {
    const sessionId = newSession('closed');
    run(sessionId, 20);
    const aborted = watchForMutedTurn(sessionId, clock - 1000, 60_000);
    abort(sessionId);
    expect(await aborted).toEqual({ verdict: 'unknown', evidence: null });

    const other = newSession('finalized');
    run(other, 20);
    const finalized = watchForMutedTurn(other, clock - 1000, 60_000);
    await finalize(other);
    expect(await finalized).toEqual({ verdict: 'unknown', evidence: null });
  });

  it('several turns waiting on one track are each answered', async () => {
    const sessionId = newSession('two');
    run(sessionId, 20);
    const first = watchForMutedTurn(sessionId, clock - 1000, 60_000);
    tick(sessionId);
    const second = watchForMutedTurn(sessionId, clock - 1000, 60_000);
    run(sessionId, 4);
    expect((await first)!.verdict).toBe('no_speech');
    expect(await peek(second)).toBe('pending');
    tick(sessionId);
    expect((await second)!.verdict).toBe('no_speech');
    abort(sessionId);
  });
});
