import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Covers the Grok Voice proxy (docs/grok-voice.md). Priorities, in order of risk:
//
//   1. The crisis pipeline join point: every completed user transcript is
//      persisted AND scored, including when the DB insert fails.
//   2. Usage metering: billable_audio_seconds is a CUMULATIVE snapshot —
//      assigned, never summed — and token usage is deduped per response id.
//   3. Tool execution: server-side, one result per call, response.create only
//      once no calls are outstanding, plus the UI-only notice to the browser.
//   4. Audio relay in both directions, and barge-in propagation.
//   5. The control surface (steer / update / interrupt / trigger / disconnect).
//   6. Failure handling: an upstream drop fails closed; a browser that never
//      attaches or drops without ending gets the session ended.
//
// Both sockets (xAI upstream and the browser client) are EventEmitter fakes.

const {
  queryMock, insertMessagesBatchMock, insertToolInvocationMock, recordLlmUsageMock,
  recordLiveUsageMock, runCrisisPipelineMock, executeToolMock, broadcastMock,
  serverEndSessionMock, phaseScheduleMock,
} = vi.hoisted(() => ({
  queryMock: vi.fn(),
  insertMessagesBatchMock: vi.fn(),
  insertToolInvocationMock: vi.fn(),
  recordLlmUsageMock: vi.fn(),
  recordLiveUsageMock: vi.fn(),
  runCrisisPipelineMock: vi.fn(),
  executeToolMock: vi.fn(),
  broadcastMock: vi.fn(),
  serverEndSessionMock: vi.fn(),
  phaseScheduleMock: vi.fn(),
}));

// vi.hoisted runs before ES imports are initialised, so the base class is
// loaded inside it rather than imported at module scope.
const { FakeWs, upstreams } = await vi.hoisted(async () => {
  const { EventEmitter } = await import('node:events');
  class FakeWs extends EventEmitter {
    static OPEN = 1;
    static CONNECTING = 0;
    readyState = 1;
    url: string;
    send = vi.fn();
    close = vi.fn(() => { this.readyState = 3; });
    ping = vi.fn();
    terminate = vi.fn();
    constructor(url = '') {
      super();
      this.url = url;
    }
  }
  return { FakeWs, upstreams: [] as InstanceType<typeof FakeWs>[] };
});

vi.mock('ws', () => {
  const ctor = vi.fn((url: string) => {
    const ws = new FakeWs(url);
    upstreams.push(ws);
    // Open on the next microtask, after the manager has registered listeners.
    queueMicrotask(() => ws.emit('open'));
    return ws;
  });
  (ctor as unknown as { OPEN: number; CONNECTING: number }).OPEN = 1;
  (ctor as unknown as { OPEN: number; CONNECTING: number }).CONNECTING = 0;
  return { default: ctor };
});

vi.mock('../config/db.js', () => ({ pool: { query: queryMock } }));
vi.mock('../db/index.js', () => ({
  insertMessagesBatch: insertMessagesBatchMock,
  insertToolInvocation: insertToolInvocationMock,
  recordLlmUsage: recordLlmUsageMock,
}));
vi.mock('../db/liveUsage.queries.js', () => ({ recordLiveUsage: recordLiveUsageMock }));
vi.mock('./crisisPipeline.service.js', () => ({ runCrisisPipeline: runCrisisPipelineMock }));
vi.mock('./toolRegistry.service.js', () => ({
  toolRegistry: { executeTool: executeToolMock },
  toRealtimeTools: (defs: unknown[]) => defs,
}));
vi.mock('../utils/adminBroadcast.js', () => ({ broadcastAdminEventForSession: broadcastMock }));
vi.mock('../utils/phaseGuidance.js', () => ({ buildPhaseNudgeSchedule: phaseScheduleMock }));
vi.mock('./sessionLifecycle.service.js', () => ({ serverEndSession: serverEndSessionMock }));

import { grokVoiceManager } from './grokVoiceManager.service.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Internal = any;
const gm = grokVoiceManager as unknown as Internal;

