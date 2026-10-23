// Unit coverage for the research-data export queries: per-user research-id
// stability in the anonymized export, org scoping on the single-session
// full-export fast path (caseworker portal C13), and the metadata allowlist on
// redacted-content export paths (ai-therapist-217).
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn() }));
vi.mock('../config/db.js', () => ({
  pool: { query: queryMock, connect: vi.fn(), on: vi.fn() },
}));

import {
  getAggregatedExport,
  getAnonymizedExport,
  getFullExport,
  getMetadataExport,
  type ExportFilters,
} from './export.queries.js';

const FILTERS: ExportFilters = {
  sessionId: null,
  startDate: null,
  endDate: null,
  crisisOnly: false,
};

/** The researcher organization rule (ai-therapist-278): owner in the caller's
 *  org, or anonymous and the caller is the irb-study org. Pinned verbatim so a
 *  drift back to "every org sees anonymous sessions" fails here. */
function orgClause(param: string) {
  return `AND (EXISTS (SELECT 1 FROM users ou WHERE ou.userid = ts.user_id AND ou.organization_id = ${param}) OR (ts.user_id IS NULL AND ${param} = (SELECT org_id FROM organizations WHERE slug = 'irb-study')))`;
}
/** The pre-278 clause that let every org export anonymous sessions. */
const LOOSE_ANONYMOUS_CLAUSE = 'ts.user_id IS NULL OR EXISTS';

function lastCall(): [string, unknown[]] {
  return queryMock.mock.calls[queryMock.mock.calls.length - 1] as [string, unknown[]];
}

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

describe('researcher org scoping on the list exports (ai-therapist-278)', () => {
  const SCOPED = { ...FILTERS, startDate: '2026-01-01', endDate: '2026-02-01', crisisOnly: true };

  it('getMetadataExport appends the owner-org clause as $5 after the four filters', async () => {
    await getMetadataExport(SCOPED, 3);
    const [sql, params] = lastCall();
    expect(sql).toContain(orgClause('$5'));
    expect(sql).not.toContain(LOOSE_ANONYMOUS_CLAUSE);
    expect(params).toEqual([null, '2026-01-01', '2026-02-01', true, 3]);
  });

  it('getAnonymizedExport appends the owner-org clause as $5', async () => {
    await getAnonymizedExport(SCOPED, 'content_redacted', 3);
    const [sql, params] = lastCall();
    expect(sql).toContain(orgClause('$5'));
    expect(sql).not.toContain(LOOSE_ANONYMOUS_CLAUSE);
    expect(params).toEqual([null, '2026-01-01', '2026-02-01', true, 3]);
  });

  it('getAggregatedExport appends the owner-org clause as $4 after the three filters', async () => {
    await getAggregatedExport(SCOPED, 'day', 3);
    const [sql, params] = lastCall();
    expect(sql).toContain(orgClause('$4'));
    expect(sql).not.toContain(LOOSE_ANONYMOUS_CLAUSE);
    expect(params).toEqual(['2026-01-01', '2026-02-01', true, 3]);
  });

  it('getFullExport (date range) appends the owner-org clause as $4', async () => {
    await getFullExport(SCOPED, 'content_redacted', 3);
    const [sql, params] = lastCall();
    expect(sql).toContain(orgClause('$4'));
    expect(sql).not.toContain(LOOSE_ANONYMOUS_CLAUSE);
    expect(params).toEqual(['2026-01-01', '2026-02-01', true, 3]);
  });

  it('binds no org parameter when orgId is null or undefined', async () => {
    await getMetadataExport(SCOPED, null);
    expect(lastCall()[1]).toEqual([null, '2026-01-01', '2026-02-01', true]);
    expect(lastCall()[0]).not.toContain('ou.organization_id');
    await getAggregatedExport(SCOPED, 'week');
    expect(lastCall()[1]).toEqual(['2026-01-01', '2026-02-01', true]);
    expect(lastCall()[0]).not.toContain('ou.organization_id');
  });
});

describe('getFullExport single-session fast path', () => {
  it('applies the researcher org restriction when orgId is set', async () => {
    await getFullExport({ ...FILTERS, sessionId: 'sess-1' }, 'content_redacted', 42);
    const [sql, params] = queryMock.mock.calls[0] as [string, unknown[]];
    // Without this guard an org-scoped researcher could export ANY org's
    // session content by naming its session id. Same owner-org rule as the
    // list exports: an anonymous session only for the irb-study org.
    expect(sql).toContain(orgClause('$2'));
    expect(sql).not.toContain(LOOSE_ANONYMOUS_CLAUSE);
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

// ai-therapist-217: `m.metadata as extras` sat next to `content_redacted` and
// carried verbatim participant free text (tool arguments, thought-record
// fields, scale free text), bypassing the redaction the column exists for.
const ROW_METADATA = {
  tool_name: 'log_thought_record',
  call_id: 'call_1',
  channel: 'chat',
  status: 'completed',
  arguments: { situation: 'my father David hit me', mood: 'afraid' },
  response: { saved: true, note: 'my father David hit me' },
  admin_user: 'admin1',
};

function mockOneRow() {
  queryMock.mockResolvedValue({
    rows: [{ id: 1, message: 'redacted', extras: { ...ROW_METADATA } }],
  });
}

describe('metadata allowlist on redacted export paths', () => {
  const REDACTED_PATHS: Array<[string, () => Promise<Record<string, unknown>[]>]> = [
    ['getAnonymizedExport', () => getAnonymizedExport(FILTERS, 'content_redacted', null)],
    ['getFullExport', () => getFullExport(FILTERS, 'content_redacted', null)],
    ['getFullExport single-session', () =>
      getFullExport({ ...FILTERS, sessionId: 'sess-1' }, 'content_redacted', null)],
  ];

  for (const [name, run] of REDACTED_PATHS) {
    it(`${name} strips PHI-bearing metadata keys`, async () => {
      mockOneRow();
      const [row] = await run();
      expect(row['extras']).not.toHaveProperty('arguments');
      expect(row['extras']).not.toHaveProperty('response');
      expect(JSON.stringify(row['extras'])).not.toContain('David');
    });

    it(`${name} keeps telemetry-safe metadata keys`, async () => {
      mockOneRow();
      const [row] = await run();
      expect(row['extras']).toEqual({
        tool_name: 'log_thought_record',
        call_id: 'call_1',
        channel: 'chat',
        status: 'completed',
      });
    });
  }

  it('leaves metadata intact on the raw-content (therapist) path', async () => {
    mockOneRow();
    const [row] = await getFullExport(FILTERS, 'content', null);
    expect(row['extras']).toEqual(ROW_METADATA);
  });
});

describe('raw-content export after the retention wipe (ai-therapist-234)', () => {
  it('falls back to the redacted copy per row on the therapist path', async () => {
    await getFullExport({ ...FILTERS, sessionId: 's1' }, 'content', null);
    const [sql] = queryMock.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('COALESCE(m.content, m.content_redacted) as message');
  });

  it('keeps the redacted path on content_redacted only', async () => {
    await getAnonymizedExport(FILTERS, 'content_redacted', null);
    const [sql] = queryMock.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('m.content_redacted as message');
    expect(sql).not.toContain('COALESCE(m.content');
  });
});
