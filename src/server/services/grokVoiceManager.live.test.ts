import { describe, it, expect, vi, beforeAll } from 'vitest';

// LIVE integration test for the Grok Voice proxy against the real xAI API.
//
// Skipped unless XAI_LIVE_TEST=1 and XAI_API_KEY are set, so CI never spends
// money or depends on the network. Run it by hand after touching the proxy:
//
//   XAI_LIVE_TEST=1 XAI_API_KEY=xai-... npx vitest run src/server/services/grokVoiceManager.live.test.ts
//
// What it proves that the unit tests cannot: the session config the real
// builder produces is accepted by xAI, the resolved model comes back, the
// opening line makes the model speak (audio frames reach the fake browser),
// a real function call round-trips through the registry projection, and
// billable seconds arrive. Costs a few cents per run. DB and pipeline
// side effects are mocked exactly as in the unit test.

const LIVE = process.env.XAI_LIVE_TEST === '1' && Boolean(process.env.XAI_API_KEY);

const {
  queryMock, insertMessagesBatchMock, recordLlmUsageMock, recordLiveUsageMock,
  runCrisisPipelineMock, executeToolMock,
} = vi.hoisted(() => ({
  queryMock: vi.fn().mockResolvedValue({ rows: [] }),
  insertMessagesBatchMock: vi.fn().mockResolvedValue([{ message_id: 1 }]),
  recordLlmUsageMock: vi.fn().mockResolvedValue(undefined),
  recordLiveUsageMock: vi.fn().mockResolvedValue(undefined),
  runCrisisPipelineMock: vi.fn().mockResolvedValue({ severity: 'none' }),
  executeToolMock: vi.fn().mockResolvedValue({ title: 'Thought Record', id: 'w1' }),
}));

vi.mock('../config/db.js', () => ({ pool: { query: queryMock } }));
vi.mock('../db/index.js', () => ({
  insertMessagesBatch: insertMessagesBatchMock,
  insertToolInvocation: vi.fn().mockResolvedValue(undefined),
  recordLlmUsage: recordLlmUsageMock,
}));
vi.mock('../db/liveUsage.queries.js', () => ({ recordLiveUsage: recordLiveUsageMock }));
vi.mock('./crisisPipeline.service.js', () => ({ runCrisisPipeline: runCrisisPipelineMock }));
vi.mock('./toolRegistry.service.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./toolRegistry.service.js')>();
  return { ...actual, toolRegistry: { executeTool: executeToolMock } };
});
vi.mock('../utils/adminBroadcast.js', () => ({ broadcastAdminEventForSession: vi.fn() }));
vi.mock('../utils/phaseGuidance.js', () => ({ buildPhaseNudgeSchedule: vi.fn().mockResolvedValue([]) }));
vi.mock('./sessionLifecycle.service.js', () => ({ serverEndSession: vi.fn().mockResolvedValue(true) }));

import { EventEmitter } from 'node:events';
import { grokVoiceManager } from './grokVoiceManager.service.js';
import { buildGrokSessionConfig } from '../utils/grokVoiceConfig.js';
import type { ToolDefinition } from './toolRegistry.service.js';
import type { GrokServerMessage } from '../../shared/grokVoiceProtocol.js';

/** A fake browser socket that records what the proxy sends it. */
class FakeClient extends EventEmitter {
  readyState = 1;
  messages: GrokServerMessage[] = [];
  audioBytes = 0;
  send = (data: string | Buffer) => {
    if (Buffer.isBuffer(data)) this.audioBytes += data.length;
    else this.messages.push(JSON.parse(data) as GrokServerMessage);
  };
  close = () => { this.readyState = 3; };
}

const TOOL_DEFS: ToolDefinition[] = [{
  type: 'function',
  name: 'find_worksheet',
  description: 'Find a worksheet by topic',
  parameters: { type: 'object', properties: { topic: { type: 'string' } }, required: ['topic'] },
} as unknown as ToolDefinition];

