// Admin session browser queries (ai-therapist-236 chunk 4): the demo/sandbox
// visibility predicate, caseload + org scope clauses and their parameter
// numbering, the 16-slot filter parameter order, and pagination. The wiped
// content, metadata projection and redaction breakdown live in their own
// adminSessions.*.test.ts files.
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn() }));
vi.mock('../config/db.js', () => ({ pool: { query: queryMock, connect: vi.fn(), on: vi.fn() } }));

import {
  getActiveSessions,
  listSessions,
  countSessions,
  getSessionWithUser,
  getRedactionStatus,
  type SessionListFilters,
} from './adminSessions.queries.js';
import { REDACTABLE_ROWS_SQL } from './redactionScope.js';

const DEMO_PREDICATE = '(ts.is_demo IS NOT TRUE OR u.is_sandbox IS TRUE)';

function caseloadClause(param: string) {
  return `AND EXISTS (SELECT 1 FROM therapist_clients tc WHERE tc.therapist_id = ${param} AND tc.client_id = ts.user_id)`;
}
// The researcher organization rule (ai-therapist-276): the owner's org equals
// the caller's, OR the session is anonymous and the caller is the irb-study
// org. Pinned as a literal so a drift in ownerOrgScopeSql shows up here too.
function orgClause(param: string) {
  return `AND (EXISTS (SELECT 1 FROM users ou WHERE ou.userid = ts.user_id AND ou.organization_id = ${param}) OR (ts.user_id IS NULL AND ${param} = (SELECT org_id FROM organizations WHERE slug = 'irb-study')))`;
}
/** The pre-276 clause that let every org see anonymous sessions. */
const LOOSE_ANONYMOUS_CLAUSE = 'ts.user_id IS NULL OR EXISTS';

const FILTERS: SessionListFilters = {
  search: 'alice',
  startDate: '2026-01-01',
  endDate: '2026-02-01',
  minMessages: 2,
  maxMessages: 50,
  limit: 25,
  offset: 50,
  voices: ['alloy'],
  languages: ['en'],
  durations: ['short'],
  sessionTypes: ['voice'],
  statuses: ['ended'],
  endedBy: ['user'],
  crisisFlagged: true,
  crisisSeverity: 'high',
  userId: 42,
};

function lastCall(): [string, unknown[]] {
  return queryMock.mock.calls[queryMock.mock.calls.length - 1] as [string, unknown[]];
}

beforeEach(() => {
  queryMock.mockReset();
  queryMock.mockResolvedValue({ rows: [] });
});

describe('getActiveSessions', () => {
  it('lists active sessions, hides demo sessions unless the owner is a sandbox user, crisis first', async () => {
    queryMock.mockResolvedValue({ rows: [{ session_id: 's1' }] });
    await expect(getActiveSessions()).resolves.toEqual([{ session_id: 's1' }]);
    const [sql, params] = lastCall();
    expect(sql).toContain("WHERE ts.status = 'active'");
    expect(sql).toContain(DEMO_PREDICATE);
    expect(sql).toMatch(/ORDER BY ts\.crisis_flagged DESC, ts\.created_at DESC/);
    expect(sql).not.toContain('therapist_clients');
    expect(sql).not.toContain('organization_id');
    expect(params).toEqual([]);
  });

  it('adds the caseload clause as $1 when scoped to a care-team member', async () => {
    await getActiveSessions(7);
    const [sql, params] = lastCall();
    expect(sql).toContain(caseloadClause('$1'));
    expect(sql).not.toContain('organization_id');
    expect(params).toEqual([7]);
  });

  it('adds the org clause as $1 when only an org scope is given', async () => {
    await getActiveSessions(null, 3);
    const [sql, params] = lastCall();
    expect(sql).not.toContain('therapist_clients');
    expect(sql).toContain(orgClause('$1'));
    expect(sql).not.toContain(LOOSE_ANONYMOUS_CLAUSE);
    expect(params).toEqual([3]);
  });

  it('numbers caseload $1 and org $2 when both scopes apply', async () => {
    await getActiveSessions(7, 3);
    const [sql, params] = lastCall();
    expect(sql).toContain(caseloadClause('$1'));
    expect(sql).toContain(orgClause('$2'));
    expect(params).toEqual([7, 3]);
  });

  it('treats undefined and null scopes the same (unscoped)', async () => {
    await getActiveSessions(undefined, undefined);
    expect(lastCall()[1]).toEqual([]);
    await getActiveSessions(null, null);
    expect(lastCall()[1]).toEqual([]);
  });
});

