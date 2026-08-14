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
const { queryMock, getSystemConfigMock, getActiveModalityMock, insertMessagesBatchMock } = vi.hoisted(() => ({
  queryMock: vi.fn(),
  getSystemConfigMock: vi.fn(),
  getActiveModalityMock: vi.fn(),
  insertMessagesBatchMock: vi.fn(),
}));

vi.mock('../config/db.js', () => ({ pool: { query: queryMock } }));
vi.mock('../db/index.js', () => ({ insertMessagesBatch: insertMessagesBatchMock }));
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

  it('restoreTurnDetection is a no-op when the session has no live connection', async () => {
    await expect(sidebandManager.restoreTurnDetection('s-gone')).resolves.toBeUndefined();
  });
});
