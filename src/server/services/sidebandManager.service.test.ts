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
