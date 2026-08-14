import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Exercises the two new steering behaviors added to schedulePhaseNudges
// (ai-therapist-51 per-modality phase scripts, ai-therapist-74 proactive-
// offering mid-session nudge) and the new mid-session re-grounding feature
// (ai-therapist-49).
//
// handleOpen (the public entry point) fires schedulePhaseNudges/
// scheduleRegrounding without awaiting them — they're background steering,
// by design. To keep these tests deterministic under fake timers (an
// unawaited promise chain races unpredictably against fake-timer advancement),
// most tests call the private scheduler methods directly and await them; one
// integration test asserts handleOpen actually wires both up.
const {
  queryMock, getSystemConfigMock, getActiveModalityMock, insertMessagesBatchMock,
  insertTurnLatencyMock, insertRealtimeUsageMock,
} = vi.hoisted(() => ({
  queryMock: vi.fn(),
  getSystemConfigMock: vi.fn(),
  getActiveModalityMock: vi.fn(),
  insertMessagesBatchMock: vi.fn(),
  insertTurnLatencyMock: vi.fn(),
  insertRealtimeUsageMock: vi.fn(),
}));

vi.mock('../config/db.js', () => ({ pool: { query: queryMock } }));
vi.mock('../db/index.js', () => ({
  insertMessagesBatch: insertMessagesBatchMock,
  insertTurnLatency: insertTurnLatencyMock,
  insertRealtimeUsage: insertRealtimeUsageMock,
}));
vi.mock('../utils/sessionHelpers.js', () => ({
  getSystemConfig: getSystemConfigMock,
  getActiveModality: getActiveModalityMock,
  // Mirrors the real default (sessionHelpers.ts) — restoreTurnDetection reads
  // the semantic-VAD config from here.
  sessionConfigDefault: {
    session: {
      type: 'realtime',
      audio: {
        input: { turn_detection: { type: 'semantic_vad', eagerness: 'low' } },
      },
    },
  },
}));

import { sidebandManager } from './sidebandManager.service.js';

const WS_OPEN = 1; // matches the real 'ws' package's WebSocket.OPEN

function fakeWs() {
  return { send: vi.fn(), ping: vi.fn(), readyState: WS_OPEN };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Internal = any;

function resetInternals() {
  const sb = sidebandManager as Internal;
  sb.connections.clear();
  sb.phaseTimers.clear();
  sb.regroundingTimers.clear();
  sb.pingIntervals.clear();
  sb.reconnectAttempts.clear();
  sb.sessionKeys.clear();
  sb.endedSessions.clear();
  sb.holdFloorTimers.clear();
  sb.pendingToolChoiceResets.clear();
  sb.holdRestoreRetries.clear();
  sb.toolResetRetries.clear();
  sb.activeResponses.clear();
  sb.pendingTurns.clear();
  sb.turnCounters.clear();
}

function sentEventTypes(ws: ReturnType<typeof fakeWs>): Array<Record<string, Internal>> {
  return ws.send.mock.calls.map((c: unknown[]) => JSON.parse(c[0] as string));
}

const MAX_DURATION_MINUTES = 30;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-07-30T12:00:00Z'));
  resetInternals();
  queryMock.mockReset();
  insertMessagesBatchMock.mockReset().mockResolvedValue(undefined);
  insertTurnLatencyMock.mockReset().mockResolvedValue(undefined);
  insertRealtimeUsageMock.mockReset().mockResolvedValue(undefined);
  getSystemConfigMock.mockReset().mockResolvedValue({
    features: {},
    session_limits: { enabled: true, max_duration_minutes: MAX_DURATION_MINUTES },
  });
  getActiveModalityMock.mockReset().mockResolvedValue(null);
  (global as Internal).io = { to: () => ({ emit: vi.fn() }) };

  // Default DB responses: therapy_sessions.created_at "now", and no
  // proactive_offering row unless a test overrides it.
  queryMock.mockImplementation((sql: string) => {
    if (sql.includes('created_at')) return Promise.resolve({ rows: [{ created_at: new Date() }] });
    if (sql.includes('proactive_offering')) return Promise.resolve({ rows: [{ proactive_offering: null }] });
    return Promise.resolve({ rows: [] });
  });
});

afterEach(() => {
  vi.clearAllTimers();
  resetInternals();
  vi.useRealTimers();
});

