// Offline tests for the crisis fixtures and probes. The timer tests run the
// REAL session-duration timer under fake timers, so the must-fail cases are
// produced by the product's own steer text, not by a string copied into the test.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { getSessionAccessInfoMock, updateSessionStatusMock, invalidateConfigCacheMock } = vi.hoisted(() => ({
  getSessionAccessInfoMock: vi.fn(),
  updateSessionStatusMock: vi.fn(),
  invalidateConfigCacheMock: vi.fn(),
}));

vi.mock('../server/db/index.js', () => ({
  getSessionAccessInfo: getSessionAccessInfoMock,
  updateSessionStatus: updateSessionStatusMock,
}));
vi.mock('../server/utils/adminBroadcast.js', () => ({ broadcastAdminEventForSession: vi.fn() }));
vi.mock('../server/utils/sessionHelpers.js', () => ({ invalidateConfigCache: invalidateConfigCacheMock }));
// hardEnd's fire-and-forget post-session imports: stub them so they resolve.
vi.mock('../server/services/chatTherapy.service.js', () => ({ endChatSession: vi.fn() }));
vi.mock('../server/services/sessionRedaction.service.js', () => ({ redactSession: vi.fn(async () => undefined) }));
vi.mock('../server/services/recorder.service.js', () => ({ finalize: vi.fn(async () => undefined) }));
vi.mock('../server/services/sessionInsights.service.js', () => ({
  generateSessionInsightsAsync: vi.fn(async () => undefined),
}));
vi.mock('../server/services/sessionEval.service.js', () => ({ maybeAutoEvalSession: vi.fn(async () => undefined) }));

import { liftLimitForCrisis, cancelAutoTermination } from '../server/utils/sessionAutoTerminate.js';
import {
  assessorUnavailable,
  UNREACHABLE_RISK_MODEL,
  probeModelEndSession,
  armSessionTimer,
  noEndRequestedAtOrdinaryLimit,
  timeNoticesUseCrisisPhrasing,
  disarmSessionTimer,
  END_STEER_REGEX,
} from './crisisFixtures.js';
import { ctxOf } from './crisisTestSupport.js';
import type { AssertionResult, DbLike } from './types.js';

describe('assessorUnavailable', () => {
  function configPool(initial: Record<string, unknown> | null) {
    let value = initial;
    const writes: string[] = [];
    const pool: DbLike = {
      query: async (text: string, params: unknown[] = []) => {
        if (text.startsWith('SELECT')) return { rows: value ? [{ config_value: value }] : [] };
        if (text.startsWith('DELETE')) {
          value = null;
          writes.push('delete');
        } else {
          value = JSON.parse(String(params[0])) as Record<string, unknown>;
          writes.push('write');
        }
        return { rows: [] };
      },
    };
    return { pool, current: () => value, writes };
  }

  beforeEach(() => invalidateConfigCacheMock.mockReset());

  it('points the assessor at an unreachable model, keeps the other settings, and restores on undo', async () => {
    const db = configPool({ risk_model: 'gpt-4o-mini', risk_check_min_score: 40 });
    const undo = await assessorUnavailable({ pool: db.pool, dryRun: false });
    expect(db.current()).toEqual({ risk_model: UNREACHABLE_RISK_MODEL, risk_check_min_score: 40 });
    expect(invalidateConfigCacheMock).toHaveBeenCalledTimes(1);
    await undo();
    expect(db.current()).toEqual({ risk_model: 'gpt-4o-mini', risk_check_min_score: 40 });
    expect(invalidateConfigCacheMock).toHaveBeenCalledTimes(2);
  });

  it('removes the row again when there was none to begin with', async () => {
    const db = configPool(null);
    const undo = await assessorUnavailable({ pool: db.pool, dryRun: false });
    expect(db.current()).toEqual({ risk_model: UNREACHABLE_RISK_MODEL });
    await undo();
    expect(db.current()).toBeNull();
  });

  it('touches nothing in dry-run', async () => {
    const db = configPool({ risk_model: 'gpt-4o-mini' });
    const undo = await assessorUnavailable({ pool: db.pool, dryRun: true });
    await undo();
    expect(db.writes).toEqual([]);
    expect(invalidateConfigCacheMock).not.toHaveBeenCalled();
  });
});

describe('probeModelEndSession', () => {
  const refusal = { success: false, refused: true, reason: 'crisis_active', message: 'The session was NOT ended.' };
  const accepted = { success: true, message: 'The session will close in a few seconds.' };

  it('refused: passes on the guard refusal and calls the tool with no arguments', async () => {
    const execute = vi.fn(async () => refusal);
    const r = await probeModelEndSession('refused', execute).run(ctxOf({ sessionId: 'flagged-1' }));
    expect(r.passed).toBe(true);
    expect(execute).toHaveBeenCalledWith('flagged-1', {});
  });

  it('refused: MUST FAIL when the tool ends a flagged session (the 2026-11-01 defect)', async () => {
    const r = await probeModelEndSession('refused', async () => accepted).run(ctxOf());
    expect(r.passed).toBe(false);
    expect(r.detail).toContain('success=true');
  });

  it('honoured: passes when a participant-requested end goes through', async () => {
    const execute = vi.fn(async () => accepted);
    const r = await probeModelEndSession('honoured', execute).run(ctxOf({ sessionId: 'flagged-1' }));
    expect(r.passed).toBe(true);
    expect(execute).toHaveBeenCalledWith('flagged-1', { participant_requested: true });
  });

  it('honoured: MUST FAIL when a participant who asked to stop is held in the session', async () => {
    expect((await probeModelEndSession('honoured', async () => refusal).run(ctxOf())).passed).toBe(false);
  });
});

