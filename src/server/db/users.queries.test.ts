// Caseload-RBAC scoping coverage for getAllUsers (ai-therapist-119): when a
// therapist scope is set, the roster is caseload participants plus the
// caller's own row; unscoped (researchers) is exactly today's query.
import { describe, it, expect, beforeEach, vi } from 'vitest';

const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn() }));
vi.mock('../config/db.js', () => ({
  pool: { query: queryMock, connect: vi.fn(), on: vi.fn() },
}));

import { getAllUsers, createUser, ResearchOrgCaseworkerError } from './users.queries.js';

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

describe('createUser research-org caseworker invariant', () => {
  it('throws ResearchOrgCaseworkerError when the target org kind is research', async () => {
    queryMock.mockReset().mockResolvedValueOnce({ rows: [{ kind: 'research' }] });
    await expect(createUser('cw1', 'twelvechars!', 'caseworker')).rejects.toBeInstanceOf(
      ResearchOrgCaseworkerError
    );
    // Fails closed before the INSERT.
    expect(queryMock).toHaveBeenCalledTimes(1);
  });

  it('fails closed when the org cannot be resolved at all', async () => {
    queryMock.mockReset().mockResolvedValueOnce({ rows: [] });
    await expect(createUser('cw1', 'twelvechars!', 'caseworker', { orgId: 999 })).rejects.toBeInstanceOf(
      ResearchOrgCaseworkerError
    );
  });

  it('creates a caseworker in a non-research org', async () => {
    queryMock
      .mockReset()
      .mockResolvedValueOnce({ rows: [{ kind: 'practice' }] })
      .mockResolvedValueOnce({
        rows: [{ userid: 9, username: 'cw1', role: 'caseworker', organization_id: 2, is_sandbox: false }],
      });
    const user = await createUser('cw1', 'twelvechars!', 'caseworker', { orgId: 2 });
    expect(user.userid).toBe(9);
    expect(queryMock).toHaveBeenCalledTimes(2);
    expect(queryMock.mock.calls[1][0]).toMatch(/INSERT INTO users/);
  });

  it('does not run the org-kind check for non-caseworker roles', async () => {
    queryMock.mockReset().mockResolvedValueOnce({
      rows: [{ userid: 10, username: 'p1', role: 'participant', organization_id: 1, is_sandbox: false }],
    });
    await createUser('p1', 'twelvechars!', 'participant');
    expect(queryMock).toHaveBeenCalledTimes(1);
    expect(queryMock.mock.calls[0][0]).toMatch(/INSERT INTO users/);
  });
});