describe('handleOpen wiring', () => {
  it('triggers both the phase-nudge and re-grounding schedulers', async () => {
    const sb = sidebandManager as Internal;
    const phaseSpy = vi.spyOn(sb, 'schedulePhaseNudges').mockResolvedValue(undefined);
    const regroundingSpy = vi.spyOn(sb, 'scheduleRegrounding').mockResolvedValue(undefined);

    const sessionId = 's-wiring';
    const ws = fakeWs();
    sb.connections.set(sessionId, ws);

    await sidebandManager.handleOpen(sessionId, 'call-1');

    expect(phaseSpy).toHaveBeenCalledWith(sessionId);
    expect(regroundingSpy).toHaveBeenCalledWith(sessionId);

    phaseSpy.mockRestore();
    regroundingSpy.mockRestore();
  });
});

describe('schedulePhaseNudges (ai-therapist-51 / ai-therapist-74)', () => {
  it('falls back to the fixed 60%/85% script when the active modality has no phases', async () => {
    const sessionId = 's-fixed';
    const ws = fakeWs();
    (sidebandManager as Internal).connections.set(sessionId, ws);

    await (sidebandManager as Internal).schedulePhaseNudges(sessionId);
    await vi.advanceTimersByTimeAsync(MAX_DURATION_MINUTES * 60 * 1000 * 0.6);

    const injected = sentEventTypes(ws).filter(e => e.type === 'conversation.item.create');
    expect(injected.length).toBe(1);
    expect(injected[0].item.content[0].text).toMatch(/halfway point/i);
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
    const sessionId = 's-modality';
    const ws = fakeWs();
    (sidebandManager as Internal).connections.set(sessionId, ws);

    await (sidebandManager as Internal).schedulePhaseNudges(sessionId);
    await vi.advanceTimersByTimeAsync(MAX_DURATION_MINUTES * 60 * 1000 * 0.15);

    let injected = sentEventTypes(ws).filter(e => e.type === 'conversation.item.create');
    expect(injected.length).toBe(1);
    expect(injected[0].item.content[0].text).toMatch(/Set the agenda collaboratively/);
    // The generic 60% consolidation text should NOT fire for a modality with its own script.
    expect(injected[0].item.content[0].text).not.toMatch(/halfway point/i);

    await vi.advanceTimersByTimeAsync(MAX_DURATION_MINUTES * 60 * 1000 * 0.7);
    injected = sentEventTypes(ws).filter(e => e.type === 'conversation.item.create');
    expect(injected.length).toBe(2);
    expect(injected[1].item.content[0].text).toMatch(/Suggest a small practice item/);
  });

  it('adds a mid-session (40%) proactive-offering reminder only for sessions in that research arm', async () => {
    queryMock.mockImplementation((sql: string) => {
      if (sql.includes('created_at')) return Promise.resolve({ rows: [{ created_at: new Date() }] });
      if (sql.includes('proactive_offering')) return Promise.resolve({ rows: [{ proactive_offering: true }] });
      return Promise.resolve({ rows: [] });
    });
    const sessionId = 's-proactive';
    const ws = fakeWs();
    (sidebandManager as Internal).connections.set(sessionId, ws);

    await (sidebandManager as Internal).schedulePhaseNudges(sessionId);
    await vi.advanceTimersByTimeAsync(MAX_DURATION_MINUTES * 60 * 1000 * 0.4);

    const injected = sentEventTypes(ws).filter(e => e.type === 'conversation.item.create');
    expect(injected.some(e => /proactively OFFERING one fitting exercise/.test(e.item.content[0].text))).toBe(true);
  });

  it('does not add the proactive reminder for the reactive-arm control (proactive_offering=false)', async () => {
    queryMock.mockImplementation((sql: string) => {
      if (sql.includes('created_at')) return Promise.resolve({ rows: [{ created_at: new Date() }] });
      if (sql.includes('proactive_offering')) return Promise.resolve({ rows: [{ proactive_offering: false }] });
      return Promise.resolve({ rows: [] });
    });
    const sessionId = 's-reactive';
    const ws = fakeWs();
    (sidebandManager as Internal).connections.set(sessionId, ws);

    await (sidebandManager as Internal).schedulePhaseNudges(sessionId);
    await vi.advanceTimersByTimeAsync(MAX_DURATION_MINUTES * 60 * 1000);

    const injected = sentEventTypes(ws).filter(e => e.type === 'conversation.item.create');
    expect(injected.some(e => /proactively OFFERING one fitting exercise/.test(e.item.content[0].text))).toBe(false);
  });

  it('is idempotent per session (a second call does not double-schedule)', async () => {
    const sessionId = 's-idempotent';
    const ws = fakeWs();
    (sidebandManager as Internal).connections.set(sessionId, ws);

    await (sidebandManager as Internal).schedulePhaseNudges(sessionId);
    const timersAfterFirst = (sidebandManager as Internal).phaseTimers.get(sessionId).length;
    await (sidebandManager as Internal).schedulePhaseNudges(sessionId);
    expect((sidebandManager as Internal).phaseTimers.get(sessionId).length).toBe(timersAfterFirst);
  });
});

