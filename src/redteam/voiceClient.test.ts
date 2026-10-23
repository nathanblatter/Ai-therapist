// Offline unit tests for the voice pipeline's pure helpers (ai-therapist-124
// phase 2, re-ported in ai-therapist-213): backend detection, PCM framing /
// chunking / silence, the proxy message mapping, and the crisis-pipeline
// settle. The networked parts (proxy WS, TTS) are exercised only by live
// `--suite voice` runs.
import { describe, it, expect, vi } from 'vitest';

vi.mock('openai', () => ({ default: class {} }));

import {
  detectVoiceBackend,
  framePcm,
  chunkBase64Pcm,
  silencePcm,
  pcmDurationMs,
  parseGrokServerMessage,
  waitForProxyCrisisPipeline,
  VOICE_SAMPLE_RATE,
  FRAME_BYTES,
} from './voiceClient.js';
import type { CapturedEmission } from './types.js';
import { joinFragments } from './liveVoiceClient.js';

describe('detectVoiceBackend — follows system_config.ai_model like production', () => {
  it('routes grok-voice-* to the proxy and gpt-live-* to GPT-Live', () => {
    expect(detectVoiceBackend('grok-voice-3.0')).toBe('grok');
    expect(detectVoiceBackend('grok-voice-latest')).toBe('grok');
    expect(detectVoiceBackend('gpt-live-1')).toBe('live');
  });

  it('selects nothing for transcription models, Realtime ids, or empty values', () => {
    expect(detectVoiceBackend('grok-voice-transcribe-2.0')).toBeNull();
    expect(detectVoiceBackend('gpt-realtime-2.1')).toBeNull();
    expect(detectVoiceBackend(null)).toBeNull();
    expect(detectVoiceBackend('')).toBeNull();
  });
});

describe('framePcm / chunkBase64Pcm', () => {
  it('cuts 100 ms frames at the wire rate and round-trips the buffer', () => {
    expect(FRAME_BYTES).toBe(4800);
    const pcm = Buffer.from(Array.from({ length: 10_000 }, (_, i) => i % 256));
    const frames = framePcm(pcm);
    expect(frames.length).toBe(3);
    expect(frames[0].length).toBe(4800);
    expect(frames[2].length).toBe(400);
    expect(Buffer.concat(frames).equals(pcm)).toBe(true);
  });

  it('keeps frames 16-bit aligned even for odd sizes', () => {
    const pcm = Buffer.alloc(100);
    for (const c of chunkBase64Pcm(pcm, 33).slice(0, -1)) {
      expect(Buffer.from(c, 'base64').length).toBe(32);
    }
  });
});

describe('silencePcm / pcmDurationMs', () => {
  it('produces zero samples for the duration and measures it back', () => {
    const buf = silencePcm(500);
    expect(buf.length).toBe((VOICE_SAMPLE_RATE / 2) * 2);
    expect(buf.every(b => b === 0)).toBe(true);
    expect(pcmDurationMs(buf)).toBe(500);
  });
});

describe('parseGrokServerMessage — the proxy frame protocol', () => {
  it('maps ready, final transcripts, response_done, tools, close and errors', () => {
    expect(parseGrokServerMessage({ type: 'ready', model: 'grok-voice-3.0' }))
      .toEqual({ kind: 'ready', model: 'grok-voice-3.0', resumed: false });
    expect(parseGrokServerMessage({ type: 'ready', model: 'grok-voice-3.0', resumed: true }))
      .toEqual({ kind: 'ready', model: 'grok-voice-3.0', resumed: true });
    expect(parseGrokServerMessage({ type: 'link', state: 'reconnecting' })).toEqual({ kind: 'link', state: 'reconnecting' });
    expect(parseGrokServerMessage({ type: 'link', state: 'restored' })).toEqual({ kind: 'link', state: 'restored' });
    expect(parseGrokServerMessage({ type: 'transcript', role: 'user', itemId: 'u1', text: 'hello', final: true }))
      .toEqual({ kind: 'user-transcript', text: 'hello', itemId: 'u1' });
    expect(parseGrokServerMessage({ type: 'transcript', role: 'assistant', itemId: 'a1', text: 'hi there', final: true }))
      .toEqual({ kind: 'assistant-text', text: 'hi there', itemId: 'a1' });
    expect(parseGrokServerMessage({ type: 'response_done' })).toEqual({ kind: 'response-done' });
    expect(parseGrokServerMessage({ type: 'speech_started' })).toEqual({ kind: 'speech-started' });
    expect(parseGrokServerMessage({ type: 'tool_call', callId: 'c', name: 'find_worksheet', args: {} }))
      .toEqual({ kind: 'tool-call', name: 'find_worksheet' });
    expect(parseGrokServerMessage({ type: 'closed', reason: 'ended' })).toEqual({ kind: 'closed', reason: 'ended' });
    expect(parseGrokServerMessage({ type: 'error', message: 'boom' })).toEqual({ kind: 'error', message: 'boom' });
  });

  it('drops caption deltas and unknown frames', () => {
    expect(parseGrokServerMessage({ type: 'transcript', role: 'assistant', itemId: 'a1', text: 'hi', final: false }))
      .toEqual({ kind: 'other' });
    expect(parseGrokServerMessage({ type: 'clear_audio' })).toEqual({ kind: 'other' });
    expect(parseGrokServerMessage({})).toEqual({ kind: 'other' });
  });
});

describe('waitForProxyCrisisPipeline', () => {
  const fakePool = (counts: number[], latest: number) => {
    let call = 0;
    return {
      query: vi.fn(async (sql: string) => {
        if (sql.includes('COUNT(*)')) {
          const n = counts[Math.min(call++, counts.length - 1)];
          return { rows: [{ n, latest }] };
        }
        return { rows: [{ risk_score: latest }] };
      }),
    };
  };

  it('returns as soon as every transcribed turn has a risk row (score 0: no emissions needed)', async () => {
    const pool = fakePool([0, 1], 0);
    await waitForProxyCrisisPipeline(pool, [], 'grok_x', 1, 0, 5_000);
    expect(pool.query).toHaveBeenCalled();
  });

  it('waits for the crisis-detected emission after a medium score, bounded', async () => {
    const pool = fakePool([1], 60);
    const emissions: CapturedEmission[] = [];
    const started = Date.now();
    setTimeout(() => emissions.push({ room: 'session:grok_x', event: 'session:crisis-detected', payload: { sessionId: 'grok_x' }, ts: new Date() }), 300);
    await waitForProxyCrisisPipeline(pool, emissions, 'grok_x', 1, 0, 5_000);
    const took = Date.now() - started;
    expect(took).toBeGreaterThanOrEqual(300);
    expect(took).toBeLessThan(4_000);
  });

  it('throws when scoring never lands', async () => {
    const pool = fakePool([0], 0);
    await expect(waitForProxyCrisisPipeline(pool, [], 'grok_x', 1, 0, 600)).rejects.toThrow(/timed out/);
  });
});

describe('joinFragments — GPT-Live transcript assembly', () => {
  it('orders by start_ms and concatenates exactly as received', () => {
    expect(joinFragments([
      { text: ' about killing myself.', startMs: 1200 },
      { text: "I've been thinking", startMs: 400 },
    ])).toBe("I've been thinking about killing myself.");
  });

  it('is empty for no fragments', () => {
    expect(joinFragments([])).toBe('');
  });
});
