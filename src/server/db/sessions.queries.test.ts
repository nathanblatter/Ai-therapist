// ai-therapist-202: the psychoeducation-cue arm is written by its own UPDATE
// so a database without migration 123 (applied by hand) keeps working.
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn() }));
vi.mock('../config/db.js', () => ({
  pool: { query: queryMock, connect: vi.fn(), on: vi.fn() },
}));

import {
  upsertSessionConfig,
  setSessionPsychoeducationCue,
  activeSessionIdsForUser,
  userIdsInActiveSessions,
} from './sessions.queries.js';

function undefinedColumn(): Error {
  return Object.assign(new Error('column "psychoeducation_cue" does not exist'), { code: '42703' });
}

beforeEach(() => {
  queryMock.mockReset();
});

describe('upsertSessionConfig psychoeducation_cue', () => {
  it('does not touch the column when the arm is null or omitted', async () => {
    queryMock.mockResolvedValue({ rows: [{ session_id: 's1' }] });
    await upsertSessionConfig('s1', { psychoeducation_cue: null });
    await upsertSessionConfig('s2', {});
    expect(queryMock).toHaveBeenCalledTimes(2);
    for (const [sql] of queryMock.mock.calls) expect(String(sql)).not.toContain('psychoeducation_cue');
  });

  it('records a boolean arm with a separate UPDATE', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ session_id: 's1' }] }).mockResolvedValueOnce({ rowCount: 1 });
    const row = await upsertSessionConfig('s1', { psychoeducation_cue: true });
    expect(queryMock).toHaveBeenCalledTimes(2);
    expect(String(queryMock.mock.calls[1][0])).toContain('SET psychoeducation_cue = $2');
    expect(queryMock.mock.calls[1][1]).toEqual(['s1', true]);
    expect(row.psychoeducation_cue).toBe(true);
  });

  it('still returns the row when the column is missing (migration 123 not applied)', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ session_id: 's1' }] }).mockRejectedValueOnce(undefinedColumn());
    const row = await upsertSessionConfig('s1', { psychoeducation_cue: false });
    expect(row).toEqual({ session_id: 's1' });
  });
});

describe('setSessionPsychoeducationCue', () => {
  it('returns false instead of throwing on an undefined column', async () => {
    queryMock.mockRejectedValueOnce(undefinedColumn());
    await expect(setSessionPsychoeducationCue('s1', true)).resolves.toBe(false);
  });

  it('rethrows any other database error', async () => {
    queryMock.mockRejectedValueOnce(new Error('connection refused'));
    await expect(setSessionPsychoeducationCue('s1', true)).rejects.toThrow('connection refused');
  });
});

// A researcher changes or deletes an account while it is in a session
// (accounts.service endSessions): which sessions are open, and for whom.
describe('the therapy sessions open right now', () => {
  beforeEach(() => queryMock.mockReset());

  it('activeSessionIdsForUser reads the active sessions of one account, oldest first', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ session_id: 'sess_a' }, { session_id: 'sess_b' }] });
    expect(await activeSessionIdsForUser(7)).toEqual(['sess_a', 'sess_b']);
    const [sql, params] = queryMock.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain("WHERE user_id = $1 AND status = 'active'");
    expect(params).toEqual([7]);
  });

  it('userIdsInActiveSessions lists each account once and skips sessions with no account', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ user_id: '7' }, { user_id: 9 }] });
    expect(await userIdsInActiveSessions()).toEqual([7, 9]);
    const sql = String(queryMock.mock.calls[0][0]);
    expect(sql).toContain('SELECT DISTINCT user_id');
    expect(sql).toContain("status = 'active' AND user_id IS NOT NULL");
  });
});