describe('mid-session re-grounding (ai-therapist-49)', () => {
  it('is off by default (opt-in via features.regrounding_enabled)', async () => {
    const sessionId = 's-regrounding-off';
    const ws = fakeWs();
    (sidebandManager as Internal).connections.set(sessionId, ws);

    await (sidebandManager as Internal).scheduleRegrounding(sessionId);
    expect((sidebandManager as Internal).regroundingTimers.has(sessionId)).toBe(false);

    await vi.advanceTimersByTimeAsync(10 * 60 * 1000);
    const events = sentEventTypes(ws);
    expect(events.some(e => e.type === 'response.create' && e.response?.metadata?.purpose === 'regrounding')).toBe(false);
  });

  it('fires an out-of-band summarization response on the configured interval when enabled', async () => {
    getSystemConfigMock.mockResolvedValue({
      features: { regrounding_enabled: true, regrounding_interval_minutes: 5 },
      session_limits: { enabled: true, max_duration_minutes: MAX_DURATION_MINUTES },
    });
    const sessionId = 's-regrounding-on';
    const ws = fakeWs();
    (sidebandManager as Internal).connections.set(sessionId, ws);

    await (sidebandManager as Internal).scheduleRegrounding(sessionId);
    expect((sidebandManager as Internal).regroundingTimers.has(sessionId)).toBe(true);
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000);

    const events = sentEventTypes(ws);
    const summaryCall = events.find(e => e.type === 'response.create' && e.response?.metadata?.purpose === 'regrounding');
    expect(summaryCall).toBeTruthy();
    expect(summaryCall!.response.conversation).toBe('none');
    expect(summaryCall!.response.instructions).toMatch(/60 words or fewer/i);
  });

  it('injects a compact invisible context block when the tagged summary response completes', async () => {
    const sessionId = 's-regrounding-inject';
    const ws = fakeWs();
    (sidebandManager as Internal).connections.set(sessionId, ws);

    await sidebandManager.handleMessage(sessionId, Buffer.from(JSON.stringify({
      type: 'response.done',
      response: {
        metadata: { purpose: 'regrounding' },
        output: [{ content: [{ type: 'output_text', text: 'They are processing grief over a recent loss; tone has softened.' }] }],
      },
    })));

    const injected = sentEventTypes(ws).filter(e => e.type === 'conversation.item.create');
    const grounding = injected.find(e => /Recap so far/.test(e.item.content[0].text));
    expect(grounding).toBeTruthy();
    expect(grounding!.item.content[0].text).toMatch(/never mention or acknowledge this to the participant/i);
    expect(grounding!.item.content[0].text).toMatch(/processing grief over a recent loss/);
  });

  it('ignores a normal (non-regrounding) response.done event', async () => {
    const sessionId = 's-regrounding-ignore';
    const ws = fakeWs();
    (sidebandManager as Internal).connections.set(sessionId, ws);

    await sidebandManager.handleMessage(sessionId, Buffer.from(JSON.stringify({
      type: 'response.done',
      response: { output: [{ content: [{ type: 'output_text', text: 'A normal reply.' }] }] },
    })));

    expect(ws.send).not.toHaveBeenCalled();
  });
});

describe('reconnect guard after session end (wave1 bug 4)', () => {
  it('does NOT query or reconnect once the session has ended, even on a 1006 close', async () => {
    const sb = sidebandManager as Internal;
    const sessionId = 's-ended';

    // disconnect() marks the session ended in-memory.
    await sidebandManager.disconnect(sessionId);
    expect(sb.endedSessions.has(sessionId)).toBe(true);

    queryMock.mockClear();
    // Abnormal (1006) close arrives after the session already ended.
    await sidebandManager.handleClose(sessionId, 1006, Buffer.from(''));

    // No status lookup and no reconnect scheduled — the guard short-circuits.
    const statusQueries = queryMock.mock.calls.filter((c: unknown[]) =>
      typeof c[0] === 'string' && (c[0] as string).includes('SELECT status'));
    expect(statusQueries.length).toBe(0);
    expect(sb.reconnectAttempts.has(sessionId)).toBe(false);
  });

  it('aborts an attach retry attempt for an ended session', async () => {
    const sb = sidebandManager as Internal;
    const sessionId = 's-ended-attach';
    sb.endedSessions.add(sessionId);

    // attempt > 0 (a retry) must throw/abort rather than open a socket.
    await expect(
      sidebandManager.connect(sessionId, 'call-x', 'sk-test', 1),
    ).rejects.toThrow(/ended/i);
    expect(sb.connections.has(sessionId)).toBe(false);
  });
});

