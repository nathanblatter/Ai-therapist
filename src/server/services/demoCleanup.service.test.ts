import { describe, it, expect, beforeEach, vi } from 'vitest';

const { queryMock, deleteObjectMock } = vi.hoisted(() => ({
  queryMock: vi.fn(),
  deleteObjectMock: vi.fn(),
}));
vi.mock('../config/db.js', () => ({
  pool: { query: queryMock, connect: vi.fn(), on: vi.fn() },
}));
vi.mock('../config/objectStorage.js', () => ({
  deleteObject: deleteObjectMock,
}));

import { runDemoCleanup } from './demoCleanup.service.js';

beforeEach(() => {
  queryMock.mockReset();
  deleteObjectMock.mockReset();
});

describe('runDemoCleanup', () => {
  it('does nothing when no demo users have expired', async () => {
    queryMock.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const result = await runDemoCleanup(7);

    expect(result).toEqual({ usersDeleted: 0, sessionsDeleted: 0, recordingsDeleted: 0 });
    expect(queryMock).toHaveBeenCalledTimes(1); // only the SELECT, no deletes
    expect(deleteObjectMock).not.toHaveBeenCalled();
  });

  it('only targets users with role demo older than the cutoff', async () => {
    queryMock.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    await runDemoCleanup(14);

    const [sql, params] = queryMock.mock.calls[0];
    expect(sql).toContain("role = 'demo'");
    expect(sql).toContain('created_at <');
    expect(params).toEqual([14]);
  });

  it('deletes recordings, then sessions, then users for expired demo accounts', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{ userid: 1 }, { userid: 2 }], rowCount: 2 }) // expired
      .mockResolvedValueOnce({ rows: [{ recording_object_key: 'rec/a.wav' }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 3 }) // sessions delete
      .mockResolvedValueOnce({ rows: [], rowCount: 2 }); // users delete

    const result = await runDemoCleanup(7);

    expect(result).toEqual({ usersDeleted: 2, sessionsDeleted: 3, recordingsDeleted: 1 });
    expect(deleteObjectMock).toHaveBeenCalledWith('rec/a.wav');

    // Sessions must go before users: therapy_sessions.user_id is ON DELETE SET
    // NULL, so the reverse order would orphan sessions as anonymous rows.
    const deleteOrder = queryMock.mock.calls
      .map(c => c[0] as string)
      .filter(t => t.startsWith('DELETE'));
    expect(deleteOrder[0]).toContain('therapy_sessions');
    expect(deleteOrder[1]).toContain('users');
    expect(queryMock.mock.calls[2][1]).toEqual([[1, 2]]);
    expect(queryMock.mock.calls[3][1]).toEqual([[1, 2]]);
  });

  it('a failed MinIO delete does not stop the DB sweep', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{ userid: 9 }], rowCount: 1 })
      .mockResolvedValueOnce({
        rows: [{ recording_object_key: 'rec/bad.wav' }, { recording_object_key: 'rec/ok.wav' }],
        rowCount: 2,
      })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 });
    deleteObjectMock
      .mockRejectedValueOnce(new Error('minio down'))
      .mockResolvedValueOnce(undefined);

    const result = await runDemoCleanup(7);

    expect(result).toEqual({ usersDeleted: 1, sessionsDeleted: 1, recordingsDeleted: 1 });
  });
});
