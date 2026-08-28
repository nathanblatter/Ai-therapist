import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn() }));
vi.mock('../config/db.js', () => ({
  pool: { query: queryMock, connect: vi.fn(), on: vi.fn() },
}));

const updateSessionStatusMock = vi.fn().mockResolvedValue(undefined);
const getSessionMock = vi.fn();
vi.mock('../db/sessions.queries.js', () => ({
  updateSessionStatus: (...args: unknown[]) => updateSessionStatusMock(...args),
  getSession: (...args: unknown[]) => getSessionMock(...args),
}));

const redactSessionMock = vi.fn().mockResolvedValue(undefined);
vi.mock('./sessionRedaction.service.js', () => ({ redactSession: redactSessionMock }));

const finalizeMock = vi.fn().mockResolvedValue(undefined);
vi.mock('./recorder.service.js', () => ({ finalize: finalizeMock }));

const disconnectMock = vi.fn().mockResolvedValue(undefined);
vi.mock('./sidebandManager.service.js', () => ({ sidebandManager: { disconnect: disconnectMock } }));

import {
  noteSessionActivity,
  scheduleAbandonCheck,
  sweepAbandonedSessions,
  _lastActivitySizeForTests,
} from './sessionLifecycle.service.js';

beforeEach(() => {
  queryMock.mockReset();
  updateSessionStatusMock.mockClear();
  getSessionMock.mockReset();
  redactSessionMock.mockClear();
  finalizeMock.mockClear();
  disconnectMock.mockClear();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('sweepAbandonedSessions', () => {
  it('queries for active, non-demo sessions idle past the inactivity cutoff', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] });

    await sweepAbandonedSessions();

    const [sql] = queryMock.mock.calls[0];
    expect(sql).toContain("ts.status = 'active'");
    expect(sql).toContain('ts.is_demo IS NOT TRUE');
    expect(sql).toContain('GREATEST(ts.created_at, COALESCE(MAX(m.created_at), ts.created_at))');
  });

  it('finalizes every abandoned session found: ends it, disconnects sideband, redacts, uploads recording', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{ session_id: 'abandoned-1' }] }) // the sweep SELECT
    ;

    const result = await sweepAbandonedSessions();

    expect(result).toEqual({ finalized: 1 });
    expect(updateSessionStatusMock).toHaveBeenCalledWith('abandoned-1', 'ended', 'system');
    expect(disconnectMock).toHaveBeenCalledWith('abandoned-1');
    expect(redactSessionMock).toHaveBeenCalledWith('abandoned-1');
    expect(finalizeMock).toHaveBeenCalledWith('abandoned-1');
  });

  it('does nothing when no sessions are idle past the cutoff', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] });
    const result = await sweepAbandonedSessions();
    expect(result).toEqual({ finalized: 0 });
    expect(updateSessionStatusMock).not.toHaveBeenCalled();
  });
});

describe('noteSessionActivity / scheduleAbandonCheck', () => {
  it('cancels a pending abandon-check when activity is noted before the grace window elapses', async () => {
    scheduleAbandonCheck('sess-1', 1000);
    noteSessionActivity('sess-1'); // rejoin/audio chunk arrives before the timer fires

    await vi.advanceTimersByTimeAsync(1000);

    // getSession would only be called if the check actually ran.
    expect(getSessionMock).not.toHaveBeenCalled();
  });

  // Leak regression: nothing ever deleted last-activity entries, so the map
  // grew one entry per session for the life of the process.
  it('prunes dead sessions from the last-activity map instead of growing forever', () => {
    for (let i = 0; i < 549; i++) noteSessionActivity(`leak-${i}`);
    // All fresh: nothing to prune yet.
    expect(_lastActivitySizeForTests()).toBeGreaterThanOrEqual(549);
    // Everything above is now older than the inactivity timeout — dead.
    vi.advanceTimersByTime(21 * 60 * 1000);
    noteSessionActivity('fresh-1');
    expect(_lastActivitySizeForTests()).toBeLessThan(10);
  });

  it('re-checks the DB and leaves an already-ended session alone', async () => {
    getSessionMock.mockResolvedValueOnce({ status: 'ended', created_at: new Date() });

    scheduleAbandonCheck('sess-2', 1000);
    await vi.advanceTimersByTimeAsync(1000);
    await vi.runAllTicks();

    expect(getSessionMock).toHaveBeenCalledWith('sess-2');
    expect(updateSessionStatusMock).not.toHaveBeenCalled();
  });
});
