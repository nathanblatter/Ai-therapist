// GPT-Live fork protocol (ai-therapist-236 chunk 3): what forkAndProbe puts on
// the wire and how every failure mode comes back as an `error` envelope rather
// than a throw. Companion to liveFork.service.test.ts (the silent-close case).
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { EventEmitter } from 'node:events';

interface MockSocket extends EventEmitter {
  sent: string[];
  url: string;
  options: { headers: Record<string, string> };
  closed: boolean;
}

const { sockets } = vi.hoisted(() => ({ sockets: [] as unknown[] }));
vi.mock('ws', async () => {
  const { EventEmitter } = await import('node:events');
  class MockWebSocket extends EventEmitter {
    sent: string[] = [];
    closed = false;
    constructor(public url: string, public options: unknown) {
      super();
      sockets.push(this);
    }
    send(data: string) { this.sent.push(data); }
    close() {
      if (this.closed) return;
      this.closed = true;
      queueMicrotask(() => this.emit('close'));
    }
  }
  return { default: MockWebSocket };
});

import { forkAndProbe, type ForkOptions } from './liveFork.service.js';

const OPTS: ForkOptions = {
  sourceSessionId: 'live src/with?odd=chars',
  apiKey: 'sk-test',
  backendModel: 'gpt-5-mini',
  backendInstructions: 'Be kind.',
  probeText: 'I have been feeling low',
  timeoutMs: 5_000,
};

function latest(): MockSocket {
  return sockets[sockets.length - 1] as MockSocket;
}

function sentEvents(ws: MockSocket): Array<Record<string, unknown>> {
  return ws.sent.map(s => JSON.parse(s) as Record<string, unknown>);
}

function emitEvent(ws: EventEmitter, event: Record<string, unknown>) {
  ws.emit('message', Buffer.from(JSON.stringify(event)));
}

/** Open the socket and bring the fork to the started state. */
async function start(opts: ForkOptions = OPTS) {
  const pending = forkAndProbe(opts);
  await Promise.resolve();
  const ws = latest();
  ws.emit('open');
  emitEvent(ws, { type: 'session.started', session: { id: 'live_fork_1' } });
  return { pending, ws };
}

function completeResponse(ws: MockSocket, usage = { input_tokens: 10, output_tokens: 3 }) {
  emitEvent(ws, { type: 'response.event', event: { type: 'response.completed', response: { usage } } });
}

beforeEach(() => {
  sockets.length = 0;
});

describe('forkAndProbe wire protocol', () => {
  it('connects to the fork endpoint with the source id URL-encoded and a bearer header', async () => {
    const { ws, pending } = await start();
    expect(ws.url).toBe('wss://api.openai.com/v1/live/sessions/live%20src%2Fwith%3Fodd%3Dchars/fork');
    expect(ws.options.headers).toEqual({ Authorization: 'Bearer sk-test' });
    completeResponse(ws);
    emitEvent(ws, { type: 'session.closed' });
    await pending;
  });

  it('overrides only the delegation block on session.start, never a voice model, and never stores the branch', async () => {
    const { ws, pending } = await start();
    const [startEvt] = sentEvents(ws);
    expect(startEvt).toEqual({
      type: 'session.start',
      session: {
        delegation: { type: 'responses', responses: { model: 'gpt-5-mini', instructions: 'Be kind.' } },
        audio: { format: { type: 'audio/pcm', rate: 24000 } },
        store: false,
      },
    });
    expect(startEvt.session).not.toHaveProperty('model');
    completeResponse(ws);
    emitEvent(ws, { type: 'session.closed' });
    await pending;
  });

  it('inherits the source backend prompt when none is supplied', async () => {
    const { backendInstructions: _omitted, ...withoutPrompt } = OPTS;
    const { ws, pending } = await start(withoutPrompt);
    const [startEvt] = sentEvents(ws);
    const responses = (startEvt.session as { delegation: { responses: Record<string, unknown> } }).delegation.responses;
    expect(responses).toEqual({ model: 'gpt-5-mini' });
    completeResponse(ws);
    emitEvent(ws, { type: 'session.closed' });
    await pending;
  });

  it('sends nothing before session.started, then the probe item and a bare response.create', async () => {
    const pending = forkAndProbe(OPTS);
    await Promise.resolve();
    const ws = latest();
    ws.emit('open');
    expect(ws.sent).toHaveLength(1); // session.start only

    emitEvent(ws, { type: 'session.started', session: { id: 'live_fork_9' } });
    const [, item, run] = sentEvents(ws);
    expect(item).toEqual({
      type: 'response.item.create',
      event_id: 'probe_item',
      item: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'I have been feeling low' }] },
    });
    expect(run).toEqual({ type: 'response.create', event_id: 'probe_run' });

    completeResponse(ws);
    expect(sentEvents(ws)[3]).toEqual({ type: 'session.close', event_id: 'probe_close' });
    emitEvent(ws, { type: 'session.closed' });
    const result = await pending;
    expect(result.forkSessionId).toBe('live_fork_9');
  });

  it('concatenates backend and voice deltas separately, exactly as received', async () => {
    const { ws, pending } = await start();
    emitEvent(ws, { type: 'response.event', event: { type: 'response.output_text.delta', delta: 'I hear ' } });
    emitEvent(ws, { type: 'session.output_transcript.delta', delta: 'Sounds ' });
    emitEvent(ws, { type: 'response.event', event: { type: 'response.output_text.delta', delta: 'you.' } });
    emitEvent(ws, { type: 'session.output_transcript.delta', delta: 'hard.' });
    completeResponse(ws, { input_tokens: 42, output_tokens: 7 });
    emitEvent(ws, { type: 'session.closed', usage: { seconds: 6 } });

    const result = await pending;
    expect(result).toMatchObject({
      forkSessionId: 'live_fork_1',
      responseText: 'I hear you.',
      spokenText: 'Sounds hard.',
      tokensIn: 42,
      tokensOut: 7,
      voiceSeconds: 6,
      error: null,
    });
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('treats voice usage as a cumulative snapshot: assigns, never accumulates', async () => {
    const { ws, pending } = await start();
    emitEvent(ws, { type: 'session.usage.updated', usage: { seconds: 3 } });
    emitEvent(ws, { type: 'session.usage.updated', usage: { seconds: 5 } });
    emitEvent(ws, { type: 'session.usage.updated', usage: {} });
    completeResponse(ws);
    emitEvent(ws, { type: 'session.closed' });
    const result = await pending;
    expect(result.voiceSeconds).toBe(5);
  });

  it('ignores malformed and unknown events', async () => {
    const { ws, pending } = await start();
    ws.emit('message', Buffer.from('{not json'));
    emitEvent(ws, { type: 'something.new', delta: 'ignored' });
    emitEvent(ws, { type: 'response.event', event: {} });
    completeResponse(ws);
    emitEvent(ws, { type: 'session.closed' });
    const result = await pending;
    expect(result.error).toBeNull();
    expect(result.responseText).toBe('');
  });
});