describe('tryInject (ai-therapist-112)', () => {
  it('returns false without throwing when the session has no sideband connection', async () => {
    const result = await sidebandManager.tryInject('s-no-conn', 'system', 'hello', true);
    expect(result).toBe(false);
  });

  it('injects the item (and response.create when respond=true) over a live connection', async () => {
    const sb = sidebandManager as Internal;
    const sessionId = 's-tryinject';
    const ws = fakeWs();
    sb.connections.set(sessionId, ws);

    const result = await sidebandManager.tryInject(sessionId, 'system', 'exercise finished', true);

    expect(result).toBe(true);
    const events = sentEventTypes(ws);
    expect(events.map(e => e.type)).toEqual(['conversation.item.create', 'response.create']);
    expect(events[0].item.role).toBe('system');
    expect(events[0].item.content[0].text).toBe('exercise finished');
  });

  it('omits response.create when respond=false', async () => {
    const sb = sidebandManager as Internal;
    const sessionId = 's-tryinject-quiet';
    const ws = fakeWs();
    sb.connections.set(sessionId, ws);

    const result = await sidebandManager.tryInject(sessionId, 'system', 'closing note', false);

    expect(result).toBe(true);
    expect(sentEventTypes(ws).map(e => e.type)).toEqual(['conversation.item.create']);
  });

  it('returns false when the underlying send fails', async () => {
    const sb = sidebandManager as Internal;
    const sessionId = 's-tryinject-err';
    const ws = fakeWs();
    ws.send.mockImplementation(() => { throw new Error('socket torn down'); });
    sb.connections.set(sessionId, ws);

    const result = await sidebandManager.tryInject(sessionId, 'system', 'text', false);
    expect(result).toBe(false);
  });
});

describe('startup re-attach sweep (ai-therapist-112 follow-up)', () => {
  it('re-connects each orphaned active realtime session and skips already-connected ones', async () => {
    const sb = sidebandManager as Internal;
    queryMock.mockImplementation((sql: string) => {
      if (sql.includes("status = 'active'") && sql.includes('openai_call_id')) {
        return Promise.resolve({ rows: [
          { session_id: 's-orphan-1', openai_call_id: 'call-1' },
          { session_id: 's-already', openai_call_id: 'call-2' },
        ] });
      }
      return Promise.resolve({ rows: [] });
    });
    // s-already still has a live connection (e.g. attached between query and loop).
    sb.connections.set('s-already', fakeWs());

    const connectSpy = vi.spyOn(sb, 'connect').mockImplementation(async (...args: unknown[]) => {
      const sessionId = args[0] as string;
      sb.connections.set(sessionId, fakeWs());
      return sb.connections.get(sessionId);
    });

    const { attempted } = await sidebandManager.reattachActiveSessions('sk-standard');

    expect(attempted).toBe(2);
    expect(connectSpy).toHaveBeenCalledTimes(1);
    expect(connectSpy).toHaveBeenCalledWith('s-orphan-1', 'call-1', 'sk-standard');
    connectSpy.mockRestore();
  });

  it('continues past individual re-attach failures', async () => {
    const sb = sidebandManager as Internal;
    queryMock.mockImplementation((sql: string) => {
      if (sql.includes("status = 'active'") && sql.includes('openai_call_id')) {
        return Promise.resolve({ rows: [
          { session_id: 's-dead-call', openai_call_id: 'call-gone' },
          { session_id: 's-alive', openai_call_id: 'call-ok' },
        ] });
      }
      return Promise.resolve({ rows: [] });
    });

    const connectSpy = vi.spyOn(sb, 'connect').mockImplementation(async (...args: unknown[]) => {
      const sessionId = args[0] as string;
      if (sessionId === 's-dead-call') throw new Error('404 call_id_not_found');
      sb.connections.set(sessionId, fakeWs());
      return sb.connections.get(sessionId);
    });

    const { attempted } = await sidebandManager.reattachActiveSessions('sk-standard');

    expect(attempted).toBe(2);
    expect(connectSpy).toHaveBeenCalledTimes(2);
    // The healthy session got its reconnect note injected despite the earlier failure.
    const ws = sb.connections.get('s-alive');
    expect(sentEventTypes(ws).some((e: Internal) => e.type === 'conversation.item.create')).toBe(true);
    connectSpy.mockRestore();
  });
});

