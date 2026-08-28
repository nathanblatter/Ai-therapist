// Unit coverage for the research-data export queries: per-user research-id
// stability in the anonymized export, and org scoping on the single-session
// full-export fast path (caseworker portal C13).
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn() }));
vi.mock('../config/db.js', () => ({
  pool: { query: queryMock, connect: vi.fn(), on: vi.fn() },
}));

import { getAnonymizedExport, getFullExport, type ExportFilters } from './export.queries.js';

const FILTERS: ExportFilters = {
  sessionId: null,
  startDate: null,
  endDate: null,
  crisisOnly: false,
};

beforeEach(() => {
  queryMock.mockReset();
  queryMock.mockResolvedValue({ rows: [] });
});

describe('getAnonymizedExport', () => {
  it('assigns ONE research id per user (DENSE_RANK), not one per message row', async () => {
    await getAnonymizedExport(FILTERS, 'content_redacted', null);
    const [sql] = queryMock.mock.calls[0] as [string, unknown[]];
    // ROW_NUMBER() numbers each output row, so a user with N messages would
    // get N distinct "research ids" — destroying the per-user pseudonym.
    expect(sql).not.toContain('ROW_NUMBER()');
    expect(sql).toContain('DENSE_RANK() OVER (ORDER BY u.userid)');
  });

  it('labels anonymous-session rows ANON instead of ranking NULL userids', async () => {
    await getAnonymizedExport(FILTERS, 'content_redacted', null);
    const [sql] = queryMock.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain(`CASE WHEN u.userid IS NULL THEN 'ANON'`);
  });
});

describe('getFullExport single-session fast path', () => {
  it('applies the researcher org restriction when orgId is set', async () => {
    await getFullExport({ ...FILTERS, sessionId: 'sess-1' }, 'content_redacted', 42);
    const [sql, params] = queryMock.mock.calls[0] as [string, unknown[]];
    // Without this guard an org-scoped researcher could export ANY org's
    // session content by naming its session id.
    expect(sql).toContain('ou.organization_id = $2');
    expect(sql).toContain('FROM therapy_sessions ts');
    expect(params).toEqual(['sess-1', 42]);
  });

  it('stays unscoped (org param null) when no orgId is given', async () => {
    await getFullExport({ ...FILTERS, sessionId: 'sess-1' }, 'content', null);
    const [sql, params] = queryMock.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain(`($2::int IS NULL OR EXISTS`);
    expect(params).toEqual(['sess-1', null]);
  });
});
