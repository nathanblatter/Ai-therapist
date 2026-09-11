import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Covers the GPT-Live sideband (SidebandManager), which replaced the Realtime
// implementation wholesale. Priorities, in order of risk:
//
//   1. TranscriptAssembler — brand-new turn-assembly logic with no upstream
//      equivalent. Everything downstream (crisis scoring, the messages table)
//      depends on it producing whole, correctly ordered turns.
//   2. The crisis pipeline join point, INCLUDING the DB-outage path: a failed
//      insert must never silently disable crisis detection.
//   3. Usage metering, where session.usage.updated carries a CUMULATIVE
//      snapshot — accumulating instead of assigning would massively overbill.
//   4. Delegated tool execution and backend-usage dedup.
//   5. tryInject / phase nudges, ported from the Realtime coverage.
//
// The real WebSocket is replaced with a fake so `connect()` can build genuine
// per-session state (real TranscriptAssemblers wired to the real turn handlers)
// without opening a socket. Private methods are reached through a typed cast,
// the way the Realtime test file did.
const {
  queryMock, getSystemConfigMock, getActiveModalityMock, insertMessagesBatchMock,
  insertToolInvocationMock, recordLlmUsageMock, recordLiveUsageMock,
  runCrisisPipelineMock, executeToolMock, broadcastMock, safetyIdentifierMock,
} = vi.hoisted(() => ({
  queryMock: vi.fn(),
  getSystemConfigMock: vi.fn(),
  getActiveModalityMock: vi.fn(),
  insertMessagesBatchMock: vi.fn(),
  insertToolInvocationMock: vi.fn(),
  recordLlmUsageMock: vi.fn(),
  recordLiveUsageMock: vi.fn(),
  runCrisisPipelineMock: vi.fn(),
  executeToolMock: vi.fn(),
  broadcastMock: vi.fn(),
  safetyIdentifierMock: vi.fn(),
}));

interface FakeSocket {
  on: ReturnType<typeof vi.fn>;
  send: ReturnType<typeof vi.fn>;
  ping: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  readyState: number;
}

// The real socket is replaced so connect() can build genuine per-session state
// (real TranscriptAssemblers wired to the real turn handlers) without dialling
// out. WS_OPEN lives in the hoisted block because vi.mock factories run first.
const { WS_OPEN, fakeWs } = vi.hoisted(() => {
  const OPEN = 1; // matches the real 'ws' package's WebSocket.OPEN
  return {
    WS_OPEN: OPEN,
    fakeWs: () => ({
      on: vi.fn(),
      send: vi.fn(),
      ping: vi.fn(),
      close: vi.fn(),
      readyState: OPEN,
    }),
  };
});

