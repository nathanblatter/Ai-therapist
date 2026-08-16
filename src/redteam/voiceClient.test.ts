// Offline unit tests for the voice pipeline's pure helpers (ai-therapist-124
// phase 2): PCM chunking, silence padding, and Realtime event mapping. The
// networked parts (WS, TTS) are exercised only by live `--suite voice` runs.
import { describe, it, expect } from 'vitest';
import { chunkBase64Pcm, silencePcm, parseRealtimeEvent, VOICE_SAMPLE_RATE } from './voiceClient.js';

describe('chunkBase64Pcm', () => {
  it('round-trips a buffer through base64 frames', () => {
    const pcm = Buffer.from(Array.from({ length: 1000 }, (_, i) => i % 256));
    const chunks = chunkBase64Pcm(pcm, 256);
    const rejoined = Buffer.concat(chunks.map(c => Buffer.from(c, 'base64')));
    expect(rejoined.equals(pcm)).toBe(true);
    expect(chunks.length).toBe(4);
  });

  it('keeps frames 16-bit aligned even for odd chunk sizes', () => {
    const pcm = Buffer.alloc(100);
    const chunks = chunkBase64Pcm(pcm, 33); // odd → should chunk by 32
    for (const c of chunks.slice(0, -1)) {
      expect(Buffer.from(c, 'base64').length % 2).toBe(0);
    }
  });
});

describe('silencePcm', () => {
  it('produces the right number of zero samples for the duration', () => {
    const buf = silencePcm(500);
    expect(buf.length).toBe((VOICE_SAMPLE_RATE / 2) * 2); // 0.5s of 16-bit samples
    expect(buf.every(b => b === 0)).toBe(true);
  });
});

describe('parseRealtimeEvent', () => {
  it('maps GA and beta assistant-audio event names', () => {
    expect(parseRealtimeEvent({ type: 'response.output_audio.delta', delta: 'QUJD' }))
      .toEqual({ kind: 'assistant-audio', b64: 'QUJD' });
    expect(parseRealtimeEvent({ type: 'response.audio.delta', delta: 'QUJD' }))
      .toEqual({ kind: 'assistant-audio', b64: 'QUJD' });
  });

  it('maps transcripts, commit, done, and error', () => {
    expect(parseRealtimeEvent({ type: 'response.output_audio_transcript.done', transcript: 'hi there' }))
      .toEqual({ kind: 'assistant-text', text: 'hi there' });
    expect(parseRealtimeEvent({ type: 'conversation.item.input_audio_transcription.completed', transcript: 'hello' }))
      .toEqual({ kind: 'user-transcript', text: 'hello' });
    expect(parseRealtimeEvent({ type: 'input_audio_buffer.committed' })).toEqual({ kind: 'committed' });
    expect(parseRealtimeEvent({ type: 'response.done' })).toEqual({ kind: 'response-done' });
    expect(parseRealtimeEvent({ type: 'error', error: { message: 'boom' } }))
      .toEqual({ kind: 'error', message: 'boom' });
  });

  it('treats unknown or malformed events as inert', () => {
    expect(parseRealtimeEvent({ type: 'session.updated' })).toEqual({ kind: 'other' });
    expect(parseRealtimeEvent({ type: 'response.output_audio.delta' })).toEqual({ kind: 'other' });
    expect(parseRealtimeEvent({})).toEqual({ kind: 'other' });
  });
});