describe('admin trigger-tool control (ai-therapist-103)', () => {
  it('forces tool_choice, injects the invisible nudge (with args context), and triggers a response', async () => {
    const sb = sidebandManager as Internal;
    const sessionId = 's-trigger';
    const ws = fakeWs();
    sb.connections.set(sessionId, ws);

    await sidebandManager.triggerTool(sessionId, 'start_breathing_exercise', { duration_seconds: 90 });

    const events = sentEventTypes(ws);
    expect(events.map(e => e.type)).toEqual(['session.update', 'conversation.item.create', 'response.create']);
    expect(events[0].session.tool_choice).toEqual({ type: 'function', name: 'start_breathing_exercise' });
    const nudge = events[1].item.content[0].text as string;
    expect(nudge).toMatch(/clinician overseeing this session asks you to use the start_breathing_exercise tool now/i);
    expect(nudge).toContain('"duration_seconds":90');
    expect(sb.pendingToolChoiceResets.has(sessionId)).toBe(true);
  });

  it('omits the args context when no args are given', async () => {
    const sb = sidebandManager as Internal;
    const sessionId = 's-trigger-noargs';
    const ws = fakeWs();
    sb.connections.set(sessionId, ws);

    await sidebandManager.triggerTool(sessionId, 'end_session');

    const nudge = sentEventTypes(ws).find(e => e.type === 'conversation.item.create')!.item.content[0].text as string;
    expect(nudge).not.toMatch(/context for the tool arguments/);
  });

  it('resets tool_choice to auto on the next response.done', async () => {
    const sb = sidebandManager as Internal;
    const sessionId = 's-trigger-reset';
    const ws = fakeWs();
    sb.connections.set(sessionId, ws);

    await sidebandManager.triggerTool(sessionId, 'log_mood');
    ws.send.mockClear();

    await sidebandManager.handleMessage(sessionId, Buffer.from(JSON.stringify({
      type: 'response.done',
      response: { output: [] },
    })));

    const events = sentEventTypes(ws);
    const reset = events.find(e => e.type === 'session.update');
    expect(reset).toBeTruthy();
    expect(reset!.session.tool_choice).toBe('auto');
    expect(sb.pendingToolChoiceResets.has(sessionId)).toBe(false);

    // A second response.done is a no-op (nothing pending).
    ws.send.mockClear();
    await sidebandManager.handleMessage(sessionId, Buffer.from(JSON.stringify({
      type: 'response.done',
      response: { output: [] },
    })));
    expect(ws.send).not.toHaveBeenCalled();
  });

  it('falls back to a timed reset when no response.done ever arrives', async () => {
    const sb = sidebandManager as Internal;
    const sessionId = 's-trigger-fallback';
    const ws = fakeWs();
    sb.connections.set(sessionId, ws);

    await sidebandManager.triggerTool(sessionId, 'log_mood');
    ws.send.mockClear();

    await vi.advanceTimersByTimeAsync(30 * 1000);

    const reset = sentEventTypes(ws).find(e => e.type === 'session.update');
    expect(reset!.session.tool_choice).toBe('auto');
    expect(sb.pendingToolChoiceResets.has(sessionId)).toBe(false);
  });
});

describe('hold_floor turn-taking suppression (ai-therapist-102)', () => {
  it('disables turn detection (GA audio.input nesting) and restores semantic VAD after the duration', async () => {
    const sb = sidebandManager as Internal;
    const sessionId = 's-hold';
    const ws = fakeWs();
    sb.connections.set(sessionId, ws);

    await sidebandManager.holdFloor(sessionId, 8);

    let updates = sentEventTypes(ws).filter(e => e.type === 'session.update');
    expect(updates.length).toBe(1);
    expect(updates[0].session.audio.input.turn_detection).toBeNull();
    expect(sb.holdFloorTimers.has(sessionId)).toBe(true);

    await vi.advanceTimersByTimeAsync(8 * 1000);

    updates = sentEventTypes(ws).filter(e => e.type === 'session.update');
    expect(updates.length).toBe(2);
    expect(updates[1].session.audio.input.turn_detection).toEqual({ type: 'semantic_vad', eagerness: 'low' });
    expect(sb.holdFloorTimers.has(sessionId)).toBe(false);
  });

  it('a second hold replaces the pending restore timer instead of stacking', async () => {
    const sb = sidebandManager as Internal;
    const sessionId = 's-hold-restack';
    const ws = fakeWs();
    sb.connections.set(sessionId, ws);

    await sidebandManager.holdFloor(sessionId, 5);
    await vi.advanceTimersByTimeAsync(3 * 1000);
    await sidebandManager.holdFloor(sessionId, 10);

    // 5s mark passes (old timer would have fired) — still held.
    await vi.advanceTimersByTimeAsync(4 * 1000);
    let restores = sentEventTypes(ws).filter(e =>
      e.type === 'session.update' && e.session.audio?.input?.turn_detection?.type === 'semantic_vad');
    expect(restores.length).toBe(0);

    await vi.advanceTimersByTimeAsync(6 * 1000);
    restores = sentEventTypes(ws).filter(e =>
      e.type === 'session.update' && e.session.audio?.input?.turn_detection?.type === 'semantic_vad');
    expect(restores.length).toBe(1);
  });

  it('disconnect() restores VAD defensively when a hold is pending, then clears the timer', async () => {
    const sb = sidebandManager as Internal;
    const sessionId = 's-hold-cleanup';
    const ws = fakeWs();
    (ws as Internal).close = vi.fn();
    sb.connections.set(sessionId, ws);

    await sidebandManager.holdFloor(sessionId, 15);
    await sidebandManager.disconnect(sessionId);

    const updates = sentEventTypes(ws).filter(e => e.type === 'session.update');
    expect(updates[updates.length - 1].session.audio.input.turn_detection).toEqual({ type: 'semantic_vad', eagerness: 'low' });
    expect(sb.holdFloorTimers.has(sessionId)).toBe(false);
    expect(sb.pendingToolChoiceResets.has(sessionId)).toBe(false);
  });

  it('restoreTurnDetection does not throw when the session has no live connection', async () => {
    await expect(sidebandManager.restoreTurnDetection('s-gone')).resolves.toBeUndefined();
  });
});

