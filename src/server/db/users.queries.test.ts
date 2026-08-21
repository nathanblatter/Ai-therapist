// Caseload-RBAC scoping coverage for getAllUsers (ai-therapist-119): when a
// therapist scope is set, the roster is caseload participants plus the
// caller's own row; unscoped (researchers) is exactly today's query.
import { describe, it, expect, beforeEach, vi } from 'vitest';

const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn() }));
vi.mock('../config/db.js', () => ({
  pool: { query: queryMock, connect: vi.fn(), on: vi.fn() },
}));

import { getAllUsers } from './users.queries.js';

beforeEach(() => {
  queryMock.mockReset().mockResolvedValue({ rows: [] });
});

describe('getAllUsers caseload scoping', () => {
  it('unscoped (undefined) issues today\'s SQL: no WHERE, no therapist_clients', async () => {
    await getAllUsers();
    const [sql, params] = queryMock.mock.calls[0];
    expect(sql).toBe(
      'SELECT userid, username, role, preferred_voice, preferred_language, mfa_enabled, mfa_enabled_at, risk_context_share_enabled, memory_enabled, created_at, updated_at FROM users ORDER BY created_at DESC'
    );
    expect(params).toEqual([]);
  });

  it('null scope behaves identically to undefined (researcher path)', async () => {
    await getAllUsers(null);
    const [sqlNull, paramsNull] = queryMock.mock.calls[0];
    await getAllUsers();
    const [sqlUndef, paramsUndef] = queryMock.mock.calls[1];
    expect(sqlNull).toBe(sqlUndef);
    expect(paramsNull).toEqual(paramsUndef);
  });

  it('scoped restricts to caseload clients OR the caller\'s own row via $1', async () => {
    await getAllUsers(7);
    const [sql, params] = queryMock.mock.calls[0];
    expect(sql).toContain(
      'WHERE (userid = $1 OR EXISTS (SELECT 1 FROM therapist_clients tc WHERE tc.therapist_id = $1 AND tc.client_id = userid))'
    );
    expect(sql).toContain('ORDER BY created_at DESC');
    expect(params).toEqual([7]);
  });
});
