import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock the storage + db boundaries so the test exercises the real PCM→WAV
// assembly and temp-file lifecycle without touching MinIO or Postgres.
const { putObjectMock, ensureBucketMock, setRecordingMock } = vi.hoisted(() => ({
  putObjectMock: vi.fn(),
  ensureBucketMock: vi.fn(),
  setRecordingMock: vi.fn(),
}));

vi.mock('../config/objectStorage.js', () => ({
  ensureBucket: ensureBucketMock,
  putObject: putObjectMock,
  RECORDINGS_BUCKET: 'test-bucket',
}));

vi.mock('../db/recording.queries.js', () => ({
  setSessionRecording: setRecordingMock,
}));

const { appendChunk, finalize, abort, hasRecording } = await import('./recorder.service.js');

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
    expect(setRecordingMock).toHaveBeenCalledWith(sessionId, expect.objectContaining({
      objectKey: `sessions/${sessionId}/recording.wav`,
      status: 'ready',
      durationMs: 256,
      sampleRate,
    }));

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

  it('abort discards the buffer without uploading', async () => {
    const sessionId = `sess-abort-${Date.now()}`;
    appendChunk(sessionId, pcmChunk(1024), 48000);
    expect(hasRecording(sessionId)).toBe(true);

    abort(sessionId);

    expect(hasRecording(sessionId)).toBe(false);
    await finalize(sessionId); // nothing left to finalize
    expect(putObjectMock).not.toHaveBeenCalled();
  });
});