vi.mock('ws', () => {
  const ctor = vi.fn(() => fakeWs());
  (ctor as unknown as { OPEN: number }).OPEN = WS_OPEN;
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
vi.mock('./toolRegistry.service.js', () => ({ toolRegistry: { executeTool: executeToolMock } }));
vi.mock('../utils/adminBroadcast.js', () => ({ broadcastAdminEventForSession: broadcastMock }));
vi.mock('../utils/safetyIdentifier.js', () => ({ safetyIdentifierForSession: safetyIdentifierMock }));
vi.mock('../utils/sessionHelpers.js', () => ({
  getSystemConfig: getSystemConfigMock,
  getActiveModality: getActiveModalityMock,
}));

import { sidebandManager, TranscriptAssembler } from './sidebandManager.service.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Internal = any;

const sb = sidebandManager as unknown as Internal;

const MODEL = 'gpt-live-1';
const BACKEND_MODEL = 'gpt-5.6-terra';
const TURN_GAP_MS = 900;
const MAX_DURATION_MINUTES = 30;

/** Attach a session with genuine internal state over a fake socket. */
async function attach(sessionId: string): Promise<FakeSocket> {
  const ws = await sidebandManager.connect(sessionId, `live_${sessionId}`, 'sk-test', {
    model: MODEL, backendModel: BACKEND_MODEL,
  });
  return ws as unknown as FakeSocket;
}

function sentEvents(ws: FakeSocket): Array<Record<string, Internal>> {
  return ws.send.mock.calls.map((c: unknown[]) => JSON.parse(c[0] as string));
}

/** Deliver one server event through the private message handler. */
async function fire(sessionId: string, event: Record<string, unknown>): Promise<void> {
  await sb.handleMessage(sessionId, Buffer.from(JSON.stringify(event)));
}

/** Drain the fire-and-forget dynamic-import chains the handlers kick off. */
async function flush(): Promise<void> {
  for (let i = 0; i < 5; i++) await vi.advanceTimersByTimeAsync(0);
}

function userDelta(delta: string, startMs: number, endMs = startMs + 100) {
  return { type: 'session.input_transcript.delta', delta, start_ms: startMs, end_ms: endMs };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-09-11T12:00:00Z'));
  sb.sessions.clear();
  sb.endedSessions.clear();

  queryMock.mockReset().mockImplementation((sql: string) => {
    if (sql.includes('created_at')) return Promise.resolve({ rows: [{ created_at: new Date() }] });
    return Promise.resolve({ rows: [] });
  });
  insertMessagesBatchMock.mockReset().mockResolvedValue([{ message_id: 42 }]);
  insertToolInvocationMock.mockReset().mockResolvedValue(undefined);
  recordLlmUsageMock.mockReset().mockResolvedValue(undefined);
  recordLiveUsageMock.mockReset().mockResolvedValue(undefined);
  runCrisisPipelineMock.mockReset().mockResolvedValue({ severity: 'none' });
  executeToolMock.mockReset().mockResolvedValue({ ok: true });
  broadcastMock.mockReset().mockResolvedValue(undefined);
  safetyIdentifierMock.mockReset().mockResolvedValue('sid-test');
  getSystemConfigMock.mockReset().mockResolvedValue({
    features: {},
    session_limits: { enabled: true, max_duration_minutes: MAX_DURATION_MINUTES },
  });
  getActiveModalityMock.mockReset().mockResolvedValue(null);
  (global as Internal).io = { to: () => ({ emit: vi.fn() }) };
});

afterEach(() => {
  vi.clearAllTimers();
  sb.sessions.clear();
  sb.endedSessions.clear();
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// TranscriptAssembler
// ---------------------------------------------------------------------------

describe('TranscriptAssembler', () => {
  it('concatenates fragments exactly as received (no trimming, no inserted spaces)', () => {
    const turns: string[] = [];
    const a = new TranscriptAssembler(TURN_GAP_MS, text => { turns.push(text); });

    a.add({ delta: 'I have', start_ms: 0, end_ms: 400 });
    a.add({ delta: ' been', start_ms: 400, end_ms: 700 });
    a.add({ delta: ' thinking.', start_ms: 700, end_ms: 1000 });
    a.flush();

    expect(turns).toEqual(['I have been thinking.']);
  });

  it('orders fragments by start_ms, not arrival order', () => {
    const turns: Array<{ text: string; startMs: number; endMs: number }> = [];
    const a = new TranscriptAssembler(TURN_GAP_MS, (text, startMs, endMs) =>
      turns.push({ text, startMs, endMs }));

    // Deliberately out of order: the docs allow late, out-of-order delivery.
    a.add({ delta: ' world', start_ms: 500, end_ms: 900 });
    a.add({ delta: 'hello', start_ms: 100, end_ms: 500 });
    a.add({ delta: ' again', start_ms: 900, end_ms: 1200 });
    a.flush();

    expect(turns).toHaveLength(1);
    expect(turns[0].text).toBe('hello world again');
    expect(turns[0].startMs).toBe(100);
    expect(turns[0].endMs).toBe(1200);
  });

  it('flushes only after gapMs of silence, and rides through shorter pauses', () => {
    const turns: string[] = [];
    const a = new TranscriptAssembler(TURN_GAP_MS, text => { turns.push(text); });

    a.add({ delta: 'one', start_ms: 0, end_ms: 100 });
    vi.advanceTimersByTime(TURN_GAP_MS - 1);
    expect(turns).toEqual([]);

    // A fragment inside the gap re-arms the timer rather than closing the turn.
    a.add({ delta: ' two', start_ms: 900, end_ms: 1000 });
    vi.advanceTimersByTime(TURN_GAP_MS - 1);
    expect(turns).toEqual([]);

    vi.advanceTimersByTime(1);
    expect(turns).toEqual(['one two']);
  });

  it('starts a NEW turn for a fragment arriving after a flush', () => {
    const turns: string[] = [];
    const a = new TranscriptAssembler(TURN_GAP_MS, text => { turns.push(text); });

    a.add({ delta: 'first', start_ms: 0, end_ms: 100 });
    vi.advanceTimersByTime(TURN_GAP_MS);
    a.add({ delta: 'second', start_ms: 2000, end_ms: 2100 });
    vi.advanceTimersByTime(TURN_GAP_MS);

    expect(turns).toEqual(['first', 'second']);
  });

  it('flush() emits a pending turn immediately, without waiting for the gap', () => {
    const turns: string[] = [];
    const a = new TranscriptAssembler(TURN_GAP_MS, text => { turns.push(text); });

    a.add({ delta: 'final words', start_ms: 0, end_ms: 100 });
    a.flush();
    expect(turns).toEqual(['final words']);

    // The gap timer was cancelled, so nothing fires a second time.
    vi.advanceTimersByTime(TURN_GAP_MS * 2);
    expect(turns).toEqual(['final words']);
  });

  it('does not emit a turn for whitespace-only accumulations', () => {
    const turns: string[] = [];
    const a = new TranscriptAssembler(TURN_GAP_MS, text => { turns.push(text); });

    a.add({ delta: '  ', start_ms: 0, end_ms: 100 });
    a.add({ delta: '\n', start_ms: 100, end_ms: 200 });
    vi.advanceTimersByTime(TURN_GAP_MS);

    expect(turns).toEqual([]);
  });

  it('flush() on an empty buffer is a no-op', () => {
    const onTurn = vi.fn();
    const a = new TranscriptAssembler(TURN_GAP_MS, onTurn);
    a.flush();
    expect(onTurn).not.toHaveBeenCalled();
  });

  it('dispose() cancels the pending flush and drops the buffer', () => {
    const turns: string[] = [];
    const a = new TranscriptAssembler(TURN_GAP_MS, text => { turns.push(text); });

    a.add({ delta: 'never emitted', start_ms: 0, end_ms: 100 });
    a.dispose();
    vi.advanceTimersByTime(TURN_GAP_MS * 3);

    expect(turns).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Crisis pipeline integration (the safety-critical join point)
// ---------------------------------------------------------------------------

describe('user turn -> crisis pipeline', () => {
  it('assembles transcript deltas into one turn, persists it, and scores it', async () => {
    const sessionId = 's-crisis';
    await attach(sessionId);

    await fire(sessionId, userDelta('I have been', 0, 500));
    await fire(sessionId, userDelta(' feeling hopeless', 500, 1200));
    await vi.advanceTimersByTimeAsync(TURN_GAP_MS);
    await flush();

    const userInserts = insertMessagesBatchMock.mock.calls
      .map(c => c[0][0])
      .filter((row: Internal) => row.role === 'user');
    expect(userInserts).toHaveLength(1);
    expect(userInserts[0].content).toBe('I have been feeling hopeless');
    expect(userInserts[0].metadata).toMatchObject({ channel: 'live', start_ms: 0, end_ms: 1200 });

    expect(runCrisisPipelineMock).toHaveBeenCalledTimes(1);
    expect(runCrisisPipelineMock).toHaveBeenCalledWith(
      { sessionId, messageId: 42, content: 'I have been feeling hopeless' },
      'realtime',
    );
  });

  it('still runs the crisis pipeline when the message insert REJECTS', async () => {
    const sessionId = 's-crisis-db-down';
    await attach(sessionId);
    insertMessagesBatchMock.mockRejectedValue(new Error('connection terminated'));

    await fire(sessionId, userDelta('I want to kill myself', 0, 1500));
    await vi.advanceTimersByTimeAsync(TURN_GAP_MS);
    await flush();

    // A DB outage must never silently disable crisis detection.
    expect(runCrisisPipelineMock).toHaveBeenCalledTimes(1);
    expect(runCrisisPipelineMock).toHaveBeenCalledWith(
      { sessionId, messageId: null, content: 'I want to kill myself' },
      'realtime',
    );
  });

  it('does not score assistant turns through the crisis pipeline', async () => {
    const sessionId = 's-assistant-turn';
    await attach(sessionId);

    await fire(sessionId, {
      type: 'session.output_transcript.delta', delta: 'That sounds hard.', start_ms: 0, end_ms: 900,
    });
    await vi.advanceTimersByTimeAsync(TURN_GAP_MS);
    await flush();

    const assistantInserts = insertMessagesBatchMock.mock.calls
      .map(c => c[0][0])
      .filter((row: Internal) => row.role === 'assistant');
    expect(assistantInserts).toHaveLength(1);
    expect(assistantInserts[0].content).toBe('That sounds hard.');
    expect(runCrisisPipelineMock).not.toHaveBeenCalled();
  });

  it('flushes a half-spoken final turn on session.closed rather than losing it', async () => {
    const sessionId = 's-final-turn';
    await attach(sessionId);

    await fire(sessionId, userDelta('one last thing', 0, 600));
    // No gap elapses; session.closed arrives first.
    await fire(sessionId, { type: 'session.closed', reason: 'client_closed', usage: { seconds: 10 } });
    await flush();

    expect(runCrisisPipelineMock).toHaveBeenCalledWith(
      expect.objectContaining({ content: 'one last thing' }),
      'realtime',
    );
  });
});

// ---------------------------------------------------------------------------
// Usage metering
// ---------------------------------------------------------------------------

describe('voice usage metering', () => {
  it('treats session.usage.updated as a CUMULATIVE snapshot, not an increment', async () => {
    const sessionId = 's-usage';
    await attach(sessionId);

    await fire(sessionId, { type: 'session.usage.updated', usage: { seconds: 12 } });
    await flush();
    await fire(sessionId, { type: 'session.usage.updated', usage: { seconds: 30 } });
    await flush();

    const durations = recordLiveUsageMock.mock.calls.map(c => c[2]);
    expect(durations).toEqual([12, 30]);
    // 12 + 30 = 42 would be the accumulate bug.
    expect(durations).not.toContain(42);
    expect(sidebandManager.getUsageSeconds(sessionId)).toBe(30);
  });

  it('tracks the PEAK context-window ratio across snapshots', async () => {
    const sessionId = 's-usage-context';
    await attach(sessionId);

    await fire(sessionId, {
      type: 'session.usage.updated', usage: { seconds: 5 }, context_window: { usage_ratio: 0.7 },
    });
    await flush();
    await fire(sessionId, {
      type: 'session.usage.updated', usage: { seconds: 9 }, context_window: { usage_ratio: 0.4 },
    });
    await flush();

    const last = recordLiveUsageMock.mock.calls[recordLiveUsageMock.mock.calls.length - 1];
    expect(last[3]).toMatchObject({ finalized: false, contextRatio: 0.7 });
  });

  it('records finalized usage with the close reason on session.closed', async () => {
    const sessionId = 's-usage-closed';
    await attach(sessionId);

    await fire(sessionId, { type: 'session.usage.updated', usage: { seconds: 100 } });
    await flush();
    await fire(sessionId, {
      type: 'session.closed', reason: 'max_duration_reached', usage: { seconds: 118 },
    });
    await flush();

    const last = recordLiveUsageMock.mock.calls[recordLiveUsageMock.mock.calls.length - 1];
    expect(last[0]).toBe(sessionId);
    expect(last[1]).toBe(MODEL);
    expect(last[2]).toBe(118);
    expect(last[3]).toMatchObject({ finalized: true, closeReason: 'max_duration_reached' });
  });
});

// ---------------------------------------------------------------------------
// Delegated tool calls
// ---------------------------------------------------------------------------

describe('delegated tool calls (nested response.event)', () => {
  function outputItemDone(callId: string, name: string, args: string, delegationId = 'dg_1') {
    return {
      type: 'response.event',
      delegation_id: delegationId,
      event: {
        type: 'response.output_item.done',
        item: { type: 'function_call', call_id: callId, name, arguments: args },
      },
    };
  }

  it('executes the tool and replies with response.item.create then response.create', async () => {
    const sessionId = 's-tool';
    const ws = await attach(sessionId);
    executeToolMock.mockResolvedValue({ worksheet: 'thought-record' });

    await fire(sessionId, outputItemDone('call_a', 'find_worksheet', '{"topic":"anxiety"}'));
    await flush();

    expect(executeToolMock).toHaveBeenCalledWith(
      'find_worksheet', { topic: 'anxiety' }, { sessionId, channel: 'realtime' },
    );

    const events = sentEvents(ws);
    expect(events.map(e => e.type)).toEqual(['response.item.create', 'response.create']);
    expect(events[0].item).toEqual({
      type: 'function_call_output',
      call_id: 'call_a',
      output: JSON.stringify({ worksheet: 'thought-record' }),
    });
  });

  it('returns an error payload (still via response.item.create) when the tool throws', async () => {
    const sessionId = 's-tool-fail';
    const ws = await attach(sessionId);
    executeToolMock.mockRejectedValue(new Error('worksheet service down'));

    await fire(sessionId, outputItemDone('call_b', 'find_worksheet', '{}'));
    await flush();

    const events = sentEvents(ws);
    expect(events.map(e => e.type)).toEqual(['response.item.create', 'response.create']);
    expect(JSON.parse(events[0].item.output)).toEqual({ error: 'worksheet service down', success: false });
  });

  it('ignores an arguments-done event on its own (it cannot identify a call)', async () => {
    const sessionId = 's-tool-argsonly';
    const ws = await attach(sessionId);

    await fire(sessionId, {
      type: 'response.event',
      delegation_id: 'dg_1',
      event: {
        type: 'response.function_call_arguments.done',
        arguments: '{"topic":"anxiety"}',
      },
    });
    await flush();

    expect(executeToolMock).not.toHaveBeenCalled();
    expect(ws.send).not.toHaveBeenCalled();
  });

  it('ignores a non-function_call output item', async () => {
    const sessionId = 's-tool-message-item';
    const ws = await attach(sessionId);

    await fire(sessionId, {
      type: 'response.event',
      event: { type: 'response.output_item.done', item: { type: 'message', id: 'msg_1' } },
    });
    await flush();

    expect(executeToolMock).not.toHaveBeenCalled();
    expect(ws.send).not.toHaveBeenCalled();
  });

  it('sends response.create only once EVERY pending call has a result', async () => {
    const sessionId = 's-tool-parallel';
    const ws = await attach(sessionId);

    // A sibling call from the same delegated response is already outstanding
    // (parallel_tool_calls is off by default, but the backend can still be
    // configured for it, and the guide's terminal snapshot cannot be trusted to
    // tell us how many calls are open).
    sb.sessions.get(sessionId).pendingCalls.set('call_b', {
      name: 'tool_b', args: '{}', delegationId: 'dg_1',
    });

    await fire(sessionId, outputItemDone('call_a', 'tool_a', '{}'));
    await flush();

    // Call A's result is submitted, but B is still outstanding — continuing the
    // backend now would run it while it waits on a sibling call.
    expect(sentEvents(ws).map(e => e.type)).toEqual(['response.item.create']);
    expect([...sb.sessions.get(sessionId).pendingCalls.keys()]).toEqual(['call_b']);

    await fire(sessionId, outputItemDone('call_b', 'tool_b', '{}'));
    await flush();

    const types = sentEvents(ws).map(e => e.type);
    expect(types).toEqual(['response.item.create', 'response.item.create', 'response.create']);
    expect(types.filter(t => t === 'response.create')).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Backend (delegated Responses) usage
// ---------------------------------------------------------------------------

describe('backend usage metering (nested response.completed)', () => {
  function completed(id: string, model?: string) {
    return {
      type: 'response.event',
      delegation_id: 'dg_1',
      event: {
        type: 'response.completed',
        response: { id, model, usage: { input_tokens: 1200, output_tokens: 300 } },
      },
    };
  }

  it("records the delegated call under purpose 'live_delegation'", async () => {
    const sessionId = 's-backend-usage';
    await attach(sessionId);

    await fire(sessionId, completed('resp_1', 'gpt-5.6-terra'));
    await flush();

    expect(recordLlmUsageMock).toHaveBeenCalledTimes(1);
    expect(recordLlmUsageMock).toHaveBeenCalledWith(
      sessionId, 'live_delegation', 'gpt-5.6-terra', 1200, 300,
    );
  });

  it('falls back to the configured backend model when the event omits one', async () => {
    const sessionId = 's-backend-usage-nomodel';
    await attach(sessionId);

    await fire(sessionId, completed('resp_2'));
    await flush();

    expect(recordLlmUsageMock.mock.calls[0][2]).toBe(BACKEND_MODEL);
  });

  it('does NOT double-record a replayed event with the same response id', async () => {
    const sessionId = 's-backend-usage-dedup';
    await attach(sessionId);

    await fire(sessionId, completed('resp_3'));
    await flush();
    await fire(sessionId, completed('resp_3'));
    await flush();

    expect(recordLlmUsageMock).toHaveBeenCalledTimes(1);

    // A genuinely different response still counts.
    await fire(sessionId, completed('resp_4'));
    await flush();
    expect(recordLlmUsageMock).toHaveBeenCalledTimes(2);
  });
});

// ---------------------------------------------------------------------------
// tryInject
// ---------------------------------------------------------------------------

describe('tryInject', () => {
  it('returns false without throwing when there is no sideband connection', async () => {
    const result = await sidebandManager.tryInject('s-no-conn', 'system', 'hello', true);
    expect(result).toBe(false);
  });

  it('appends trusted instructions over a live connection', async () => {
    const sessionId = 's-inject';
    const ws = await attach(sessionId);

    const result = await sidebandManager.tryInject(sessionId, 'system', 'exercise finished', true);

    expect(result).toBe(true);
    const events = sentEvents(ws);
    expect(events.map(e => e.type)).toEqual(['session.instructions.append']);
    expect(events[0].content).toBe('exercise finished');
    expect(events[0].delegation_id).toBeNull();
  });

  it('returns false when the underlying send fails', async () => {
    const sessionId = 's-inject-err';
    const ws = await attach(sessionId);
    ws.send.mockImplementation(() => { throw new Error('socket torn down'); });

    const result = await sidebandManager.tryInject(sessionId, 'system', 'text', false);
    expect(result).toBe(false);
  });

  it('returns false when the socket exists but is not OPEN', async () => {
    const sessionId = 's-inject-closing';
    const ws = await attach(sessionId);
    ws.readyState = 2; // CLOSING

    expect(await sidebandManager.tryInject(sessionId, 'system', 'text', false)).toBe(false);
    expect(ws.send).not.toHaveBeenCalled();
  });

  it('truncates over-long content to the append cap rather than dropping the steer', async () => {
    const sessionId = 's-inject-long';
    const ws = await attach(sessionId);
    const MAX_CHARS = 1600;
    const long = 'a'.repeat(MAX_CHARS + 500);

    const result = await sidebandManager.tryInject(sessionId, 'system', long, false);

    expect(result).toBe(true);
    const sent = sentEvents(ws)[0];
    expect(sent.type).toBe('session.instructions.append');
    expect((sent.content as string).length).toBe(MAX_CHARS);
    expect(sent.content).toBe(long.slice(0, MAX_CHARS));
  });

  it('leaves content at exactly the cap untouched', async () => {
    const sessionId = 's-inject-exact';
    const ws = await attach(sessionId);
    const exact = 'b'.repeat(1600);

    await sidebandManager.tryInject(sessionId, 'system', exact, false);
    expect(sentEvents(ws)[0].content).toBe(exact);
  });
});

// ---------------------------------------------------------------------------
// Phase nudges (ported from the Realtime coverage)
// ---------------------------------------------------------------------------

describe('schedulePhaseNudges', () => {
  function appended(ws: FakeSocket): string[] {
    return sentEvents(ws)
      .filter(e => e.type === 'session.instructions.append')
      .map(e => e.content as string);
  }

  it('falls back to the fixed 60%/85% script when the active modality has no phases', async () => {
    const sessionId = 's-phase-fixed';
    const ws = await attach(sessionId);

    await sb.schedulePhaseNudges(sessionId);
    await vi.advanceTimersByTimeAsync(MAX_DURATION_MINUTES * 60 * 1000 * 0.6);

    const texts = appended(ws);
    expect(texts).toHaveLength(1);
    expect(texts[0]).toMatch(/halfway point/i);

    await vi.advanceTimersByTimeAsync(MAX_DURATION_MINUTES * 60 * 1000 * 0.25);
    const later = appended(ws);
    expect(later).toHaveLength(2);
    expect(later[1]).toMatch(/winding down/i);
  });

  it("walks the active modality's phase script instead, when one is defined", async () => {
    getActiveModalityMock.mockResolvedValue({
      key: 'cbt',
      preset: {
        label: 'CBT-informed',
        addition: '',
        phases: [
          { at: 0.15, label: 'agenda', guidance: 'Set the agenda collaboratively.' },
          { at: 0.85, label: 'assign_practice', guidance: 'Suggest a small practice item and close warmly.' },
        ],
      },
    });
    const sessionId = 's-phase-modality';
    const ws = await attach(sessionId);

    await sb.schedulePhaseNudges(sessionId);
    await vi.advanceTimersByTimeAsync(MAX_DURATION_MINUTES * 60 * 1000 * 0.15);

    let texts = appended(ws);
    expect(texts).toHaveLength(1);
    expect(texts[0]).toMatch(/Set the agenda collaboratively/);
    expect(texts[0]).not.toMatch(/halfway point/i);

    await vi.advanceTimersByTimeAsync(MAX_DURATION_MINUTES * 60 * 1000 * 0.7);
    texts = appended(ws);
    expect(texts).toHaveLength(2);
    expect(texts[1]).toMatch(/Suggest a small practice item/);
    // Late phases carry a minutes-remaining tail.
    expect(texts[1]).toMatch(/minutes remain/);
  });

  it('does nothing when features.phase_guidance_enabled is false', async () => {
    getSystemConfigMock.mockResolvedValue({
      features: { phase_guidance_enabled: false },
      session_limits: { enabled: true, max_duration_minutes: MAX_DURATION_MINUTES },
    });
    const sessionId = 's-phase-disabled';
    const ws = await attach(sessionId);

    await sb.schedulePhaseNudges(sessionId);
    await vi.advanceTimersByTimeAsync(MAX_DURATION_MINUTES * 60 * 1000);

    expect(appended(ws)).toEqual([]);
    expect(sb.sessions.get(sessionId).phaseTimers).toHaveLength(0);
  });

  it('does nothing when session limits are not enabled', async () => {
    getSystemConfigMock.mockResolvedValue({ features: {}, session_limits: { enabled: false } });
    const sessionId = 's-phase-nolimit';
    const ws = await attach(sessionId);

    await sb.schedulePhaseNudges(sessionId);
    await vi.advanceTimersByTimeAsync(MAX_DURATION_MINUTES * 60 * 1000);

    expect(appended(ws)).toEqual([]);
  });

  it('is idempotent per session (a second call does not double-schedule)', async () => {
    const sessionId = 's-phase-idempotent';
    await attach(sessionId);

    await sb.schedulePhaseNudges(sessionId);
    const afterFirst = sb.sessions.get(sessionId).phaseTimers.length;
    expect(afterFirst).toBeGreaterThan(0);

    await sb.schedulePhaseNudges(sessionId);
    expect(sb.sessions.get(sessionId).phaseTimers.length).toBe(afterFirst);
  });
});

// ---------------------------------------------------------------------------
// Re-grounding scheduling (opt-in)
// ---------------------------------------------------------------------------

describe('scheduleRegrounding', () => {
  it('is off unless features.regrounding_enabled is exactly true', async () => {
    const sessionId = 's-reground-off';
    await attach(sessionId);

    await sb.scheduleRegrounding(sessionId);
    expect(sb.sessions.get(sessionId).regrounding).toBeNull();
  });

  it('arms an interval when enabled', async () => {
    getSystemConfigMock.mockResolvedValue({
      features: { regrounding_enabled: true, regrounding_interval_minutes: 5 },
      session_limits: { enabled: true, max_duration_minutes: MAX_DURATION_MINUTES },
    });
    const sessionId = 's-reground-on';
    await attach(sessionId);

    await sb.scheduleRegrounding(sessionId);
    expect(sb.sessions.get(sessionId).regrounding).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Connection lifecycle
// ---------------------------------------------------------------------------

describe('connection lifecycle', () => {
  it('refuses to attach to a session that already ended', async () => {
    const sessionId = 's-ended';
    await sidebandManager.disconnect(sessionId);
    expect(sb.endedSessions.has(sessionId)).toBe(true);

    await expect(
      sidebandManager.connect(sessionId, 'live_x', 'sk-test', { model: MODEL, backendModel: BACKEND_MODEL }),
    ).rejects.toThrow(/ended/i);
    expect(sb.sessions.has(sessionId)).toBe(false);
  });

  it('bounds the ended-sessions set instead of growing forever, keeping the most recent', async () => {
    for (let i = 0; i < 1200; i++) {
      await sidebandManager.disconnect(`leak-${i}`);
    }
    expect(sb.endedSessions.size).toBeLessThanOrEqual(1000);
    expect(sb.endedSessions.has('leak-1199')).toBe(true);
  });

  it('returns the existing socket rather than double-attaching', async () => {
    const sessionId = 's-double-attach';
    const first = await attach(sessionId);
    const second = await attach(sessionId);
    expect(second).toBe(first);
    expect(sb.sessions.size).toBe(1);
  });

  it('reports active connections and connection state', async () => {
    const sessionId = 's-active';
    await attach(sessionId);

    expect(sidebandManager.getActiveConnections()).toEqual([sessionId]);
    expect(sidebandManager.isConnected(sessionId)).toBe(true);
    expect(sidebandManager.isConnected('s-unknown')).toBe(false);
    expect(sidebandManager.getUsageSeconds('s-unknown')).toBeNull();
  });

  it('disconnect() disposes assemblers, clears timers and closes the socket', async () => {
    const sessionId = 's-disconnect';
    const ws = await attach(sessionId);
    await sb.schedulePhaseNudges(sessionId);

    // finalized short-circuits the graceful-close wait so the test stays fast.
    sb.sessions.get(sessionId).finalized = true;
    await sidebandManager.disconnect(sessionId, { graceMs: 0 });

    expect(ws.close).toHaveBeenCalledWith(1000, 'Session ended');
    expect(sb.sessions.has(sessionId)).toBe(false);
    expect(sb.endedSessions.has(sessionId)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Re-attach sweep
// ---------------------------------------------------------------------------

describe('reattachActiveSessions', () => {
  it('re-attaches orphaned live sessions, skipping connected and non-live ones', async () => {
    queryMock.mockImplementation((sql: string) => {
      if (sql.includes('openai_live_session_id')) {
        return Promise.resolve({
          rows: [
            { session_id: 's-orphan', openai_live_session_id: 'live_1', ai_model: 'gpt-live-1' },
            { session_id: 's-already', openai_live_session_id: 'live_2', ai_model: 'gpt-live-1' },
            { session_id: 's-realtime', openai_live_session_id: 'live_3', ai_model: 'gpt-realtime-2026' },
          ],
        });
      }
      return Promise.resolve({ rows: [] });
    });
    await attach('s-already');

    const connectSpy = vi.spyOn(sb, 'connect');
    const { attempted } = await sidebandManager.reattachActiveSessions('sk-standard');

    expect(attempted).toBe(3);
    expect(connectSpy).toHaveBeenCalledTimes(1);
    expect(connectSpy).toHaveBeenCalledWith('s-orphan', 'live_1', 'sk-standard', {
      model: 'gpt-live-1', backendModel: 'gpt-5.6-terra',
    });
    connectSpy.mockRestore();
  });

  it('continues past an individual re-attach failure', async () => {
    queryMock.mockImplementation((sql: string) => {
      if (sql.includes('openai_live_session_id')) {
        return Promise.resolve({
          rows: [
            { session_id: 's-dead', openai_live_session_id: 'live_dead', ai_model: 'gpt-live-1' },
            { session_id: 's-alive', openai_live_session_id: 'live_ok', ai_model: 'gpt-live-1' },
          ],
        });
      }
      return Promise.resolve({ rows: [] });
    });
    sb.endedSessions.add('s-dead'); // makes the first connect() throw

    const { attempted } = await sidebandManager.reattachActiveSessions('sk-standard');

    expect(attempted).toBe(2);
    expect(sb.sessions.has('s-alive')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Admin control surface
// ---------------------------------------------------------------------------

describe('admin control surface', () => {
  it('triggerTool pins the delegated tool_choice, nudges, and schedules a reset', async () => {
    const sessionId = 's-trigger';
    const ws = await attach(sessionId);

    await sidebandManager.triggerTool(sessionId, 'start_breathing_exercise', { duration_seconds: 90 });

    const events = sentEvents(ws);
    expect(events.map(e => e.type)).toEqual(['session.update', 'session.instructions.append']);
    expect(events[0].session.delegation.responses.tool_choice).toEqual({
      type: 'function', name: 'start_breathing_exercise',
    });
    const nudge = events[1].content as string;
    expect(nudge).toMatch(/clinician overseeing this session asks you to use the start_breathing_exercise/i);
    expect(nudge).toContain('"duration_seconds":90');
    expect(sb.sessions.get(sessionId).toolChoiceReset).not.toBeNull();

    ws.send.mockClear();
    await vi.advanceTimersByTimeAsync(45_000);
    await flush();

    const reset = sentEvents(ws).find(e => e.type === 'session.update');
    expect(reset!.session.delegation.responses.tool_choice).toBe('auto');
    expect(sb.sessions.get(sessionId).toolChoiceReset).toBeNull();
  });

  it('triggerTool omits the args context when no args are given', async () => {
    const sessionId = 's-trigger-noargs';
    const ws = await attach(sessionId);

    await sidebandManager.triggerTool(sessionId, 'end_session');

    const nudge = sentEvents(ws).find(e => e.type === 'session.instructions.append')!.content as string;
    expect(nudge).not.toMatch(/context for the tool arguments/);
  });

  it('interrupt() sends an advisory stop-speaking instruction', async () => {
    const sessionId = 's-interrupt';
    const ws = await attach(sessionId);

    await sidebandManager.interrupt(sessionId);

    const events = sentEvents(ws);
    expect(events.map(e => e.type)).toEqual(['session.instructions.append']);
    expect(events[0].content).toMatch(/stop speaking immediately/i);
  });

  it('updateSession routes updates into the delegated backend config', async () => {
    const sessionId = 's-update';
    const ws = await attach(sessionId);

    await sidebandManager.updateSession(sessionId, { instructions: 'new clinical prompt' });

    const events = sentEvents(ws);
    expect(events[0].type).toBe('session.update');
    expect(events[0].session).toEqual({
      delegation: { responses: { instructions: 'new clinical prompt' } },
    });
  });

  it('createResponse ignores per-response overrides and sends a bare response.create', async () => {
    const sessionId = 's-create-response';
    const ws = await attach(sessionId);

    await sidebandManager.createResponse(sessionId, { model: 'gpt-5', instructions: 'nope' });

    const events = sentEvents(ws);
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('response.create');
    expect(events[0].model).toBeUndefined();
    expect(events[0].response).toBeUndefined();
  });

  it('injectMessage throws when the sideband is not connected', async () => {
    await expect(sidebandManager.injectMessage('s-gone', 'system', 'hi', false))
      .rejects.toThrow(/not active/i);
  });

  it('mute / unmute send the server-side input-audio controls', async () => {
    const sessionId = 's-mute';
    const ws = await attach(sessionId);

    await sidebandManager.muteInput(sessionId);
    await sidebandManager.unmuteInput(sessionId);

    expect(sentEvents(ws).map(e => e.type))
      .toEqual(['session.input_audio.mute', 'session.input_audio.unmute']);
  });
});

// ---------------------------------------------------------------------------
// Error handling
// ---------------------------------------------------------------------------

describe('error handling', () => {
  it('persists an API error event to sideband_error', async () => {
    const sessionId = 's-api-error';
    await attach(sessionId);

    await fire(sessionId, { type: 'error', error: { code: 'invalid_event', message: 'bad event' } });
    await flush();

    const update = queryMock.mock.calls.find((c: unknown[]) =>
      typeof c[0] === 'string' && (c[0] as string).includes('SET sideband_error'));
    expect(update).toBeTruthy();
    expect((update![1] as unknown[])[0]).toContain('bad event');
  });

  it('swallows a malformed (non-JSON) frame without throwing', async () => {
    const sessionId = 's-bad-frame';
    await attach(sessionId);
    await expect(sb.handleMessage(sessionId, Buffer.from('not json'))).resolves.toBeUndefined();
  });

  it('ignores transcript deltas for a session that is no longer attached', async () => {
    await expect(fire('s-detached', userDelta('orphan text', 0))).resolves.toBeUndefined();
    await vi.advanceTimersByTimeAsync(TURN_GAP_MS);
    await flush();
    expect(runCrisisPipelineMock).not.toHaveBeenCalled();
  });
});