describe('listSessions', () => {
  it('binds every filter in its documented slot and pages with LIMIT $6 OFFSET $7', async () => {
    await listSessions(FILTERS);
    const [sql, params] = lastCall();
    expect(params).toEqual([
      'alice',
      '2026-01-01',
      '2026-02-01',
      2,
      50,
      25,
      50,
      ['alloy'],
      ['en'],
      ['voice'],
      ['ended'],
      ['user'],
      true,
      'high',
      ['short'],
      42,
    ]);
    expect(sql).toContain(DEMO_PREDICATE);
    expect(sql).toContain(
      "($1::TEXT IS NULL OR ts.session_id::TEXT ILIKE '%' || $1 || '%' OR ts.session_name ILIKE '%' || $1 || '%' OR u.username ILIKE '%' || $1 || '%')",
    );
    expect(sql).toContain('($2::TIMESTAMP IS NULL OR ts.created_at >= $2)');
    expect(sql).toContain('($3::TIMESTAMP IS NULL OR ts.created_at <= $3)');
    expect(sql).toContain('($8::TEXT[] IS NULL OR sc.voice = ANY($8))');
    expect(sql).toContain('($9::TEXT[] IS NULL OR sc.language = ANY($9))');
    expect(sql).toContain('($10::TEXT[] IS NULL OR ts.session_type = ANY($10))');
    expect(sql).toContain('($11::TEXT[] IS NULL OR ts.status = ANY($11))');
    expect(sql).toContain('($12::TEXT[] IS NULL OR ts.ended_by = ANY($12))');
    expect(sql).toContain('($13::BOOLEAN IS NULL OR ts.crisis_flagged = $13)');
    expect(sql).toContain('($14::TEXT IS NULL OR ts.crisis_severity = $14)');
    expect(sql).toContain('($16::INT IS NULL OR ts.user_id = $16)');
    // Message-count and duration filters apply to the aggregated CTE, not the raw rows.
    expect(sql).toMatch(
      /SELECT \* FROM session_stats\s+WHERE\s+\(\$4::INT IS NULL OR total_messages >= \$4\)\s+AND \(\$5::INT IS NULL OR total_messages <= \$5\)\s+AND \(\$15::TEXT\[\] IS NULL OR duration_category = ANY\(\$15\)\)/,
    );
    expect(sql).toMatch(/ORDER BY start_time DESC\s+LIMIT \$6 OFFSET \$7/);
  });

  it('sends null for an absent userId filter so the $16 predicate is a no-op', async () => {
    const { userId: _u, ...noUser } = FILTERS;
    await listSessions(noUser);
    expect(lastCall()[1][15]).toBeNull();
    expect(lastCall()[1]).toHaveLength(16);
  });

  it('appends the caseload scope as $17', async () => {
    await listSessions(FILTERS, 7);
    const [sql, params] = lastCall();
    expect(sql).toContain(caseloadClause('$17'));
    expect(sql).not.toContain('organization_id');
    expect(params).toHaveLength(17);
    expect(params[16]).toBe(7);
  });

  it('appends an org-only scope as $17', async () => {
    await listSessions(FILTERS, null, 3);
    const [sql, params] = lastCall();
    expect(sql).not.toContain('therapist_clients');
    expect(sql).toContain(orgClause('$17'));
    expect(sql).not.toContain(LOOSE_ANONYMOUS_CLAUSE);
    expect(params.slice(16)).toEqual([3]);
  });

  it('numbers caseload $17 and org $18 when both apply', async () => {
    await listSessions(FILTERS, 7, 3);
    const [sql, params] = lastCall();
    expect(sql).toContain(caseloadClause('$17'));
    expect(sql).toContain(orgClause('$18'));
    expect(params.slice(16)).toEqual([7, 3]);
  });

  it('puts the scope clauses inside the per-session CTE WHERE, before GROUP BY', async () => {
    await listSessions(FILTERS, 7, 3);
    const [sql] = lastCall();
    const scopeAt = sql.indexOf('therapist_clients');
    expect(scopeAt).toBeGreaterThan(sql.indexOf('($16::INT IS NULL OR ts.user_id = $16)'));
    expect(scopeAt).toBeLessThan(sql.indexOf('GROUP BY ts.session_id'));
  });
});