const SESSION = 'grok_11111111-2222-3333-4444-555555555555';
const SESSION_CONFIG = { instructions: 'PROMPT', voice: 'eve', tools: [] };

function sent(ws: InstanceType<typeof FakeWs>): Array<Record<string, Internal>> {
  return ws.send.mock.calls
    .filter((c: unknown[]) => typeof c[0] === 'string')
    .map((c: unknown[]) => JSON.parse(c[0] as string));
}

function binarySent(ws: InstanceType<typeof FakeWs>): Buffer[] {
  return ws.send.mock.calls.filter((c: unknown[]) => Buffer.isBuffer(c[0])).map((c: unknown[]) => c[0] as Buffer);
}

async function flush(): Promise<void> {
  for (let i = 0; i < 6; i++) await vi.advanceTimersByTimeAsync(0);
}

/** Register, attach a fake browser socket, and bring the upstream to ready. */
async function bringUp(opts: { openingPrompt?: string | null } = {}): Promise<{
  client: InstanceType<typeof FakeWs>; upstream: InstanceType<typeof FakeWs>;
}> {
  grokVoiceManager.registerPending(SESSION, {
    model: 'grok-voice-latest',
    apiKey: 'xai-test',
    sessionConfig: SESSION_CONFIG,
    openingPrompt: opts.openingPrompt === undefined ? 'OPENING' : opts.openingPrompt,
  });
  const client = new FakeWs();
  await grokVoiceManager.attachClient(SESSION, client as unknown as import('ws').default);
  const upstream = upstreams[upstreams.length - 1];
  upstream.emit('message', Buffer.from(JSON.stringify({
    type: 'session.created', session: { id: 'x', model: 'grok-voice-think-fast-2.0' },
  })));
  upstream.emit('message', Buffer.from(JSON.stringify({ type: 'session.updated', session: SESSION_CONFIG })));
  await flush();
  return { client, upstream };
}

function fire(upstream: InstanceType<typeof FakeWs>, event: Record<string, unknown>): void {
  upstream.emit('message', Buffer.from(JSON.stringify(event)));
}

