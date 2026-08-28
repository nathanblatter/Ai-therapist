// SQL-shape coverage for the crisis dashboard queries (red-team round 3,
// finding 5): the researcher org clause must resolve the owning user via
// COALESCE(ts.user_id, ce.client_user_id) so thread-origin crisis events
// (076: session_id NULL) are org-restricted instead of passing as anonymous.
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn() }));
vi.mock('../config/db.js', () => ({
  pool: { query: queryMock, on: vi.fn() },
}));

import { getAllCrisisData, getAllCrisisEvents } from './crisis.queries.js';

beforeEach(() => {
  queryMock.mockReset().mockResolvedValue({ rows: [] });
});

const CRISIS_ORG_CLAUSE =
  'COALESCE(ts.user_id, ce.client_user_id) IS NULL OR EXISTS (SELECT 1 FROM users ou WHERE ou.userid = COALESCE(ts.user_id, ce.client_user_id)';

describe('getAllCrisisEvents org scoping', () => {
  it('is unscoped without a therapist scope or org', async () => {
    await getAllCrisisEvents();
    const sql = String(queryMock.mock.calls[0][0]);
    expect(sql).not.toContain('organization_id');
    expect(sql).not.toContain('therapist_clients');
    expect(queryMock.mock.calls[0][1]).toEqual([]);
  });

  it('org-scopes thread-origin events via ce.client_user_id (076)', async () => {
    await getAllCrisisEvents(null, 3);
    const sql = String(queryMock.mock.calls[0][0]);
    expect(sql).toContain(CRISIS_ORG_CLAUSE);
    expect(queryMock.mock.calls[0][1]).toEqual([3]);
  });

  it('stacks the caseload scope with the org scope', async () => {
    await getAllCrisisEvents(7, 3);
    const sql = String(queryMock.mock.calls[0][0]);
    expect(sql).toContain('therapist_clients');
    expect(sql).toContain(CRISIS_ORG_CLAUSE);
    expect(queryMock.mock.calls[0][1]).toEqual([7, 3]);
  });
});

describe('getAllCrisisData org scoping', () => {
  it('applies the client_user_id-aware clause to crisis_events only; session tables keep ts.user_id', async () => {
    await getAllCrisisData(null, 3);
    expect(queryMock).toHaveBeenCalledTimes(3);
    const [crisisSql, iaSql, rshSql] = queryMock.mock.calls.map((c) => String(c[0]));
    expect(crisisSql).toContain('FROM crisis_events ce');
    expect(crisisSql).toContain(CRISIS_ORG_CLAUSE);
    for (const sql of [iaSql, rshSql]) {
      expect(sql).toContain('ts.user_id IS NULL OR EXISTS (SELECT 1 FROM users ou WHERE ou.userid = ts.user_id');
      expect(sql).not.toContain('client_user_id');
    }
    for (const call of queryMock.mock.calls) {
      expect(call[1]).toEqual([3]);
    }
  });

  it('passes no org clause when orgId is null (care-team scoped path)', async () => {
    await getAllCrisisData(7, null);
    for (const call of queryMock.mock.calls) {
      expect(String(call[0])).not.toContain('organization_id');
      expect(call[1]).toEqual([7]);
    }
  });
});
