// ai-therapist-373: ending a session drops the crisis pipeline's in-memory copy
// of its turns (after the grace for a last turn still being scored), whether
// or not the database write succeeds.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { queryMock, clientQueryMock } = vi.hoisted(() => ({ queryMock: vi.fn(), clientQueryMock: vi.fn() }));
vi.mock('../config/db.js', () => ({
  pool: { query: queryMock, connect: async () => ({ query: clientQueryMock, release: () => undefined }) },
}));

const { updateSessionStatus, deleteSession, participantSessionIds } = await import('./sessions.queries.js');
const { setStudyStatus } = await import('./studyStatus.queries.js');
const { deleteUser } = await import('./users.queries.js');
const { recentTurns, rememberTurn, rememberSessionStart, _resetRecentTurnsForTests, RECENT_TURNS_END_GRACE_MS } =
  await import('../utils/recentTurns.js');
const {
  rememberSessionAccount,
  rememberSessionParticipant,
  knownDemoAccountSession,
  knownSessionParticipant,
  _forgetSessionAccountsForTests,
  KNOWN_ACCOUNT_END_GRACE_MS,
} = await import('../utils/sessionAccounts.js');

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2030-01-01T12:00:00Z'));
  _resetRecentTurnsForTests();
  _forgetSessionAccountsForTests();
  queryMock.mockReset();
  clientQueryMock.mockReset();
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
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

// ai-therapist-374: the other in-process session memories, and the paths that
// drop the turns at once.
describe('ending a session and the account memory', () => {
  it('the demo answer outlives the end by the grace period, then reads as unknown', async () => {
    rememberSessionAccount('s1', 'demo');
    queryMock
      .mockResolvedValueOnce({ rows: [{ session_id: 's1', status: 'active' }] })
      .mockResolvedValueOnce({ rows: [{ session_id: 's1', status: 'ended' }] });
    await updateSessionStatus('s1', 'ended', 'user');
    vi.advanceTimersByTime(KNOWN_ACCOUNT_END_GRACE_MS);
    expect(knownDemoAccountSession('s1')).toBe(true);
    vi.advanceTimersByTime(1);
    expect(knownDemoAccountSession('s1')).toBeNull();
  });

  it('a session that has not ended keeps its demo answer', async () => {
    rememberSessionAccount('s1', 'demo');
    queryMock
      .mockResolvedValueOnce({ rows: [{ session_id: 's1', status: 'active' }] })
      .mockResolvedValueOnce({ rows: [{ session_id: 's1', status: 'paused' }] });
    await updateSessionStatus('s1', 'paused');
    vi.advanceTimersByTime(KNOWN_ACCOUNT_END_GRACE_MS + 1);
    expect(knownDemoAccountSession('s1')).toBe(true);
  });

  it('the participant memory is kept after the end: the paging fold needs it', async () => {
    rememberSessionParticipant('s1', 7, { stored: false });
    queryMock
      .mockResolvedValueOnce({ rows: [{ session_id: 's1', status: 'active' }] })
      .mockResolvedValueOnce({ rows: [{ session_id: 's1', status: 'ended' }] });
    await updateSessionStatus('s1', 'ended', 'user');
    vi.advanceTimersByTime(15 * 60 * 1000 + 1);
    expect(knownSessionParticipant('s1')).toEqual({ userId: 7, stored: false });
  });
});

