// ai-therapist-226: a fork whose session closed before the backend produced
// any output was recorded as a SUCCESS with empty text — the socket 'close'
// handler's error never applied because session.closed had already settled
// the promise with no error. Silence must come back as `error`.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { EventEmitter } from 'node:events';

// vi.mock factories are hoisted to the top of the file, so the registry the
// factory pushes into must be hoisted with it.
const { sockets } = vi.hoisted(() => ({ sockets: [] as Array<EventEmitter & { sent: string[] }> }));
vi.mock('ws', async () => {
  const { EventEmitter } = await import('node:events');
  class MockWebSocket extends EventEmitter {
    sent: string[] = [];
    closed = false;
    constructor() {
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

import { forkAndProbe } from './liveFork.service.js';

const OPTS = {
  sourceSessionId: 'live_src',
  apiKey: 'sk-test',
  backendModel: 'gpt-5-mini',
  probeText: 'I have been feeling low',
  timeoutMs: 5_000,
};

function latest(): EventEmitter & { sent: string[] } {
  return sockets[sockets.length - 1];
}

function emitEvent(ws: EventEmitter, event: Record<string, unknown>) {
  ws.emit('message', Buffer.from(JSON.stringify(event)));
}

beforeEach(() => {
  sockets.length = 0;
});

describe('forkAndProbe', () => {
  it('records a session that closes before any backend output as an error, not a $0 success', async () => {
    const pending = forkAndProbe(OPTS);
    await Promise.resolve();
    const ws = latest();
    ws.emit('open');
    emitEvent(ws, { type: 'session.started', session: { id: 'live_fork_1' } });
    emitEvent(ws, { type: 'session.closed', usage: { seconds: 2 } });

    const result = await pending;
    expect(result.forkSessionId).toBe('live_fork_1');
    expect(result.responseText).toBe('');
    expect(result.error).toBe('session closed before the backend produced output');
    expect(result.voiceSeconds).toBe(2);
  });

  it('still resolves cleanly when the backend completed before the session closed', async () => {
    const pending = forkAndProbe(OPTS);
    await Promise.resolve();
    const ws = latest();
    ws.emit('open');
    emitEvent(ws, { type: 'session.started', session: { id: 'live_fork_2' } });
    emitEvent(ws, { type: 'response.event', event: { type: 'response.output_text.delta', delta: 'I hear you.' } });
    emitEvent(ws, {
      type: 'response.event',
      event: { type: 'response.completed', response: { usage: { input_tokens: 10, output_tokens: 3 } } },
    });
    emitEvent(ws, { type: 'session.closed', usage: { seconds: 4 } });

    const result = await pending;
    expect(result.error).toBeNull();
    expect(result.responseText).toBe('I hear you.');
    expect(result.tokensIn).toBe(10);
    expect(result.tokensOut).toBe(3);
    expect(result.voiceSeconds).toBe(4);
  });
});