describe('countSessions', () => {
  it('counts distinct sessions under the same visibility and filters, minus pagination/message/duration', async () => {
    queryMock.mockResolvedValue({ rows: [{ total: '123' }] });
    await expect(countSessions(FILTERS)).resolves.toBe(123);
    const [sql, params] = lastCall();
    expect(sql).toContain('SELECT COUNT(DISTINCT ts.session_id) as total');
    expect(sql).toContain(DEMO_PREDICATE);
    expect(params).toEqual([
      'alice',
      '2026-01-01',
      '2026-02-01',
      ['alloy'],
      ['en'],
      ['voice'],
      ['ended'],
      ['user'],
      true,
      'high',
      42,
    ]);
    expect(sql).toContain('($4::TEXT[] IS NULL OR sc.voice = ANY($4))');
    expect(sql).toContain('($5::TEXT[] IS NULL OR sc.language = ANY($5))');
    expect(sql).toContain('($6::TEXT[] IS NULL OR ts.session_type = ANY($6))');
    expect(sql).toContain('($7::TEXT[] IS NULL OR ts.status = ANY($7))');
    expect(sql).toContain('($8::TEXT[] IS NULL OR ts.ended_by = ANY($8))');
    expect(sql).toContain('($9::BOOLEAN IS NULL OR ts.crisis_flagged = $9)');
    expect(sql).toContain('($10::TEXT IS NULL OR ts.crisis_severity = $10)');
    expect(sql).toContain('($11::INT IS NULL OR ts.user_id = $11)');
    expect(sql).not.toContain('LIMIT');
    expect(sql).not.toContain('total_messages');
    expect(sql).not.toContain('duration_category');
  });

  it('numbers caseload $12 and org $13 so the count matches the list page', async () => {
    queryMock.mockResolvedValue({ rows: [{ total: '0' }] });
    await countSessions(FILTERS, 7, 3);
    const [sql, params] = lastCall();
    expect(sql).toContain(caseloadClause('$12'));
    expect(sql).toContain(orgClause('$13'));
    expect(params.slice(11)).toEqual([7, 3]);

    await countSessions(FILTERS, null, 3);
    expect(lastCall()[0]).toContain(orgClause('$12'));
    expect(lastCall()[0]).not.toContain(LOOSE_ANONYMOUS_CLAUSE);
    expect(lastCall()[1].slice(11)).toEqual([3]);
  });
});

describe('getSessionWithUser', () => {
  it('joins the username and returns null when missing', async () => {
    await expect(getSessionWithUser('s1')).resolves.toBeNull();
    const [sql, params] = lastCall();
    expect(sql).toMatch(/LEFT JOIN users u ON ts\.user_id = u\.userid\s+WHERE ts\.session_id = \$1/);
    expect(params).toEqual(['s1']);

    queryMock.mockResolvedValue({ rows: [{ session_id: 's1', username: 'alice' }] });
    await expect(getSessionWithUser('s1')).resolves.toEqual({ session_id: 's1', username: 'alice' });
  });
});

describe('getRedactionStatus', () => {
  it('counts unredacted rows within the shared redactable scope', async () => {
    queryMock.mockResolvedValue({ rows: [{ pending_count: '4' }] });
    await expect(getRedactionStatus('s1')).resolves.toBe(4);
    const [sql, params] = lastCall();
    expect(sql).toContain(`WHERE session_id = $1 AND content_redacted IS NULL AND ${REDACTABLE_ROWS_SQL}`);
    expect(params).toEqual(['s1']);
  });
});
