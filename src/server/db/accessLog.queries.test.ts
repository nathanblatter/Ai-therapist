// Data-access audit log (091): rows are appended with the right shape, and a
// log failure NEVER propagates — audit logging must not break the data access
// it records.
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn() }));
vi.mock('../config/db.js', () => ({
  pool: { query: queryMock, connect: vi.fn(), on: vi.fn() },
}));

import {
  logDataAccess,
  listDataAccessLog,
  getParticipantAccessHistory,
  isDataAccessAction,
} from './accessLog.queries.js';

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
    await expect(logDataAccess({ accessedBy: 1, role: 'therapist', action: 'export' })).resolves.toBeUndefined();
    expect(consoleSpy).toHaveBeenCalled();
    consoleSpy.mockRestore();
  });
});

describe('listDataAccessLog', () => {
  it('runs the page and count queries with every filter bound, org-scoped', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ id: 1 }] }).mockResolvedValueOnce({ rows: [{ count: '12' }] });
    const page = await listDataAccessLog(
      {
        participantUserId: 42,
        sessionId: 's',
        actorUsername: 'r',
        action: 'export',
        since: 'a',
        until: 'b',
        limit: 25,
        offset: 50,
      },
      3,
    );
    expect(page).toEqual({ rows: [{ id: 1 }], total: 12 });
    const [pageSql, pageParams] = queryMock.mock.calls[0];
    expect(pageSql).toMatch(/FROM data_access_log dal/);
    expect(pageSql).toMatch(/LEFT JOIN therapy_sessions ts/);
    expect(pageSql).toMatch(/ORDER BY dal.id DESC/);
    expect(pageParams).toEqual([42, 's', 'r', 'export', 'a', 'b', 3, 25, 50]);
    const [countSql, countParams] = queryMock.mock.calls[1];
    expect(countSql).toMatch(/SELECT COUNT\(\*\)/);
    expect(countParams).toEqual([42, 's', 'r', 'export', 'a', 'b', 3]);
  });

  it('binds nulls for absent filters and an unscoped org', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [{ count: '0' }] });
    await listDataAccessLog({ limit: 10, offset: 0 });
    expect(queryMock.mock.calls[0][1]).toEqual([null, null, null, null, null, null, null, 10, 0]);
  });
});

describe('getParticipantAccessHistory', () => {
  it('returns rows, total and the per-actor rollup keyed to the participant', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{ id: 2 }] })
      .mockResolvedValueOnce({ rows: [{ count: '1' }] })
      .mockResolvedValueOnce({ rows: [{ accessed_by: 7, action: 'transcript_view', count: 1 }] });
    const history = await getParticipantAccessHistory(42, { limit: 20, offset: 0 });
    expect(history.total).toBe(1);
    expect(history.rows).toEqual([{ id: 2 }]);
    expect(history.actors[0]).toMatchObject({ accessed_by: 7 });
    for (const [sql, params] of queryMock.mock.calls) {
      expect(sql).toMatch(/COALESCE\(dal.user_id, ts.user_id\) = \$1/);
      expect(params[0]).toBe(42);
    }
    expect(queryMock.mock.calls[2][0]).toMatch(/GROUP BY dal.accessed_by/);
  });
});

describe('isDataAccessAction', () => {
  it('accepts the known actions including the self-audit one and rejects others', () => {
    expect(isDataAccessAction('transcript_view')).toBe(true);
    expect(isDataAccessAction('audit_log_view')).toBe(true);
    expect(isDataAccessAction('worksheet_review')).toBe(true);
    expect(isDataAccessAction('drop_table')).toBe(false);
    expect(isDataAccessAction(7)).toBe(false);
  });
});