beforeEach(() => {
  vi.useFakeTimers();
  (global as unknown as { io: unknown }).io = { to: () => ({ emit: vi.fn() }) };
  gm.sessions.clear();
  gm.endedSessions.clear();
  upstreams.length = 0;
  queryMock.mockReset().mockResolvedValue({ rows: [] });
  insertMessagesBatchMock.mockReset().mockResolvedValue([{ message_id: 42 }]);
  insertToolInvocationMock.mockReset().mockResolvedValue(undefined);
  recordLlmUsageMock.mockReset().mockResolvedValue(undefined);
  recordLiveUsageMock.mockReset().mockResolvedValue(undefined);
  runCrisisPipelineMock.mockReset().mockResolvedValue({ severity: 'none' });
  executeToolMock.mockReset().mockResolvedValue({ ok: true });
  broadcastMock.mockReset().mockResolvedValue(undefined);
  serverEndSessionMock.mockReset().mockResolvedValue(true);
  phaseScheduleMock.mockReset().mockResolvedValue([]);
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  (global as unknown as { io: unknown }).io = undefined;
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('bring-up', () => {
  it('dials xAI only when the browser attaches, configures the session, pins the resolved model, and speaks first', async () => {
    grokVoiceManager.registerPending(SESSION, {
      model: 'grok-voice-latest', apiKey: 'xai-test', sessionConfig: SESSION_CONFIG, openingPrompt: 'OPENING',
    });
    expect(upstreams).toHaveLength(0);
    expect(grokVoiceManager.owns(SESSION)).toBe(true);
    expect(grokVoiceManager.isConnected(SESSION)).toBe(false);

    const { client, upstream } = await bringUp();
    expect(upstream.url).toBe('wss://api.x.ai/v1/realtime?model=grok-voice-latest');

    const events = sent(upstream);
    expect(events[0]).toEqual({ type: 'session.update', session: SESSION_CONFIG });
    // Opening line: a system item + a forced response, server-authored.
    expect(events[1]).toMatchObject({ type: 'conversation.item.create', item: { role: 'system' } });
    expect(events[1].item.content[0].text).toBe('OPENING');
    expect(events[2]).toEqual({ type: 'response.create' });

    expect(sent(client)[0]).toEqual({ type: 'ready', model: 'grok-voice-think-fast-2.0' });
    expect(queryMock).toHaveBeenCalledWith(
      expect.stringContaining('UPDATE session_configurations SET ai_model'),
      ['grok-voice-think-fast-2.0', SESSION],
    );
    expect(grokVoiceManager.isConnected(SESSION)).toBe(true);
    expect(grokVoiceManager.getActiveConnections()).toEqual([SESSION]);
  });

  it('refuses an attach for an unknown session and a second browser for the same one', async () => {
    const stray = new FakeWs();
    await grokVoiceManager.attachClient('grok_unknown', stray as unknown as import('ws').default);
    expect(stray.close).toHaveBeenCalledWith(4404, 'unknown session');

    await bringUp();
    const second = new FakeWs();
    await grokVoiceManager.attachClient(SESSION, second as unknown as import('ws').default);
    expect(second.close).toHaveBeenCalledWith(4409, 'already attached');
    expect(upstreams).toHaveLength(1);
  });

  it('ends a session whose browser never attaches', async () => {
    grokVoiceManager.registerPending(SESSION, {
      model: 'grok-voice-latest', apiKey: 'xai-test', sessionConfig: SESSION_CONFIG, openingPrompt: null,
    });
    await vi.advanceTimersByTimeAsync(46_000);
    expect(serverEndSessionMock).toHaveBeenCalledWith(SESSION, expect.objectContaining({
      endedBy: 'system', reason: 'client_never_connected',
    }));
    expect(upstreams).toHaveLength(0);
  });
});

describe('participant turns → crisis pipeline', () => {
  it('persists the whole transcript as a voice turn, scores it, and relays it', async () => {
    const { client, upstream } = await bringUp();
    fire(upstream, {
      type: 'conversation.item.input_audio_transcription.completed',
      item_id: 'item_1', transcript: "  I don't want to be here anymore.  ",
    });
    await flush();

    expect(insertMessagesBatchMock).toHaveBeenCalledWith([expect.objectContaining({
      session_id: SESSION, role: 'user', message_type: 'voice',
      content: "I don't want to be here anymore.",
      metadata: expect.objectContaining({ channel: 'grok', item_id: 'item_1' }),
    })]);
    expect(runCrisisPipelineMock).toHaveBeenCalledWith(
      { sessionId: SESSION, messageId: 42, content: "I don't want to be here anymore." },
      'realtime',
    );
    expect(sent(client)).toContainEqual({
      type: 'transcript', role: 'user', itemId: 'item_1', text: "I don't want to be here anymore.", final: true,
    });
    expect(broadcastMock).toHaveBeenCalledWith(expect.anything(), 'sideband:transcript',
      expect.objectContaining({ sessionId: SESSION, role: 'user', final: true, itemId: 'item_1' }), SESSION);
  });

  it('still runs the crisis pipeline when the DB insert fails', async () => {
    const { upstream } = await bringUp();
    insertMessagesBatchMock.mockRejectedValueOnce(new Error('db down'));
    fire(upstream, { type: 'conversation.item.input_audio_transcription.completed', item_id: 'i', transcript: 'help' });
    await flush();
    expect(runCrisisPipelineMock).toHaveBeenCalledWith({ sessionId: SESSION, messageId: null, content: 'help' }, 'realtime');
  });

  it('relays the cumulative in-progress transcript as a non-final caption only', async () => {
    const { client, upstream } = await bringUp();
    fire(upstream, { type: 'conversation.item.input_audio_transcription.updated', item_id: 'i', transcript: 'I have been' });
    await flush();
    expect(sent(client)).toContainEqual({ type: 'transcript', role: 'user', itemId: 'i', text: 'I have been', final: false });
    expect(insertMessagesBatchMock).not.toHaveBeenCalledWith([expect.objectContaining({ role: 'user' })]);
    expect(runCrisisPipelineMock).not.toHaveBeenCalled();
  });
});

describe('assistant turns', () => {
  it('streams deltas to the browser and persists one row per item on .done', async () => {
    const { client, upstream } = await bringUp();
    fire(upstream, { type: 'response.output_audio_transcript.delta', item_id: 'a1', delta: "I'm sorry " });
    fire(upstream, { type: 'response.output_audio_transcript.delta', item_id: 'a1', delta: 'to hear that.' });
    fire(upstream, { type: 'response.output_audio_transcript.done', item_id: 'a1', transcript: "I'm sorry to hear that." });
    await flush();

    const toClient = sent(client).filter(m => m.type === 'transcript' && m.role === 'assistant');
    expect(toClient).toEqual([
      { type: 'transcript', role: 'assistant', itemId: 'a1', text: "I'm sorry ", final: false },
      { type: 'transcript', role: 'assistant', itemId: 'a1', text: 'to hear that.', final: false },
      { type: 'transcript', role: 'assistant', itemId: 'a1', text: "I'm sorry to hear that.", final: true },
    ]);
    const assistantRows = insertMessagesBatchMock.mock.calls
      .map((c: unknown[]) => (c[0] as Array<Record<string, unknown>>)[0])
      .filter(r => r.role === 'assistant');
    expect(assistantRows).toHaveLength(1);
    expect(assistantRows[0]).toMatchObject({ message_type: 'response', content: "I'm sorry to hear that." });
  });

  it('closes a half-spoken turn on barge-in and tells the browser to drop playback', async () => {
    const { client, upstream } = await bringUp();
    fire(upstream, { type: 'response.output_audio_transcript.delta', item_id: 'a1', delta: 'Let me explain how' });
    fire(upstream, { type: 'input_audio_buffer.speech_started', item_id: 'u2' });
    await flush();
    expect(sent(client)).toContainEqual({ type: 'speech_started' });
    expect(sent(client)).toContainEqual({ type: 'transcript', role: 'assistant', itemId: 'a1', text: 'Let me explain how', final: true });
    expect(insertMessagesBatchMock).toHaveBeenCalledWith([expect.objectContaining({ role: 'assistant', content: 'Let me explain how' })]);
  });
});

describe('audio relay', () => {
  it('forwards microphone frames as base64 appends once ready, and never before', async () => {
    grokVoiceManager.registerPending(SESSION, {
      model: 'grok-voice-latest', apiKey: 'xai-test', sessionConfig: SESSION_CONFIG, openingPrompt: null,
    });
    const client = new FakeWs();
    await grokVoiceManager.attachClient(SESSION, client as unknown as import('ws').default);
    const upstream = upstreams[0];
    client.emit('message', Buffer.from([1, 2, 3, 4]), true); // before session.updated
    expect(sent(upstream).some(e => e.type === 'input_audio_buffer.append')).toBe(false);

    fire(upstream, { type: 'session.updated', session: {} });
    await flush();
    client.emit('message', Buffer.from([1, 2, 3, 4]), true);
    expect(sent(upstream)).toContainEqual({ type: 'input_audio_buffer.append', audio: Buffer.from([1, 2, 3, 4]).toString('base64') });
  });

  it('decodes assistant audio deltas into binary frames for the browser', async () => {
    const { client, upstream } = await bringUp();
    const pcm = Buffer.from([0, 1, 2, 3, 4, 5]);
    fire(upstream, { type: 'response.output_audio.delta', delta: pcm.toString('base64') });
    await flush();
    expect(binarySent(client)).toEqual([pcm]);
  });
});

describe('usage metering', () => {
  it('assigns cumulative billable seconds (never sums) and dedupes token rows per response', async () => {
    const { upstream } = await bringUp();
    const done = (id: string, secs: number) => fire(upstream, {
      type: 'response.done', response: { id },
      usage: { input_tokens: 10, output_tokens: 20, billable_audio_seconds: secs },
    });
    done('r1', 7); await flush();
    done('r2', 9); await flush();
    done('r2', 9); await flush(); // replay
    done('r3', 8); await flush(); // out-of-order lower snapshot must not move it backwards

    const seconds = recordLiveUsageMock.mock.calls.map((c: unknown[]) => c[2]);
    expect(seconds).toEqual([7, 9, 9, 9]);
    expect(recordLiveUsageMock).toHaveBeenLastCalledWith(SESSION, 'grok-voice-think-fast-2.0', 9, { finalized: false });
    expect(grokVoiceManager.getUsageSeconds(SESSION)).toBe(9);
    expect(recordLlmUsageMock).toHaveBeenCalledTimes(3);
    expect(recordLlmUsageMock).toHaveBeenCalledWith(SESSION, 'grok_voice', 'grok-voice-think-fast-2.0', 10, 20);
  });

  it('confirms final usage on disconnect', async () => {
    const { upstream } = await bringUp();
    fire(upstream, { type: 'response.done', response: { id: 'r1' }, usage: { billable_audio_seconds: 12 } });
    await flush();
    await grokVoiceManager.disconnect(SESSION);
    expect(recordLiveUsageMock).toHaveBeenLastCalledWith(SESSION, 'grok-voice-think-fast-2.0', 12, {
      finalized: true, closeReason: 'close_requested',
    });
  });
});

describe('tool execution', () => {
  it('executes server-side, returns one output, then continues the response; notifies the browser for UI', async () => {
    const { client, upstream } = await bringUp();
    executeToolMock.mockResolvedValueOnce({ title: 'Thought Record' });
    fire(upstream, {
      type: 'response.function_call_arguments.done',
      call_id: 'call_1', name: 'find_worksheet', arguments: '{"topic":"anxiety"}',
    });
    await flush();

    expect(executeToolMock).toHaveBeenCalledWith('find_worksheet', { topic: 'anxiety' }, { sessionId: SESSION, channel: 'realtime' });
    const events = sent(upstream);
    const outputIdx = events.findIndex(e => e.type === 'conversation.item.create' && e.item?.type === 'function_call_output');
    expect(outputIdx).toBeGreaterThan(0);
    expect(events[outputIdx].item).toEqual({
      type: 'function_call_output', call_id: 'call_1', output: JSON.stringify({ title: 'Thought Record' }),
    });
    expect(events[outputIdx + 1]).toEqual({ type: 'response.create' });
    expect(sent(client)).toContainEqual({ type: 'tool_call', callId: 'call_1', name: 'find_worksheet', args: { topic: 'anxiety' } });
    expect(insertToolInvocationMock).toHaveBeenCalledWith(SESSION, 'find_worksheet', { topic: 'anxiety' }, true);
  });

  it('returns a failure payload when the tool throws, and still continues', async () => {
    const { upstream } = await bringUp();
    executeToolMock.mockRejectedValueOnce(new Error('boom'));
    fire(upstream, { type: 'response.function_call_arguments.done', call_id: 'c', name: 'run_risk_check', arguments: '{}' });
    await flush();
    const out = sent(upstream).find(e => e.item?.type === 'function_call_output');
    expect(JSON.parse(out!.item.output)).toEqual({ error: 'boom', success: false });
    expect(insertToolInvocationMock).toHaveBeenCalledWith(SESSION, 'run_risk_check', null, false);
  });
});

describe('control surface', () => {
  it('steers with system items, updates the session, interrupts, and pins tool_choice for one response', async () => {
    const { client, upstream } = await bringUp({ openingPrompt: null });
    const before = sent(upstream).length;

    expect(await grokVoiceManager.tryInject(SESSION, 'system', 'GUIDANCE', false)).toBe(true);
    await grokVoiceManager.updateSession(SESSION, { instructions: 'NEW' });
    await grokVoiceManager.interrupt(SESSION);
    await grokVoiceManager.triggerTool(SESSION, 'administer_scale', { scale: 'phq9' });
    await grokVoiceManager.createResponse(SESSION, { instructions: 'say hi' });

    const events = sent(upstream).slice(before);
    expect(events[0]).toMatchObject({ type: 'conversation.item.create', item: { role: 'system', content: [{ type: 'input_text', text: 'GUIDANCE' }] } });
    expect(events[1]).toEqual({ type: 'session.update', session: { instructions: 'NEW' } });
    expect(events[2]).toEqual({ type: 'response.cancel' });
    expect(sent(client)).toContainEqual({ type: 'clear_audio' });
    expect(events[3]).toEqual({ type: 'session.update', session: { tool_choice: { type: 'function', name: 'administer_scale' } } });
    expect(events[4].item.content[0].text).toContain('administer_scale');
    expect(events[4].item.content[0].text).toContain('"scale":"phq9"');
    expect(events[5]).toEqual({ type: 'response.create' });
    expect(events[6]).toEqual({ type: 'response.create', response: { instructions: 'say hi' } });

    // The pin is released on the next response.done, not left for the session.
    fire(upstream, { type: 'response.done', response: { id: 'r' }, usage: {} });
    await flush();
    expect(sent(upstream)).toContainEqual({ type: 'session.update', session: { tool_choice: 'auto' } });
  });

  it('reports an undeliverable steer instead of throwing', async () => {
    expect(await grokVoiceManager.tryInject('grok_nope', 'system', 'x', false)).toBe(false);
    await expect(grokVoiceManager.injectMessage('grok_nope', 'system', 'x', false)).rejects.toThrow('not active');
  });

  it('disconnect tells the browser, closes upstream, and forgets the session', async () => {
    const { client, upstream } = await bringUp();
    await grokVoiceManager.disconnect(SESSION);
    expect(sent(client)).toContainEqual({ type: 'closed', reason: 'ended' });
    expect(upstream.close).toHaveBeenCalledWith(1000, 'Session ended');
    expect(client.close).toHaveBeenCalledWith(1000, 'Session ended');
    expect(grokVoiceManager.owns(SESSION)).toBe(false);
    expect(queryMock).toHaveBeenCalledWith(expect.stringContaining('sideband_connected = FALSE'), [SESSION]);
    // Idempotent.
    await grokVoiceManager.disconnect(SESSION);
  });
});

describe('failure handling', () => {
  it('fails closed when xAI drops the socket mid-session', async () => {
    const { client, upstream } = await bringUp();
    fire(upstream, { type: 'response.done', response: { id: 'r1' }, usage: { billable_audio_seconds: 30 } });
    await flush();
    upstream.emit('close', 1006, Buffer.from(''));
    await flush();

    expect(recordLiveUsageMock).toHaveBeenCalledWith(SESSION, 'grok-voice-think-fast-2.0', 30, {
      finalized: true, closeReason: 'connection_lost',
    });
    expect(sent(client)).toContainEqual({ type: 'closed', reason: 'upstream_lost' });
    expect(serverEndSessionMock).toHaveBeenCalledWith(SESSION, expect.objectContaining({ endedBy: 'system', reason: 'upstream_lost' }));
    expect(grokVoiceManager.owns(SESSION)).toBe(false);
  });

  it('stops billing the moment the browser drops, then ends the session after the grace period', async () => {
    const { client, upstream } = await bringUp();
    client.emit('close');
    expect(upstream.close).toHaveBeenCalledWith(1000, 'client disconnected');
    expect(serverEndSessionMock).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(16_000);
    expect(serverEndSessionMock).toHaveBeenCalledWith(SESSION, expect.objectContaining({ reason: 'client_disconnected' }));
  });

  it('the participant "end" control closes upstream without ending the DB session itself', async () => {
    const { client, upstream } = await bringUp();
    client.emit('message', Buffer.from(JSON.stringify({ type: 'end' })), false);
    expect(upstream.close).toHaveBeenCalledWith(1000, 'participant ended');
    expect(serverEndSessionMock).not.toHaveBeenCalled(); // POST /end owns that
  });
});
