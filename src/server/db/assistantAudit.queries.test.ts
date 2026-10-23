// assistant_audit read side (ai-therapist-197): filters bind in order and the
// org scope reaches both the page and the count query.
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn() }));
vi.mock('../config/db.js', () => ({
  pool: { query: queryMock, connect: vi.fn(), on: vi.fn() },
}));

import { listAssistantAudit } from './assistantAudit.queries.js';

beforeEach(() => {
  queryMock.mockReset();
});

describe('listAssistantAudit', () => {
  it('returns the page and total with filters and org bound', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{ audit_id: 1, question: 'how many sessions?' }] })
      .mockResolvedValueOnce({ rows: [{ count: '3' }] });
    const page = await listAssistantAudit({ userId: 7, username: 't', since: 'a', until: 'b', limit: 5, offset: 10 }, 2);
    expect(page.total).toBe(3);
    expect(page.rows[0]).toMatchObject({ audit_id: 1 });
    const [sql, params] = queryMock.mock.calls[0];
    expect(sql).toMatch(/FROM assistant_audit aa LEFT JOIN users u/);
    expect(sql).toMatch(/ORDER BY aa.audit_id DESC/);
    expect(params).toEqual([7, 't', 'a', 'b', 2, 5, 10]);
    expect(queryMock.mock.calls[1][1]).toEqual([7, 't', 'a', 'b', 2]);
  });

  it('binds nulls when unfiltered and unscoped', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [{ count: '0' }] });
    await listAssistantAudit({ limit: 50, offset: 0 });
    expect(queryMock.mock.calls[0][1]).toEqual([null, null, null, null, null, 50, 0]);
  });
});