describe('restore resilience across sideband drops (pass-5 review)', () => {
  // Disabled VAD / forced tool_choice live in the OpenAI session and survive
  // a sideband WS drop; a restore firing during a reconnect gap must retry,
  // not silently give up.
  it('re-arms the VAD restore while disconnected and sends it once reconnected', async () => {
    const sb = sidebandManager as Internal;
    const sessionId = 's-hold-gap';
    const ws = fakeWs();
    sb.connections.set(sessionId, ws);

    await sidebandManager.holdFloor(sessionId, 5);
    // Sideband drops before the hold expires.
    sb.connections.delete(sessionId);

    await vi.advanceTimersByTimeAsync(5 * 1000);
    // Nothing sent (socket gone), but the restore is re-armed, not dropped.
    expect(sentEventTypes(ws).filter(e => e.type === 'session.update').length).toBe(1); // only the initial disable
    expect(sb.holdFloorTimers.has(sessionId)).toBe(true);

    // Sideband re-attaches; the retry timer restores semantic VAD.
    const ws2 = fakeWs();
    sb.connections.set(sessionId, ws2);
    await vi.advanceTimersByTimeAsync(2 * 1000);

    const restores = sentEventTypes(ws2).filter(e =>
      e.type === 'session.update' && e.session.audio?.input?.turn_detection?.type === 'semantic_vad');
    expect(restores.length).toBe(1);
    expect(sb.holdFloorTimers.has(sessionId)).toBe(false);
    expect(sb.holdRestoreRetries.has(sessionId)).toBe(false);
  });

  it('re-arms the tool_choice reset while disconnected and sends it once reconnected', async () => {
    const sb = sidebandManager as Internal;
    const sessionId = 's-tool-gap';
    const ws = fakeWs();
    sb.connections.set(sessionId, ws);

    await sidebandManager.triggerTool(sessionId, 'log_mood');
    // Sideband drops before any response.done; the 30s fallback fires into the gap.
    sb.connections.delete(sessionId);
    await vi.advanceTimersByTimeAsync(30 * 1000);
    expect(sb.pendingToolChoiceResets.has(sessionId)).toBe(true); // retry armed

    const ws2 = fakeWs();
    sb.connections.set(sessionId, ws2);
    await vi.advanceTimersByTimeAsync(2 * 1000);

    const reset = sentEventTypes(ws2).find(e => e.type === 'session.update');
    expect(reset!.session.tool_choice).toBe('auto');
    expect(sb.pendingToolChoiceResets.has(sessionId)).toBe(false);
    expect(sb.toolResetRetries.has(sessionId)).toBe(false);
  });

  it('gives up after the retry cap instead of retrying forever', async () => {
    const sb = sidebandManager as Internal;
    const sessionId = 's-hold-dead';
    const ws = fakeWs();
    sb.connections.set(sessionId, ws);

    await sidebandManager.holdFloor(sessionId, 1);
    sb.connections.delete(sessionId);

    // Initial fire + 10 capped retries at 2s each.
    await vi.advanceTimersByTimeAsync(1000 + 11 * 2000);
    expect(sb.holdFloorTimers.has(sessionId)).toBe(false);
    expect(sb.holdRestoreRetries.has(sessionId)).toBe(false);
  });

  it('does not retry once the session has ended', async () => {
    const sb = sidebandManager as Internal;
    const sessionId = 's-hold-ended';
    const ws = fakeWs();
    (ws as Internal).close = vi.fn();
    sb.connections.set(sessionId, ws);

    await sidebandManager.holdFloor(sessionId, 5);
    sb.connections.delete(sessionId);
    sb.endedSessions.add(sessionId);

    await vi.advanceTimersByTimeAsync(5 * 1000);
    expect(sb.holdFloorTimers.has(sessionId)).toBe(false);
    expect(sb.holdRestoreRetries.has(sessionId)).toBe(false);
  });

  it('reattachActiveSessions defensively resets tool_choice and turn_detection', async () => {
    const sb = sidebandManager as Internal;
    queryMock.mockImplementation((sql: string) => {
      if (sql.includes("status = 'active'") && sql.includes('openai_call_id')) {
        return Promise.resolve({ rows: [{ session_id: 's-reattach', openai_call_id: 'call-r' }] });
      }
      return Promise.resolve({ rows: [] });
    });
    const connectSpy = vi.spyOn(sb, 'connect').mockImplementation(async (...args: unknown[]) => {
      const sessionId = args[0] as string;
      sb.connections.set(sessionId, fakeWs());
      return sb.connections.get(sessionId);
    });

    await sidebandManager.reattachActiveSessions('sk-standard');

    const ws = sb.connections.get('s-reattach');
    const update = sentEventTypes(ws).find(e => e.type === 'session.update');
    expect(update).toBeTruthy();
    expect(update!.session.tool_choice).toBe('auto');
    expect(update!.session.audio.input.turn_detection).toEqual({ type: 'semantic_vad', eagerness: 'low' });
    connectSpy.mockRestore();
  });
});

