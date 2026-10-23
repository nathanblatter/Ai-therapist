import { describe, it, expect, vi, beforeEach } from 'vitest';

const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn() }));
vi.mock('../config/db.js', () => ({
  pool: { query: queryMock, connect: vi.fn(), on: vi.fn() },
}));

import { insertPracticeAssignment, listUserAssignments, completeAssignment } from './practiceAssignments.queries.js';

beforeEach(() => {
  queryMock.mockReset();
});

const ROW = {
  id: 5,
  user_id: 42,
  session_id: 's1',
  title: 'Two-minute breathing',
  description: 'Before bed.',
  kind: 'exercise',
  suggested_frequency: 'daily',
  status: 'assigned',
  assigned_at: new Date(),
  completed_at: null,
  completion_note: null,
};

describe('insertPracticeAssignment', () => {
  it('inserts with explicit values and returns the row', async () => {
    queryMock.mockResolvedValueOnce({ rows: [ROW] });
    const row = await insertPracticeAssignment({
      userId: 42,
      sessionId: 's1',
      title: 'Two-minute breathing',
      description: 'Before bed.',
      kind: 'exercise',
      suggestedFrequency: 'daily',
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

// ---------- clinician half (ai-therapist-200) ----------

import {
  createAssignment,
  updateAssignment,
  cancelAssignment,
  reissueAssignment,
  listAssignmentsForClient,
} from './practiceAssignments.queries.js';

describe('listUserAssignments (participant view)', () => {
  it('never returns cancelled rows', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] });
    await listUserAssignments(42);
    expect(String(queryMock.mock.calls[0][0])).toContain("status <> 'cancelled'");
  });
});

describe('createAssignment', () => {
  it("inserts with source 'therapist' and the author id", async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ ...ROW, source: 'therapist', authored_by: 9 }] });
    const row = await createAssignment({
      userId: 42,
      authoredBy: 9,
      title: 'Worry log',
      description: 'd',
      kind: 'worksheet',
      suggestedFrequency: 'daily',
    });
    expect(row.source).toBe('therapist');
    const [sql, params] = queryMock.mock.calls[0];
    expect(sql).toContain("'therapist'");
    expect(params).toEqual([42, 'Worry log', 'd', 'worksheet', 'daily', 9]);
  });
});

describe('updateAssignment', () => {
  it('is scoped by (id, user_id) and only edits open rows', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ ...ROW, title: 'Edited' }] });
    const row = await updateAssignment(5, 42, { title: 'Edited' });
    expect(row?.title).toBe('Edited');
    const [sql, params] = queryMock.mock.calls[0];
    expect(sql).toContain("WHERE id = $1 AND user_id = $2 AND status = 'assigned'");
    // Untouched fields pass null (COALESCE keeps them); frequency flag off.
    expect(params).toEqual([5, 42, 'Edited', null, null, false, null]);
  });

  it('can clear the frequency explicitly (flag on, value null)', async () => {
    queryMock.mockResolvedValueOnce({ rows: [ROW] });
    await updateAssignment(5, 42, { suggestedFrequency: null });
    expect(queryMock.mock.calls[0][1]).toEqual([5, 42, null, null, null, true, null]);
  });

  it('returns null when no open row matched', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] });
    expect(await updateAssignment(5, 999, { title: 'x' })).toBeNull();
  });
});

describe('cancelAssignment', () => {
  it('flips status to cancelled with reason + actor, never deletes', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ ...ROW, status: 'cancelled' }] });
    const row = await cancelAssignment(5, 42, 9, 'superseded');
    expect(row?.status).toBe('cancelled');
    const [sql, params] = queryMock.mock.calls[0];
    expect(sql).toContain("SET status = 'cancelled'");
    expect(sql).not.toMatch(/DELETE/i);
    expect(sql).toContain("WHERE id = $1 AND user_id = $2 AND status = 'assigned'");
    expect(params).toEqual([5, 42, 9, 'superseded']);
  });
});

describe('reissueAssignment', () => {
  it('inserts a new row copied from a CLOSED original, linked via reissued_from', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ ...ROW, id: 6, reissued_from: 5 }] });
    const row = await reissueAssignment(5, 42, 9);
    expect(row?.reissued_from).toBe(5);
    const [sql, params] = queryMock.mock.calls[0];
    expect(sql).toContain('INSERT INTO practice_assignments');
    expect(sql).toContain('reissued_from');
    expect(sql).toContain("WHERE id = $1 AND user_id = $2 AND status <> 'assigned'");
    expect(params).toEqual([5, 42, 9]);
  });

  it('returns null when the original is still open', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] });
    expect(await reissueAssignment(5, 42, 9)).toBeNull();
  });
});

describe('listAssignmentsForClient', () => {
  it('returns every status with author/canceller usernames, newest first', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ ...ROW, authored_by_username: 'dr_t', cancelled_by_username: null }] });
    const rows = await listAssignmentsForClient(42);
    expect(rows[0].authored_by_username).toBe('dr_t');
    const [sql, params] = queryMock.mock.calls[0];
    expect(sql).toContain('WHERE pa.user_id = $1');
    expect(sql).not.toContain('status');
    expect(sql).toContain('ORDER BY pa.assigned_at DESC');
    expect(params).toEqual([42, 100]);
  });
});