describe('dropping the turns at once', () => {
  it('deleting a session drops its turns with no grace', async () => {
    rememberTurn('s1', 'user', 'hi');
    rememberTurn('s2', 'user', 'other');
    clientQueryMock.mockImplementation((sql: string) =>
      Promise.resolve({ rows: String(sql).startsWith('SELECT') ? [{ session_id: 's1' }] : [] }),
    );
    await deleteSession('s1');
    expect(recentTurns('s1')).toBeNull();
    expect(recentTurns('s2')?.turns).toHaveLength(1);
  });

  it('a failed session delete keeps them', async () => {
    rememberTurn('s1', 'user', 'hi');
    clientQueryMock.mockImplementation((sql: string) =>
      String(sql).startsWith('DELETE FROM messages')
        ? Promise.reject(new Error('boom'))
        : Promise.resolve({ rows: [{ session_id: 's1' }] }),
    );
    await expect(deleteSession('s1')).rejects.toThrow('boom');
    expect(recentTurns('s1')?.turns).toHaveLength(1);
  });

  it('withdrawal drops every session of the participant: the ones the database lists and the ones started here', async () => {
    rememberTurn('listed', 'user', 'a session started in another process');
    rememberSessionStart('here', null, 7);
    rememberTurn('here', 'user', 'started here');
    rememberSessionStart('other', null, 8);
    rememberTurn('other', 'user', 'another participant');
    queryMock
      .mockResolvedValueOnce({ rows: [{ session_id: 'listed' }] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [] });

    expect(await setStudyStatus(7, 'withdrawn', 'admin')).toBe(true);

    expect(String(queryMock.mock.calls[0][0])).toContain('FROM therapy_sessions WHERE user_id = $1');
    expect(queryMock.mock.calls[0][1]).toEqual([7]);
    expect(recentTurns('listed')).toBeNull();
    expect(recentTurns('here')).toBeNull();
    expect(recentTurns('other')?.turns).toHaveLength(1);
  });

  it('withdrawal drops them even when the participant was already withdrawn', async () => {
    rememberSessionStart('here', null, 7);
    rememberTurn('here', 'user', 'started here');
    queryMock.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rowCount: 0, rows: [] });
    expect(await setStudyStatus(7, 'withdrawn', 'qualtrics')).toBe(false);
    expect(recentTurns('here')).toBeNull();
  });

  it('withdrawal: a failed session read still drops the sessions started here', async () => {
    rememberSessionStart('here', null, 7);
    rememberTurn('here', 'user', 'started here');
    queryMock.mockRejectedValueOnce(new Error('read failed')).mockResolvedValueOnce({ rowCount: 1, rows: [] });
    await setStudyStatus(7, 'withdrawn', 'admin');
    expect(recentTurns('here')).toBeNull();
  });

  it('a failed withdrawal write keeps them; a pause keeps them and reads nothing', async () => {
    rememberSessionStart('here', null, 7);
    rememberTurn('here', 'user', 'started here');
    queryMock
      .mockResolvedValueOnce({ rows: [{ session_id: 'here' }] })
      .mockRejectedValueOnce(new Error('write failed'));
    await expect(setStudyStatus(7, 'withdrawn', 'admin')).rejects.toThrow('write failed');
    expect(recentTurns('here')?.turns).toHaveLength(1);

    queryMock.mockReset();
    queryMock.mockResolvedValueOnce({ rowCount: 1, rows: [] });
    await setStudyStatus(7, 'paused', 'admin');
    expect(queryMock).toHaveBeenCalledTimes(1);
    expect(recentTurns('here')?.turns).toHaveLength(1);
  });

  it('account deletion reads the sessions BEFORE the delete (it nulls their user_id), then drops them', async () => {
    rememberTurn('listed', 'user', 'a session started in another process');
    rememberSessionStart('here', null, 7);
    rememberTurn('here', 'user', 'started here');
    queryMock
      .mockResolvedValueOnce({ rows: [{ session_id: 'listed' }] })
      .mockResolvedValueOnce({ rows: [{ userid: 7, username: 'p7' }] });

    await deleteUser(7);

    expect(String(queryMock.mock.calls[0][0])).toContain('FROM therapy_sessions WHERE user_id = $1');
    expect(String(queryMock.mock.calls[1][0])).toContain('DELETE FROM users');
    expect(recentTurns('listed')).toBeNull();
    expect(recentTurns('here')).toBeNull();
  });

  it('an account delete that finds no user keeps them', async () => {
    rememberSessionStart('here', null, 7);
    rememberTurn('here', 'user', 'started here');
    queryMock.mockResolvedValueOnce({ rows: [{ session_id: 'here' }] }).mockResolvedValueOnce({ rows: [] });
    await expect(deleteUser(7)).rejects.toThrow('User not found');
    expect(recentTurns('here')?.turns).toHaveLength(1);
  });

  it('participantSessionIds returns [] when the read fails', async () => {
    queryMock.mockRejectedValueOnce(new Error('read failed'));
    expect(await participantSessionIds(7)).toEqual([]);
  });
});