async function speakPcm(client: FakeClient, text: string): Promise<void> {
  // Real speech via xAI TTS so server VAD has something to detect, streamed at
  // real-time pace in 100 ms frames, followed by ~800 ms of silence.
  const res = await fetch('https://api.x.ai/v1/tts', {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.XAI_API_KEY}`, 'content-type': 'application/json' },
    body: JSON.stringify({ text, voice_id: 'ara', language: 'en', output_format: { codec: 'pcm', sample_rate: 24000 } }),
  });
  if (!res.ok) throw new Error(`TTS failed: ${res.status}`);
  const pcm = Buffer.from(await res.arrayBuffer());
  const frame = 4800;
  for (let off = 0; off < pcm.length; off += frame) {
    client.emit('message', pcm.subarray(off, Math.min(off + frame, pcm.length)), true);
    await new Promise(r => setTimeout(r, 100));
  }
  for (let i = 0; i < 8; i++) {
    client.emit('message', Buffer.alloc(frame), true);
    await new Promise(r => setTimeout(r, 100));
  }
}

async function waitFor(pred: () => boolean, timeoutMs: number, what: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pred()) return;
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error(`timed out waiting for ${what}`);
}

describe.skipIf(!LIVE)('Grok Voice proxy — LIVE against api.x.ai', () => {
  const SESSION = 'grok_00000000-0000-4000-8000-000000000001';
  const client = new FakeClient();

  beforeAll(() => {
    (global as unknown as { io: unknown }).io = undefined;
  });

  it('configures, speaks first, transcribes speech, round-trips a tool call, and meters', async () => {
    grokVoiceManager.registerPending(SESSION, {
      model: 'grok-voice-latest',
      apiKey: process.env.XAI_API_KEY!,
      sessionConfig: buildGrokSessionConfig({
        model: 'grok-voice-latest',
        voice: 'eve',
        language: 'en',
        languageName: 'English',
        systemPrompt: 'You are a calm, warm counselor. Reply in one short sentence. If the participant asks for a worksheet, call find_worksheet.',
        toolDefs: TOOL_DEFS,
      }),
      openingPrompt: "Say this phrase exactly: 'Hello, I am glad you are here.' Say it immediately, then pause and listen.",
    });

    await grokVoiceManager.attachClient(SESSION, client as unknown as import('ws').default);
    await waitFor(() => client.messages.some(m => m.type === 'ready'), 30_000, 'ready');
    const ready = client.messages.find(m => m.type === 'ready') as { model: string };
    expect(ready.model).toMatch(/^grok-voice/);
    expect(queryMock).toHaveBeenCalledWith(expect.stringContaining('UPDATE session_configurations'), [ready.model, SESSION]);

    // Opening line produced audio and a finalized assistant transcript.
    await waitFor(() => client.messages.some(m => m.type === 'response_done'), 45_000, 'opening response');
    expect(client.audioBytes).toBeGreaterThan(10_000);
    expect(insertMessagesBatchMock).toHaveBeenCalledWith([expect.objectContaining({ role: 'assistant', message_type: 'response' })]);

    // Participant speech → whole-turn transcript → crisis pipeline.
    await speakPcm(client, 'Could you find me a worksheet about anxious thoughts?');
    await waitFor(() => runCrisisPipelineMock.mock.calls.length > 0, 45_000, 'user turn');
    const turn = runCrisisPipelineMock.mock.calls[0][0] as { content: string };
    expect(turn.content.toLowerCase()).toContain('worksheet');

    // The tool executes server-side and the browser gets the UI notice.
    await waitFor(() => executeToolMock.mock.calls.length > 0, 45_000, 'tool call');
    expect(executeToolMock).toHaveBeenCalledWith('find_worksheet', expect.objectContaining({ topic: expect.any(String) }), { sessionId: SESSION, channel: 'realtime' });
    expect(client.messages.some(m => m.type === 'tool_call' && m.name === 'find_worksheet')).toBe(true);

    // Metering: cumulative billable seconds and per-response tokens.
    await waitFor(() => recordLiveUsageMock.mock.calls.length >= 2, 45_000, 'usage');
    const seconds = recordLiveUsageMock.mock.calls.map(c => c[2] as number);
    for (let i = 1; i < seconds.length; i++) expect(seconds[i]).toBeGreaterThanOrEqual(seconds[i - 1]);
    expect(recordLlmUsageMock).toHaveBeenCalledWith(SESSION, 'grok_voice', ready.model, expect.any(Number), expect.any(Number));

    await grokVoiceManager.disconnect(SESSION);
    expect(client.messages.some(m => m.type === 'closed')).toBe(true);
    expect(recordLiveUsageMock).toHaveBeenLastCalledWith(SESSION, ready.model, expect.any(Number), { finalized: true, closeReason: 'close_requested' });
  }, 240_000);
});
