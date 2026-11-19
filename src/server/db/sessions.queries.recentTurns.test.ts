// ai-therapist-373: ending a session drops the crisis pipeline's in-memory copy
// of its turns (after the grace for a last turn still being scored), whether
// or not the database write succeeds.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn() }));
vi.mock('../config/db.js', () => ({ pool: { query: queryMock } }));

const { updateSessionStatus } = await import('./sessions.queries.js');
const { recentTurns, rememberTurn, _resetRecentTurnsForTests, RECENT_TURNS_END_GRACE_MS } = await import(
  '../utils/recentTurns.js'
);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2030-01-01T12:00:00Z'));
  _resetRecentTurnsForTests();
  queryMock.mockReset();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('updateSessionStatus and the turns kept in memory', () => {
  it('ended: kept for the grace period, then gone', async () => {
    rememberTurn('s1', 'user', 'hi');
    queryMock
      .mockResolvedValueOnce({ rows: [{ session_id: 's1', status: 'active' }] })
      .mockResolvedValueOnce({ rows: [{ session_id: 's1', status: 'ended' }] });
    await updateSessionStatus('s1', 'ended', 'user');
    expect(recentTurns('s1')?.turns).toHaveLength(1);
    vi.advanceTimersByTime(RECENT_TURNS_END_GRACE_MS + 1);
    expect(recentTurns('s1')).toBeNull();
  });

  it('ended, but the database write fails: still dropped after the grace period', async () => {
    rememberTurn('s1', 'user', 'hi');
    queryMock.mockRejectedValue(new Error('timeout exceeded when trying to connect'));
    await expect(updateSessionStatus('s1', 'ended', 'user')).rejects.toThrow();
    vi.advanceTimersByTime(RECENT_TURNS_END_GRACE_MS + 1);
    expect(recentTurns('s1')).toBeNull();
  });

  it('another status change keeps them', async () => {
    rememberTurn('s1', 'user', 'hi');
    queryMock
      .mockResolvedValueOnce({ rows: [{ session_id: 's1', status: 'active' }] })
      .mockResolvedValueOnce({ rows: [{ session_id: 's1', status: 'paused' }] });
    await updateSessionStatus('s1', 'paused');
    vi.advanceTimersByTime(RECENT_TURNS_END_GRACE_MS + 1);
    expect(recentTurns('s1')?.turns).toHaveLength(1);
  });
});
