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

const { appendChunk, finalize, abort, hasRecording, assessParticipantTrack, pcm16RmsDbfs, pcm16SumSquares } =
  await import('./recorder.service.js');

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

    expect(ensureBucketMock).toHaveBeenCalledOnce();
    expect(putObjectMock).toHaveBeenCalledOnce();

    const [key, body, contentType] = putObjectMock.mock.calls[0];
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
    expect(putObjectMock).toHaveBeenCalledOnce();
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
    expect(keys).toEqual([`sessions/${sessionId}/participant.wav`, `sessions/${sessionId}/recording.wav`]);
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
    expect(putObjectMock).toHaveBeenCalledOnce();
  });

  it('a participant-track upload failure does not mark the mixed track failed', async () => {
    const sessionId = `sess-dual-fail-${Date.now()}`;
    appendChunk(sessionId, pcmChunk(4096), 48000, 'mixed');
    appendChunk(sessionId, pcmChunk(4096), 48000, 'participant');
    putObjectMock
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
    putObjectMock.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('minio hiccup'));
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

  const dataBytes = () => (putObjectMock.mock.calls[0][1] as Buffer).readUInt32LE(40);

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
    expect(dataBytes()).toBe(4 * 200);
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