describe('trigger-tool active-response guard (pass-5 review)', () => {
  it('rejects triggerTool while a response is in flight, then allows it after response.done', async () => {
    const sb = sidebandManager as Internal;
    const sessionId = 's-trigger-busy';
    const ws = fakeWs();
    sb.connections.set(sessionId, ws);

    await sidebandManager.handleMessage(sessionId, Buffer.from(JSON.stringify({ type: 'response.created' })));
    await expect(sidebandManager.triggerTool(sessionId, 'log_mood'))
      .rejects.toThrow(/conversation_already_has_active_response/);
    expect(ws.send).not.toHaveBeenCalled();

    await sidebandManager.handleMessage(sessionId, Buffer.from(JSON.stringify({
      type: 'response.done', response: { output: [] },
    })));
    await expect(sidebandManager.triggerTool(sessionId, 'log_mood')).resolves.toBeUndefined();
    expect(sentEventTypes(ws).some(e => e.type === 'response.create')).toBe(true);
  });
});

describe('turn-latency capture (telemetry pass 3)', () => {
  const sessionId = 's-latency';

  async function fire(event: Record<string, unknown>): Promise<void> {
    await sidebandManager.handleMessage(sessionId, Buffer.from(JSON.stringify(event)));
    // Flush the fire-and-forget dynamic-import chain.
    await vi.advanceTimersByTimeAsync(0);
  }

  it('records one row for user turn -> first audio delta -> response.done', async () => {
    (sidebandManager as Internal).connections.set(sessionId, fakeWs());

    await fire({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'i1', transcript: 'hello' });
    await vi.advanceTimersByTimeAsync(800);
    await fire({ type: 'response.output_audio.delta', item_id: 'i2', delta: 'AAAA' });
    await vi.advanceTimersByTimeAsync(2200);
    await fire({ type: 'response.done', response: { output: [{ type: 'message' }] } });

    expect(insertTurnLatencyMock).toHaveBeenCalledTimes(1);
    const row = insertTurnLatencyMock.mock.calls[0][0];
    expect(row.sessionId).toBe(sessionId);
    expect(row.channel).toBe('realtime');
    expect(row.turnIndex).toBe(1);
    expect(row.firstOutputAt!.getTime() - row.userDoneAt.getTime()).toBe(800);
    expect(row.responseDoneAt.getTime() - row.userDoneAt.getTime()).toBe(3000);
  });

  it('only the first output delta stamps time-to-first-audio', async () => {
    (sidebandManager as Internal).connections.set(sessionId, fakeWs());

    await fire({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'i1', transcript: 'hi' });
    await vi.advanceTimersByTimeAsync(500);
    await fire({ type: 'response.output_audio.delta' });
    await vi.advanceTimersByTimeAsync(500);
    await fire({ type: 'response.output_audio.delta' });
    await fire({ type: 'response.done', response: { output: [] } });

    const row = insertTurnLatencyMock.mock.calls[0][0];
    expect(row.firstOutputAt!.getTime() - row.userDoneAt.getTime()).toBe(500);
  });

  it('skips a response.done with no pending user turn (e.g. admin-triggered response)', async () => {
    (sidebandManager as Internal).connections.set(sessionId, fakeWs());

    await fire({ type: 'response.done', response: { output: [{ type: 'message' }] } });

    expect(insertTurnLatencyMock).not.toHaveBeenCalled();
  });

  it('keeps the turn pending across a tool-call-only response and records the post-tool response once', async () => {
    (sidebandManager as Internal).connections.set(sessionId, fakeWs());

    await fire({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'i1', transcript: 'help' });
    await vi.advanceTimersByTimeAsync(1000);
    // Intermediate response: function_call only, no audible output yet.
    await fire({ type: 'response.done', response: { output: [{ type: 'function_call' }] } });
    expect(insertTurnLatencyMock).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1500);
    await fire({ type: 'response.output_audio.delta' });
    await vi.advanceTimersByTimeAsync(500);
    await fire({ type: 'response.done', response: { output: [{ type: 'message' }] } });

    expect(insertTurnLatencyMock).toHaveBeenCalledTimes(1);
    const row = insertTurnLatencyMock.mock.calls[0][0];
    expect(row.firstOutputAt!.getTime() - row.userDoneAt.getTime()).toBe(2500);
    expect(row.responseDoneAt.getTime() - row.userDoneAt.getTime()).toBe(3000);

    // The consumed turn does not get double-counted by a later response.done.
    await fire({ type: 'response.done', response: { output: [{ type: 'message' }] } });
    expect(insertTurnLatencyMock).toHaveBeenCalledTimes(1);
  });

  it('an out-of-band regrounding response.done does not consume the pending turn', async () => {
    (sidebandManager as Internal).connections.set(sessionId, fakeWs());

    await fire({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'i1', transcript: 'hi' });
    await fire({
      type: 'response.done',
      response: { metadata: { purpose: 'regrounding' }, output: [{ content: [{ type: 'output_text', text: 'recap' }] }] },
    });
    expect(insertTurnLatencyMock).not.toHaveBeenCalled();

    await fire({ type: 'response.done', response: { output: [{ type: 'message' }] } });
    expect(insertTurnLatencyMock).toHaveBeenCalledTimes(1);
  });

  it('increments turn_index across measured turns', async () => {
    (sidebandManager as Internal).connections.set(sessionId, fakeWs());

    for (let i = 0; i < 2; i++) {
      await fire({ type: 'conversation.item.input_audio_transcription.completed', item_id: `t${i}`, transcript: 'x' });
      await fire({ type: 'response.done', response: { output: [{ type: 'message' }] } });
    }

    expect(insertTurnLatencyMock).toHaveBeenCalledTimes(2);
    expect(insertTurnLatencyMock.mock.calls.map(c => c[0].turnIndex)).toEqual([1, 2]);
  });
});

