import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { getSessionAccessInfoMock, updateSessionStatusMock, authorizeModelEndMock } = vi.hoisted(() => ({
  getSessionAccessInfoMock: vi.fn(),
  updateSessionStatusMock: vi.fn(),
  authorizeModelEndMock: vi.fn(),
}));

vi.mock('../db/index.js', () => ({
  getSessionAccessInfo: getSessionAccessInfoMock,
  updateSessionStatus: updateSessionStatusMock,
}));
vi.mock('./adminBroadcast.js', () => ({ broadcastAdminEventForSession: vi.fn() }));
vi.mock('./modelEndAuthorization.js', () => ({ authorizeModelEnd: authorizeModelEndMock }));
// hardEnd's fire-and-forget post-session imports: stub them so they resolve.
vi.mock('../services/chatTherapy.service.js', () => ({ endChatSession: vi.fn() }));
vi.mock('../services/sessionRedaction.service.js', () => ({ redactSession: vi.fn(async () => undefined) }));
vi.mock('../services/recorder.service.js', () => ({ finalize: vi.fn(async () => undefined) }));
vi.mock('../services/sessionInsights.service.js', () => ({
  generateSessionInsightsAsync: vi.fn(async () => undefined),
}));
vi.mock('../services/sessionEval.service.js', () => ({ maybeAutoEvalSession: vi.fn(async () => undefined) }));

import {
  scheduleAutoTermination,
  cancelAutoTermination,
  liftLimitForCrisis,
  getSessionTimeStatus,
  _armedCountForTests,
} from './sessionAutoTerminate.js';

const MIN = 60 * 1000;

function harness(sessionId: string, maxDurationMinutes: number, backend: 'live' | 'grok' = 'live') {
  const steer = vi.fn(async (_id: string, _text: string, _respond: boolean) => true);
  const teardown = vi.fn(async () => undefined);
  scheduleAutoTermination({ sessionId, maxDurationMinutes, steer, teardown, backend });
  return { steer, teardown };
}

const steerTexts = (steer: ReturnType<typeof vi.fn>) => steer.mock.calls.map((c) => String(c[1]));

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-11-01T12:00:00Z'));
  getSessionAccessInfoMock.mockReset().mockResolvedValue({ status: 'active' });
  updateSessionStatusMock.mockReset().mockResolvedValue(undefined);
  authorizeModelEndMock.mockReset();
});

afterEach(() => {
  for (const id of ['n1', 'c1', 'g1', 's1', 'x1']) cancelAutoTermination(id);
  vi.useRealTimers();
});

describe('normal mode', () => {
  it('tells the model the time at T-10 and T-5, nudges at T-60s, then asks for the end and backstops', async () => {
    const { steer, teardown } = harness('n1', 30);

    await vi.advanceTimersByTimeAsync(20 * MIN + 5);
    expect(steerTexts(steer)).toHaveLength(1);
    expect(steerTexts(steer)[0]).toMatch(/about 20 minutes used, 10 remaining/);

    await vi.advanceTimersByTimeAsync(5 * MIN);
    expect(steerTexts(steer)[1]).toMatch(/25 minutes used, 5 remaining/);

    await vi.advanceTimersByTimeAsync(4 * MIN);
    expect(steerTexts(steer)[2]).toMatch(/About one minute remains/);
    expect(authorizeModelEndMock).toHaveBeenCalledWith('n1');

    await vi.advanceTimersByTimeAsync(1 * MIN);
    expect(steerTexts(steer)[3]).toMatch(/TIME LIMIT REACHED/);
    expect(steer.mock.calls[3][2]).toBe(true);
    expect(updateSessionStatusMock).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(75 * 1000 + 5);
    expect(updateSessionStatusMock).toHaveBeenCalledWith('n1', 'ended', 'system');
    expect(teardown).toHaveBeenCalledWith('n1');
    expect(_armedCountForTests()).toBe(0);
  });

  it('skips the long-range notices on a short session', async () => {
    const { steer } = harness('s1', 5);
    await vi.advanceTimersByTimeAsync(4 * MIN + 5);
    expect(steerTexts(steer)).toEqual([expect.stringMatching(/About one minute remains/)]);
  });

  it('does nothing once the session is no longer active', async () => {
    const { steer } = harness('x1', 30);
    getSessionAccessInfoMock.mockResolvedValue({ status: 'ended' });
    await vi.advanceTimersByTimeAsync(31 * MIN);
    expect(steer).not.toHaveBeenCalled();
    expect(updateSessionStatusMock).not.toHaveBeenCalled();
  });
});

describe('crisis lift', () => {
  it('replaces the 15-minute limit with the vendor ceiling: no early end, crisis notices, no hard end on GPT-Live', async () => {
    const { steer, teardown } = harness('c1', 15);
    await vi.advanceTimersByTimeAsync(3 * MIN);

    const lift = liftLimitForCrisis('c1', 60);
    expect(lift).toEqual({ lifted: true, previousLimitMinutes: 15, ceilingMinutes: 60 });
    expect(getSessionTimeStatus('c1')).toMatchObject({ limitMinutes: 60, liftedForCrisis: true, elapsedMinutes: 3 });

    // The old 15-minute limit never fires.
    await vi.advanceTimersByTimeAsync(14 * MIN);
    expect(steer).not.toHaveBeenCalled();
    expect(updateSessionStatusMock).not.toHaveBeenCalled();

    // Crisis-phrased notices against the ceiling.
    await vi.advanceTimersByTimeAsync((50 - 17) * MIN + 5);
    expect(steerTexts(steer)).toHaveLength(1);
    expect(steerTexts(steer)[0]).toMatch(/about 10 minutes away/);
    expect(steerTexts(steer)[0]).toMatch(/do not end the session/i);
    await vi.advanceTimersByTimeAsync(9 * MIN);
    expect(steerTexts(steer)).toHaveLength(4); // T-5, T-2, and the T-60s reset notice
    expect(steerTexts(steer)[3]).toMatch(/do NOT call end_session/);

    // Nothing ends the session from our side.
    await vi.advanceTimersByTimeAsync(5 * MIN);
    expect(updateSessionStatusMock).not.toHaveBeenCalled();
    expect(teardown).not.toHaveBeenCalled();
    expect(authorizeModelEndMock).not.toHaveBeenCalled();
  });

  it('on Grok the graceful wrap-up moves to the ceiling instead', async () => {
    const { steer } = harness('g1', 15, 'grok');
    liftLimitForCrisis('g1', 60);
    await vi.advanceTimersByTimeAsync(60 * MIN + 5);
    const texts = steerTexts(steer);
    expect(texts[texts.length - 1]).toMatch(/must close now/);
    expect(authorizeModelEndMock).toHaveBeenCalledWith('g1');
    await vi.advanceTimersByTimeAsync(76 * 1000);
    expect(updateSessionStatusMock).toHaveBeenCalledWith('g1', 'ended', 'system');
  });

  it('is idempotent and reports when there is nothing to lift', () => {
    expect(liftLimitForCrisis('nope', 60)).toMatchObject({ lifted: false, reason: 'not_armed' });
    harness('c1', 15);
    expect(liftLimitForCrisis('c1', 60).lifted).toBe(true);
    expect(liftLimitForCrisis('c1', 60)).toMatchObject({ lifted: false, reason: 'already_lifted' });
  });

  it('getSessionTimeStatus is null for an unarmed session', () => {
    expect(getSessionTimeStatus('nope')).toBeNull();
  });
});