describe('forkAndProbe error envelopes', () => {
  it('reports a failed backend response with its reason', async () => {
    const { ws, pending } = await start();
    emitEvent(ws, {
      type: 'response.event',
      event: { type: 'response.failed', response: { status_details: { reason: 'model_not_supported' } } },
    });
    const result = await pending;
    expect(result.error).toBe('backend response response.failed: model_not_supported');
  });

  it('reports an incomplete backend response, defaulting the reason to unknown', async () => {
    const { ws, pending } = await start();
    emitEvent(ws, { type: 'response.event', event: { type: 'response.incomplete', response: {} } });
    const result = await pending;
    expect(result.error).toBe('backend response response.incomplete: unknown');
  });

  it('reports an API error event as code: message, with defaults for a bare error', async () => {
    const first = await start();
    emitEvent(first.ws, { type: 'error', error: { code: 'invalid_model', message: 'gpt-x is not a valid delegation backend' } });
    expect((await first.pending).error).toBe('invalid_model: gpt-x is not a valid delegation backend');

    const second = await start();
    emitEvent(second.ws, { type: 'error' });
    expect((await second.pending).error).toBe('error: unknown API error');
  });

  it('keeps the first error when the socket closes afterwards', async () => {
    const { ws, pending } = await start();
    emitEvent(ws, { type: 'error', error: { code: 'rate_limited', message: 'slow down' } });
    ws.emit('close');
    const result = await pending;
    expect(result.error).toBe('rate_limited: slow down');
  });

  it('reports a rejected upgrade with the HTTP status and a bounded body', async () => {
    const pending = forkAndProbe(OPTS);
    await Promise.resolve();
    const ws = latest();
    const res = Object.assign(new EventEmitter(), { statusCode: 404 });
    ws.emit('unexpected-response', {}, res);
    res.emit('data', Buffer.from('a'.repeat(200)));
    res.emit('data', Buffer.from('b'.repeat(200)));
    res.emit('end');
    const result = await pending;
    expect(result.error).toBe(`fork rejected: HTTP 404 — ${'a'.repeat(200)}${'b'.repeat(100)}`);
  });

  it('labels an empty rejection body', async () => {
    const pending = forkAndProbe(OPTS);
    await Promise.resolve();
    const ws = latest();
    const res = Object.assign(new EventEmitter(), { statusCode: 401 });
    ws.emit('unexpected-response', {}, res);
    res.emit('end');
    expect((await pending).error).toBe('fork rejected: HTTP 401 — (empty body)');
  });

  it('reports a socket error', async () => {
    const pending = forkAndProbe(OPTS);
    await Promise.resolve();
    latest().emit('error', new Error('ECONNRESET'));
    expect((await pending).error).toBe('socket error: ECONNRESET');
  });

  it('reports a socket that closes before the backend responded', async () => {
    const { ws, pending } = await start();
    emitEvent(ws, { type: 'response.event', event: { type: 'response.output_text.delta', delta: 'partial' } });
    ws.emit('close');
    const result = await pending;
    expect(result.error).toBe('socket closed before the backend responded');
    expect(result.responseText).toBe('partial');
  });

  it('times out a fork that never starts', async () => {
    const result = await forkAndProbe({ ...OPTS, timeoutMs: 20 });
    expect(result.error).toBe('fork timed out after 20ms');
    expect(latest().closed).toBe(true);
  });

  it('does not report a timeout once the backend has completed, even if session.closed never arrives', async () => {
    const { ws, pending } = await start({ ...OPTS, timeoutMs: 20 });
    emitEvent(ws, { type: 'response.event', event: { type: 'response.output_text.delta', delta: 'done' } });
    completeResponse(ws);
    const result = await pending;
    expect(result.error).toBeNull();
    expect(result.responseText).toBe('done');
  });
});