describe('realtime usage capture (telemetry pass 3)', () => {
  const sessionId = 's-usage';

  async function fire(event: Record<string, unknown>): Promise<void> {
    await sidebandManager.handleMessage(sessionId, Buffer.from(JSON.stringify(event)));
    await vi.advanceTimersByTimeAsync(0);
  }

  it('records response.usage with the audio/text/cached split on response.done', async () => {
    (sidebandManager as Internal).connections.set(sessionId, fakeWs());

    await fire({
      type: 'response.done',
      response: {
        id: 'resp_123',
        output: [{ type: 'message' }],
        usage: {
          input_tokens: 1200,
          output_tokens: 800,
          input_token_details: { text_tokens: 400, audio_tokens: 700, cached_tokens: 100 },
          output_token_details: { text_tokens: 300, audio_tokens: 500 },
        },
      },
    });

    expect(insertRealtimeUsageMock).toHaveBeenCalledTimes(1);
    expect(insertRealtimeUsageMock).toHaveBeenCalledWith(sessionId, 'resp_123', {
      inputTokens: 1200,
      outputTokens: 800,
      inputAudioTokens: 700,
      outputAudioTokens: 500,
      cachedTokens: 100,
    });
  });

  it('is defensive about missing detail fields (nulls, not NaN)', async () => {
    (sidebandManager as Internal).connections.set(sessionId, fakeWs());

    await fire({
      type: 'response.done',
      response: { output: [{ type: 'message' }], usage: { input_tokens: 50 } },
    });

    expect(insertRealtimeUsageMock).toHaveBeenCalledWith(sessionId, null, {
      inputTokens: 50,
      outputTokens: null,
      inputAudioTokens: null,
      outputAudioTokens: null,
      cachedTokens: null,
    });
  });

  it('skips a response.done without usage', async () => {
    (sidebandManager as Internal).connections.set(sessionId, fakeWs());

    await fire({ type: 'response.done', response: { output: [] } });

    expect(insertRealtimeUsageMock).not.toHaveBeenCalled();
  });
});