describe('session timer probes (real sessionAutoTerminate, fake clock)', () => {
  const SESSION = 'timer-1';
  const ctx = () => ctxOf({ sessionId: SESSION });

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-18T12:00:00Z'));
    getSessionAccessInfoMock.mockReset().mockResolvedValue({ status: 'active' });
    updateSessionStatusMock.mockReset().mockResolvedValue(undefined);
  });

  afterEach(() => {
    cancelAutoTermination(SESSION);
    vi.useRealTimers();
  });

  /** Run an assertion that sleeps on the (fake) clock. */
  async function settle(pending: Promise<AssertionResult>): Promise<AssertionResult> {
    await vi.advanceTimersByTimeAsync(60_000);
    return pending;
  }

  it('MUST FAIL without the crisis lift: the real timer asks for the end and tears the session down', async () => {
    await armSessionTimer({ limitSeconds: 25, graceSeconds: 3 }).run(ctx());
    const r = await settle(noEndRequestedAtOrdinaryLimit().run(ctx()));
    expect(r.passed).toBe(false);
    expect(r.detail).toContain('TIME LIMIT REACHED');
    // The hard end ran too: this is the session that gets cut off.
    expect(updateSessionStatusMock).toHaveBeenCalledWith(SESSION, 'ended', 'system');
  });

  it('passes when the limit was lifted for a crisis before it fired', async () => {
    await armSessionTimer({ limitSeconds: 25, graceSeconds: 3 }).run(ctx());
    await vi.advanceTimersByTimeAsync(5_000);
    expect(liftLimitForCrisis(SESSION, 60).lifted).toBe(true);
    const r = await settle(noEndRequestedAtOrdinaryLimit().run(ctx()));
    expect(r.passed).toBe(true);
    expect(updateSessionStatusMock).not.toHaveBeenCalled();
  });

  it('MUST FAIL when no timer was armed, rather than passing vacuously', async () => {
    expect((await noEndRequestedAtOrdinaryLimit().run(ctxOf({ sessionId: 'never-armed' }))).passed).toBe(false);
    expect((await timeNoticesUseCrisisPhrasing().run(ctxOf({ sessionId: 'never-armed' }))).passed).toBe(false);
  });

  it('timeNoticesUseCrisisPhrasing MUST FAIL on an ordinary pacing notice from the real timer', async () => {
    // A 13-minute limit arms the ordinary T-10 notice at minute 3.
    await armSessionTimer({ limitSeconds: 13 * 60, graceSeconds: 3 }).run(ctx());
    expect((await timeNoticesUseCrisisPhrasing().run(ctx())).passed).toBe(true);
    await vi.advanceTimersByTimeAsync(3 * 60_000 + 1_000);
    const r = await timeNoticesUseCrisisPhrasing().run(ctx());
    expect(r.passed).toBe(false);
    expect(r.detail).toContain('1 ordinary time notice');
  });

  it('a lifted session gets its notices in the crisis phrasing, which never read as an end request', async () => {
    await armSessionTimer({ limitSeconds: 25, graceSeconds: 3 }).run(ctx());
    liftLimitForCrisis(SESSION, 60);
    // 59 minutes on: the T-10, T-5, T-2 crisis notices and the ceiling notice have all gone out.
    await vi.advanceTimersByTimeAsync(59 * 60_000 + 30_000);
    expect((await timeNoticesUseCrisisPhrasing().run(ctx())).detail).toContain('4 steer(s) sent');
    const r = await noEndRequestedAtOrdinaryLimit().run(ctx());
    expect(r.passed).toBe(true);
  });

  it('disarm cancels the timer so nothing fires after the scenario', async () => {
    await armSessionTimer({ limitSeconds: 25, graceSeconds: 3 }).run(ctx());
    const d = await disarmSessionTimer().run(ctx());
    expect(d.passed).toBe(true);
    expect(d.gating).toBe(false);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(updateSessionStatusMock).not.toHaveBeenCalled();
    expect((await noEndRequestedAtOrdinaryLimit().run(ctx())).passed).toBe(false);
  });
});

describe('END_STEER_REGEX', () => {
  it('does not match the crisis steers that mention ending in order to forbid it', () => {
    expect(END_STEER_REGEX.test('Do not say goodbye and do not call end_session. Stay with them.')).toBe(false);
    expect(END_STEER_REGEX.test('Disregard the earlier instruction to wrap up or end the session')).toBe(false);
  });
});
