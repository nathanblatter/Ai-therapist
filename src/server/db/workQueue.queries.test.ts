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
  listScreenerTrendReadings,
  expireScreenerTrendItems,
} from './workQueue.queries.js';

beforeEach(() => {
  queryMock.mockReset();
});

const ITEM = { item_id: 1, item_type: 'crisis_flag', status: 'open' };

describe('insertWorkItem', () => {
  it('is idempotent: ON CONFLICT DO NOTHING, null on duplicate', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] });
    const dup = await insertWorkItem({
      orgId: 1,
      clientId: 42,
      itemType: 'crisis_flag',
      severity: 'urgent',
      title: 'Crisis flag',
      sourceTable: 'crisis_events',
      sourceId: '9',
    });
    expect(dup).toBeNull();
    const sql = String(queryMock.mock.calls[0][0]);
    expect(sql).toContain('ON CONFLICT (item_type, source_table, source_id) DO NOTHING');
  });

  it('returns the created row and stamps is_sandbox', async () => {
    queryMock.mockResolvedValueOnce({ rows: [ITEM] });
    const row = await insertWorkItem({
      orgId: 1,
      itemType: 'inactivity',
      title: 'Inactive',
      sourceTable: 'synthetic',
      sourceId: 'inactivity:42',
      isSandbox: true,
    });
    expect(row).toEqual(ITEM);
    const params = queryMock.mock.calls[0][1] as unknown[];
    expect(params[10]).toBe(true);
  });

  it('reopen reactivates only resolved/expired rows, clearing ack/resolve state', async () => {
    queryMock.mockResolvedValueOnce({ rows: [ITEM] });
    const row = await insertWorkItem({
      orgId: 1,
      clientId: 42,
      itemType: 'crisis_flag',
      severity: 'urgent',
      title: 'Crisis flag',
      sourceTable: 'therapy_sessions',
      sourceId: 'sess-1:high',
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
      orgId: 1,
      clientId: 42,
      itemType: 'crisis_flag',
      severity: 'urgent',
      title: 'Crisis flag',
      sourceTable: 'therapy_sessions',
      sourceId: 'sess-1:high',
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
    await expect(expireWorkItemsBySource('inactivity', 'synthetic', ['inactivity:42:2026-08-27'])).resolves.toEqual([
      4,
    ]);
    expect(String(queryMock.mock.calls[0][0])).toContain(`'expired'`);
  });
});

describe('getWorkItemById', () => {
  it('returns null on a miss', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] });
    await expect(getWorkItemById(1)).resolves.toBeNull();
  });
});

describe('listScreenerTrendReadings', () => {
  it('reads only PHQ-2 / GAD-2, newest N per client+scale, for care-team clients and real participants', async () => {
    queryMock.mockResolvedValueOnce({
      rows: [{ client_id: '42', scale: 'phq2', response_id: '9', score: '4', created_at: '2026-11-15T10:00:00.000Z' }],
    });
    const rows = await listScreenerTrendReadings(114, 3);
    const sql = String(queryMock.mock.calls[0][0]);
    expect(sql).toContain(`sr.scale IN ('phq2', 'gad2')`);
    // Care-team clients, or real participants with no care team (IRB study).
    expect(sql).toContain('EXISTS (SELECT 1 FROM therapist_clients tc WHERE tc.client_id = ts.user_id)');
    expect(sql).toContain(`OR (u.role = 'participant' AND u.is_sandbox = FALSE)`);
    // Never demo/harness sessions or withdrawn participants.
    expect(sql).toContain('ts.is_demo IS NOT TRUE');
    expect(sql).toContain(`u.study_status <> 'withdrawn'`);
    expect(sql).toContain('PARTITION BY ts.user_id, sr.scale');
    expect(sql).toContain('rn <= $2');
    expect(queryMock.mock.calls[0][1]).toEqual([114, 3]);
    expect(rows).toEqual([
      { client_id: 42, scale: 'phq2', response_id: 9, score: 4, created_at: '2026-11-15T10:00:00.000Z' },
    ]);
  });
});

describe('expireScreenerTrendItems', () => {
  it('expires only open/acked screener_trend items for that client+scale, keeping the current one', async () => {
    queryMock.mockResolvedValueOnce({ rows: [ITEM] });
    await expect(expireScreenerTrendItems(42, 'phq2', 'screener_trend:42:phq2:9')).resolves.toEqual([ITEM]);
    const sql = String(queryMock.mock.calls[0][0]);
    expect(sql).toContain(`item_type = 'screener_trend'`);
    expect(sql).toContain(`detail->>'scale' = $2`);
    expect(sql).toContain(`status IN ('open', 'acked')`);
    expect(sql).toContain('source_id <> $3');
    // Supersede only when the replacement item really exists.
    expect(sql).toContain('kept.source_id = $3');
    expect(queryMock.mock.calls[0][1]).toEqual([42, 'phq2', 'screener_trend:42:phq2:9']);
  });

  it('expires every live item for the client+scale when nothing is kept (recovery)', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] });
    await expireScreenerTrendItems(42, 'gad2', null);
    expect(queryMock.mock.calls[0][1]).toEqual([42, 'gad2', null]);
  });
});

describe('screener_trend visibility (same caseload scoping as every pool item)', () => {
  it('member reads, acks and resolves gate on the caseload edge with no item-type exemption', async () => {
    queryMock.mockResolvedValue({ rows: [] });
    await listWorkItemsForMember(7);
    await ackWorkItem(1, 7);
    await resolveWorkItem(1, 7, null);
    for (const [sql] of queryMock.mock.calls) {
      expect(String(sql)).toContain('tc.therapist_id = $1 AND tc.client_id = work_items.client_id');
      expect(String(sql)).not.toContain('screener_trend');
    }
  });
});
