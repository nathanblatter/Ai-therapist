// Unit coverage for the sideband data-access: the researcher organization
// rule on both the status list (ai-therapist-276) and the by-ids query the
// admin:get-sideband-connections socket handler reads (ai-therapist-278).
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn() }));
vi.mock('../config/db.js', () => ({
  pool: { query: queryMock, connect: vi.fn(), on: vi.fn() },
}));

import { getActiveSidebandSessions, getSidebandConnectionsByIds } from './sideband.queries.js';

/** Owner in the caller's org, or anonymous and the caller is the irb-study org. */
function orgClause(param: string) {
  return `AND (EXISTS (SELECT 1 FROM users ou WHERE ou.userid = ts.user_id AND ou.organization_id = ${param}) OR (ts.user_id IS NULL AND ${param} = (SELECT org_id FROM organizations WHERE slug = 'irb-study')))`;
}

function lastCall(): [string, unknown[]] {
  return queryMock.mock.calls[queryMock.mock.calls.length - 1] as [string, unknown[]];
}

beforeEach(() => {
  queryMock.mockReset();
  queryMock.mockResolvedValue({ rows: [] });
});

describe('getSidebandConnectionsByIds', () => {
  it('binds only the id array when unscoped', async () => {
    await getSidebandConnectionsByIds(['s1', 's2']);
    const [sql, params] = lastCall();
    expect(sql).toContain('ts.session_id = ANY($1)');
    expect(sql).not.toContain('ou.organization_id');
    expect(params).toEqual([['s1', 's2']]);
    await getSidebandConnectionsByIds(['s1'], null);
    expect(lastCall()[1]).toEqual([['s1']]);
  });

  it('applies the owner-org clause as $2 for an org-bound researcher', async () => {
    await getSidebandConnectionsByIds(['s1', 's2'], 3);
    const [sql, params] = lastCall();
    expect(sql).toContain('ts.session_id = ANY($1)');
    expect(sql).toContain(orgClause('$2'));
    expect(params).toEqual([['s1', 's2'], 3]);
  });
});

describe('getActiveSidebandSessions', () => {
  it('applies the owner-org clause as $1 when scoped and binds nothing otherwise', async () => {
    await getActiveSidebandSessions(3);
    expect(lastCall()[0]).toContain(orgClause('$1'));
    expect(lastCall()[1]).toEqual([3]);
    await getActiveSidebandSessions(null);
    expect(lastCall()[0]).not.toContain('ou.organization_id');
    expect(lastCall()[1]).toEqual([]);
  });
});
