import { describe, it, expect, vi, beforeEach } from 'vitest';

const { queryMock, clientQueryMock, releaseMock, connectMock } = vi.hoisted(() => {
  const clientQueryMock = vi.fn();
  const releaseMock = vi.fn();
  const connectMock = vi.fn(async () => ({ query: clientQueryMock, release: releaseMock }));
  return { queryMock: vi.fn(), clientQueryMock, releaseMock, connectMock };
});
vi.mock('../config/db.js', () => ({
  pool: { query: queryMock, connect: connectMock, on: vi.fn() },
}));

import {
  createSandboxInviteBatch,
  findSandboxInviteByToken,
  consumeSandboxInvite,
  markSandboxInviteUsed,
  markSandboxInviteUsedAudited,
  releaseSandboxInvite,
  listSandboxInviteBatches,
} from './sandboxInvites.queries.js';

beforeEach(() => {
  queryMock.mockReset();
  clientQueryMock.mockReset();
  releaseMock.mockReset();
  connectMock.mockClear();
});

describe('markSandboxInviteUsedAudited (bookkeeping + audit in one transaction, ai-therapist-154)', () => {
  const clientSql = () => clientQueryMock.mock.calls.map((c) => String(c[0]).trim().split(/\s+/)[0]);
  const AUDIT = { therapistId: 99, clientId: null, actorUserId: 99, actorUsername: 'owner', detail: { sandbox: true } };

  it('stamps used_by/org_id and writes the invite_consumed row, then COMMITs', async () => {
    clientQueryMock.mockResolvedValue({ rows: [], rowCount: 1 });
    await markSandboxInviteUsedAudited(4, 99, 12, AUDIT);
    expect(clientSql()).toEqual(['BEGIN', 'UPDATE', 'INSERT', 'COMMIT']);
    expect(queryMock).not.toHaveBeenCalled();
    expect(clientQueryMock.mock.calls[1][1]).toEqual([99, 12, 4]);
    const [auditSql, auditParams] = clientQueryMock.mock.calls[2] as [string, unknown[]];
    expect(auditSql).toContain('caseload_audit_log');
    expect(auditParams).toEqual(['invite_consumed', 99, null, 99, 'owner', JSON.stringify({ sandbox: true })]);
    expect(releaseMock).toHaveBeenCalledTimes(1);
  });

  it('ROLLBACKs the stamp when the audit insert fails, and rethrows', async () => {
    clientQueryMock.mockImplementation(async (sql: string) => {
      if (/caseload_audit_log/.test(sql)) throw new Error('audit down');
      return { rows: [], rowCount: 1 };
    });
    await expect(markSandboxInviteUsedAudited(4, 99, 12, AUDIT)).rejects.toThrow('audit down');
    expect(clientSql()).toEqual(['BEGIN', 'UPDATE', 'INSERT', 'ROLLBACK']);
    expect(releaseMock).toHaveBeenCalledTimes(1);
  });
});

describe('createSandboxInviteBatch', () => {
  it('mints N tokens, storing only their sha256 hashes', async () => {
    queryMock.mockResolvedValueOnce({
      rows: [{ invite_id: 1 }, { invite_id: 2 }, { invite_id: 3 }],
    });
    const { batchId, invites } = await createSandboxInviteBatch({
      count: 3, inviteRole: 'caseworker', createdBy: 1,
    });
    expect(batchId).toMatch(/^[0-9a-f-]{36}$/);
    expect(invites).toHaveLength(3);
    const hashes = queryMock.mock.calls[0][1][0] as string[];
    expect(hashes).toHaveLength(3);
    for (const [i, hash] of hashes.entries()) {
      expect(hash).toMatch(/^[0-9a-f]{64}$/);
      expect(hash).not.toBe(invites[i].rawToken);
      expect(invites[i].rawToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    }
  });

  it('rejects counts outside 1..500 before touching the db', async () => {
    await expect(
      createSandboxInviteBatch({ count: 0, inviteRole: 'therapist', createdBy: 1 })
    ).rejects.toThrow('between 1 and 500');
    await expect(
      createSandboxInviteBatch({ count: 501, inviteRole: 'therapist', createdBy: 1 })
    ).rejects.toThrow('between 1 and 500');
    expect(queryMock).not.toHaveBeenCalled();
  });
});

describe('consume / release lifecycle (065 pattern)', () => {
  it('consume is an atomic guarded UPDATE', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] });
    await expect(consumeSandboxInvite('tok')).resolves.toBeNull();
    const sql = String(queryMock.mock.calls[0][0]);
    expect(sql).toContain('used_at IS NULL');
    expect(sql).toContain('expires_at > now()');
  });

  it('find peeks without consuming', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ invite_id: 4 }] });
    await findSandboxInviteByToken('tok');
    expect(String(queryMock.mock.calls[0][0])).not.toContain('UPDATE');
  });

  it('markSandboxInviteUsed stamps user and org', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] });
    await markSandboxInviteUsed(4, 99, 12);
    expect(queryMock.mock.calls[0][1]).toEqual([99, 12, 4]);
  });

  it('release clears usage so the link stays valid after a failed signup', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] });
    await releaseSandboxInvite(4);
    const sql = String(queryMock.mock.calls[0][0]);
    expect(sql).toContain('used_at = NULL');
    expect(sql).toContain('org_id = NULL');
  });
});

describe('listSandboxInviteBatches', () => {
  it('returns grouped batch rows', async () => {
    const rows = [{ batch_id: 'b', total: 5, used: 2 }];
    queryMock.mockResolvedValueOnce({ rows });
    await expect(listSandboxInviteBatches()).resolves.toEqual(rows);
    expect(String(queryMock.mock.calls[0][0])).toContain('GROUP BY batch_id');
  });
});
