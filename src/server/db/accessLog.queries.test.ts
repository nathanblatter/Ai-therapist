// Data-access audit log (091): rows are appended with the right shape, and a
// log failure NEVER propagates — audit logging must not break the data access
// it records.
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn() }));
vi.mock('../config/db.js', () => ({
  pool: { query: queryMock, connect: vi.fn(), on: vi.fn() },
}));

import { logDataAccess } from './accessLog.queries.js';

beforeEach(() => {
  queryMock.mockReset().mockResolvedValue({ rowCount: 1, rows: [] });
});

describe('logDataAccess', () => {
  it('inserts an append-only row with actor, action, and detail', async () => {
    await logDataAccess({
      accessedBy: 7,
      role: 'researcher',
      action: 'transcript_view',
      sessionId: 'abc-123',
      userId: 42,
      detail: { contentColumn: 'content_redacted' },
    });
    expect(queryMock.mock.calls[0][0]).toMatch(/INSERT INTO data_access_log/);
    expect(queryMock.mock.calls[0][1]).toEqual([
      7,
      'researcher',
      'transcript_view',
      'abc-123',
      42,
      JSON.stringify({ contentColumn: 'content_redacted' }),
    ]);
  });

  it('defaults optional fields to null', async () => {
    await logDataAccess({ accessedBy: null, role: null, action: 'dataset_export' });
    expect(queryMock.mock.calls[0][1]).toEqual([null, null, 'dataset_export', null, null, null]);
  });

  it('never rejects when the insert fails (fire-and-forget)', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    queryMock.mockRejectedValueOnce(new Error('db down'));
    await expect(
      logDataAccess({ accessedBy: 1, role: 'therapist', action: 'export' })
    ).resolves.toBeUndefined();
    expect(consoleSpy).toHaveBeenCalled();
    consoleSpy.mockRestore();
  });
});
