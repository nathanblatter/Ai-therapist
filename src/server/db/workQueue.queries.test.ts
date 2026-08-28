import { describe, it, expect, vi, beforeEach } from 'vitest';

const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn() }));
vi.mock('../config/db.js', () => ({
  pool: { query: queryMock, connect: vi.fn(), on: vi.fn() },
}));

import {
  insertWorkItem,
  getWorkItemById,
  listWorkItemsForMember,
  listWorkItemsForOrg,
  ackWorkItem,
  resolveWorkItem,
  expireWorkItemsBySource,
  getSandboxWorkItemIds,
} from './workQueue.queries.js';

beforeEach(() => {
  queryMock.mockReset();
});

const ITEM = { item_id: 1, item_type: 'crisis_flag', status: 'open' };

describe('insertWorkItem', () => {
  it('is idempotent: ON CONFLICT DO NOTHING, null on duplicate', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] });
    const dup = await insertWorkItem({
      orgId: 1, clientId: 42, itemType: 'crisis_flag', severity: 'urgent',
      title: 'Crisis flag', sourceTable: 'crisis_events', sourceId: '9',
    });
    expect(dup).toBeNull();
    const sql = String(queryMock.mock.calls[0][0]);
    expect(sql).toContain('ON CONFLICT (item_type, source_table, source_id) DO NOTHING');
  });

  it('returns the created row and stamps is_sandbox', async () => {
    queryMock.mockResolvedValueOnce({ rows: [ITEM] });
    const row = await insertWorkItem({
      orgId: 1, itemType: 'inactivity', title: 'Inactive',
      sourceTable: 'synthetic', sourceId: 'inactivity:42', isSandbox: true,
    });
    expect(row).toEqual(ITEM);
    const params = queryMock.mock.calls[0][1] as unknown[];
    expect(params[10]).toBe(true);
  });

  it('reopen reactivates only resolved/expired rows, clearing ack/resolve state', async () => {
    queryMock.mockResolvedValueOnce({ rows: [ITEM] });
    const row = await insertWorkItem({
      orgId: 1, clientId: 42, itemType: 'crisis_flag', severity: 'urgent',
      title: 'Crisis flag', sourceTable: 'therapy_sessions', sourceId: 'sess-1:high',
      reopen: true,
    });
    expect(row).toEqual(ITEM);
    const sql = String(queryMock.mock.calls[0][0]);
    expect(sql).toContain('ON CONFLICT (item_type, source_table, source_id) DO UPDATE');
    expect(sql).toContain(`WHERE work_items.status IN ('resolved', 'expired')`);
    expect(sql).toContain(`status = 'open'`);
    expect(sql).toContain('acked_by = NULL');
    expect(sql).toContain('resolved_by = NULL');
    expect(sql).toContain('created_at = now()');
  });

  it('reopen still returns null (no re-notify) when the existing item is open/acked', async () => {
    // The DO UPDATE ... WHERE excludes open/acked rows: no row returned.
    queryMock.mockResolvedValueOnce({ rows: [] });
    const row = await insertWorkItem({
      orgId: 1, clientId: 42, itemType: 'crisis_flag', severity: 'urgent',
      title: 'Crisis flag', sourceTable: 'therapy_sessions', sourceId: 'sess-1:high',
      reopen: true,
    });
    expect(row).toBeNull();
  });
});

describe('getSandboxWorkItemIds', () => {
  it('no-ops on an empty list without touching the db', async () => {
    await expect(getSandboxWorkItemIds([])).resolves.toEqual([]);
    expect(queryMock).not.toHaveBeenCalled();
  });

  it('returns only sandbox item ids', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ item_id: '7' }] });
    await expect(getSandboxWorkItemIds([5, 7])).resolves.toEqual([7]);
    const sql = String(queryMock.mock.calls[0][0]);
    expect(sql).toContain('is_sandbox = TRUE');
    expect(queryMock.mock.calls[0][1]).toEqual([[5, 7]]);
  });
});

describe('member visibility', () => {
  it('list covers own items plus caseload pool items', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] });
    await listWorkItemsForMember(7);
    const sql = String(queryMock.mock.calls[0][0]);
    expect(sql).toContain('assignee_id = $1');
    expect(sql).toContain('assignee_id IS NULL');
    expect(sql).toContain('therapist_clients');
    expect(queryMock.mock.calls[0][1]).toEqual([7, ['open', 'acked'], 200]);
  });

  it('ack is guarded by status AND visibility (404-over-403 in one query)', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] });
    await expect(ackWorkItem(1, 7)).resolves.toBeNull();
    const sql = String(queryMock.mock.calls[0][0]);
    expect(sql).toContain(`status = 'open'`);
    expect(sql).toContain('assignee_id = $1');
    expect(sql).toContain('therapist_clients');
  });

  it('resolve fires from open or acked and records the note', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ ...ITEM, status: 'resolved' }] });
    await resolveWorkItem(1, 7, 'called client');
    const sql = String(queryMock.mock.calls[0][0]);
    expect(sql).toContain(`status IN ('open', 'acked')`);
    expect(queryMock.mock.calls[0][1]).toEqual([7, 1, 'called client']);
  });
});

describe('listWorkItemsForOrg', () => {
  it('filters by org and statuses', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] });
    await listWorkItemsForOrg(3, { statuses: ['resolved'], limit: 10 });
    expect(queryMock.mock.calls[0][1]).toEqual([3, ['resolved'], 10]);
  });
});

describe('expireWorkItemsBySource', () => {
  it('no-ops on an empty id list without touching the db', async () => {
    await expect(expireWorkItemsBySource('inactivity', 'synthetic', [])).resolves.toEqual([]);
    expect(queryMock).not.toHaveBeenCalled();
  });

  it('expires open/acked items and returns their ids', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ item_id: 4 }] });
    await expect(
      expireWorkItemsBySource('inactivity', 'synthetic', ['inactivity:42:2026-08-27'])
    ).resolves.toEqual([4]);
    expect(String(queryMock.mock.calls[0][0])).toContain(`'expired'`);
  });
});

describe('getWorkItemById', () => {
  it('returns null on a miss', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] });
    await expect(getWorkItemById(1)).resolves.toBeNull();
  });
});
