// Caseload-RBAC scoping coverage for getAllSessions (ai-therapist-119):
// the trailing scopeTherapistId param must add the therapist_clients EXISTS
// filter when set, and leave the researcher (unscoped) SQL exactly as before.
import { describe, it, expect, beforeEach, vi } from 'vitest';

const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn() }));
vi.mock('../config/db.js', () => ({
  pool: { query: queryMock, connect: vi.fn(), on: vi.fn() },
}));

import { getAllSessions } from './sessions.queries.js';

beforeEach(() => {
  queryMock.mockReset().mockResolvedValue({ rows: [] });
});

describe('getAllSessions caseload scoping', () => {
  it('unscoped (undefined) issues today\'s SQL with no therapist_clients filter', async () => {
    await getAllSessions(50, 0);
    expect(queryMock).toHaveBeenCalledTimes(1);
    const [sql, params] = queryMock.mock.calls[0];
    expect(sql).not.toContain('therapist_clients');
    expect(params).toEqual([50, 0]);
  });

  it('null scope behaves identically to undefined (researcher path)', async () => {
    await getAllSessions(25, 10, null);
    const [sqlNull, paramsNull] = queryMock.mock.calls[0];
    await getAllSessions(25, 10);
    const [sqlUndef, paramsUndef] = queryMock.mock.calls[1];
    expect(sqlNull).toBe(sqlUndef);
    expect(paramsNull).toEqual(paramsUndef);
  });

  it('scoped adds the EXISTS therapist_clients clause as $3 with the therapist id', async () => {
    await getAllSessions(50, 0, 7);
    const [sql, params] = queryMock.mock.calls[0];
    expect(sql).toContain(
      'EXISTS (SELECT 1 FROM therapist_clients tc WHERE tc.therapist_id = $3 AND tc.client_id = ts.user_id)'
    );
    expect(params).toEqual([50, 0, 7]);
  });

  it('scoped SQL filters before grouping (WHERE precedes GROUP BY)', async () => {
    await getAllSessions(50, 0, 7);
    const [sql] = queryMock.mock.calls[0];
    expect(sql.indexOf('WHERE EXISTS')).toBeGreaterThan(-1);
    expect(sql.indexOf('WHERE EXISTS')).toBeLessThan(sql.indexOf('GROUP BY'));
  });
});
