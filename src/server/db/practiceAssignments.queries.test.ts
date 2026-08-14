import { describe, it, expect, vi, beforeEach } from 'vitest';

const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn() }));
vi.mock('../config/db.js', () => ({
  pool: { query: queryMock, connect: vi.fn(), on: vi.fn() },
}));

import {
  insertPracticeAssignment,
  listUserAssignments,
  completeAssignment,
  countOpenAssignments,
} from './practiceAssignments.queries.js';

beforeEach(() => {
  queryMock.mockReset();
});

const ROW = {
  id: 5, user_id: 42, session_id: 's1', title: 'Two-minute breathing',
  description: 'Before bed.', kind: 'exercise', suggested_frequency: 'daily',
  status: 'assigned', assigned_at: new Date(), completed_at: null, completion_note: null,
};

describe('insertPracticeAssignment', () => {
  it('inserts with explicit values and returns the row', async () => {
    queryMock.mockResolvedValueOnce({ rows: [ROW] });
    const row = await insertPracticeAssignment({
      userId: 42, sessionId: 's1', title: 'Two-minute breathing',
      description: 'Before bed.', kind: 'exercise', suggestedFrequency: 'daily',
    });
    expect(row).toEqual(ROW);
    const [sql, params] = queryMock.mock.calls[0];
    expect(sql).toContain('INSERT INTO practice_assignments');
    expect(params).toEqual([42, 's1', 'Two-minute breathing', 'Before bed.', 'exercise', 'daily']);
  });

  it("defaults kind to 'custom' and session/frequency to null", async () => {
    queryMock.mockResolvedValueOnce({ rows: [ROW] });
    await insertPracticeAssignment({ userId: 42, title: 't', description: 'd' });
    const [, params] = queryMock.mock.calls[0];
    expect(params).toEqual([42, null, 't', 'd', 'custom', null]);
  });
});

describe('listUserAssignments', () => {
  it('scopes by user_id and passes a null status filter by default', async () => {
    queryMock.mockResolvedValueOnce({ rows: [ROW] });
    const rows = await listUserAssignments(42);
    expect(rows).toEqual([ROW]);
    const [sql, params] = queryMock.mock.calls[0];
    expect(sql).toContain('WHERE user_id = $1');
    expect(params).toEqual([42, null, 50]);
  });

  it('passes the status filter and limit through', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] });
    await listUserAssignments(42, { status: 'assigned', limit: 3 });
    expect(queryMock.mock.calls[0][1]).toEqual([42, 'assigned', 3]);
  });
});

describe('completeAssignment (scoping)', () => {
  it('updates only when BOTH id and user_id match and status is still assigned', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ ...ROW, status: 'completed' }] });
    const row = await completeAssignment(5, 42, 'went well');
    expect(row?.status).toBe('completed');
    const [sql, params] = queryMock.mock.calls[0];
    expect(sql).toContain('WHERE id = $1 AND user_id = $2');
    expect(sql).toContain("status = 'assigned'");
    expect(params).toEqual([5, 42, 'went well']);
  });

  it("returns null when the row belongs to another user (cross-user completion can't happen)", async () => {
    queryMock.mockResolvedValueOnce({ rows: [] });
    expect(await completeAssignment(5, 999)).toBeNull();
  });

  it('passes a null note when none is given', async () => {
    queryMock.mockResolvedValueOnce({ rows: [ROW] });
    await completeAssignment(5, 42);
    expect(queryMock.mock.calls[0][1]).toEqual([5, 42, null]);
  });
});

describe('countOpenAssignments', () => {
  it("counts only status = 'assigned' rows for the user", async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ count: '2' }] });
    expect(await countOpenAssignments(42)).toBe(2);
    const [sql, params] = queryMock.mock.calls[0];
    expect(sql).toContain("status = 'assigned'");
    expect(params).toEqual([42]);
  });

  it('returns 0 when there are no rows', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] });
    expect(await countOpenAssignments(42)).toBe(0);
  });
});
