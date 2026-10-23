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
  assignClient,
  assignClientAudited,
  unassignClient,
  isAssigned,
  getCaseloadClientIds,
  listCaseload,
  listAllAssignments,
  CaseloadRoleError,
} from './caseload.queries.js';

beforeEach(() => {
  queryMock.mockReset();
  clientQueryMock.mockReset();
  releaseMock.mockReset();
  connectMock.mockClear();
});

/** First SQL keyword of every statement issued on the checked-out client. */
const clientSql = () => clientQueryMock.mock.calls.map((c) => String(c[0]).trim().split(/\s+/)[0]);
const VALID_PAIR = { therapist_role: 'therapist', client_role: 'participant', member_org: 1, client_org: 1 };

describe('assignClientAudited (grant + audit in one transaction, ai-therapist-145)', () => {
  it('validates, inserts the edge and the audit row, then COMMITs on one client', async () => {
    clientQueryMock.mockImplementation(async (sql: string) =>
      /SELECT/.test(sql) ? { rows: [VALID_PAIR] } : { rows: [], rowCount: 1 },
    );
    await assignClientAudited(1, 2, 1, { actorUserId: 1, actorUsername: 'dr_t', detail: { via: 'x' } });
    expect(clientSql()).toEqual(['BEGIN', 'SELECT', 'INSERT', 'INSERT', 'COMMIT']);
    expect(queryMock).not.toHaveBeenCalled();
    const audit = clientQueryMock.mock.calls[3] as [string, unknown[]];
    expect(audit[0]).toContain('caseload_audit_log');
    expect(audit[1]).toEqual(['assign', 1, 2, 1, 'dr_t', JSON.stringify({ via: 'x' })]);
    expect(releaseMock).toHaveBeenCalledTimes(1);
  });

  it('ROLLBACKs the grant when the audit insert fails (no unlogged access)', async () => {
    clientQueryMock.mockImplementation(async (sql: string) => {
      if (/SELECT/.test(sql)) return { rows: [VALID_PAIR] };
      if (/caseload_audit_log/.test(sql)) throw new Error('audit down');
      return { rows: [], rowCount: 1 };
    });
    await expect(assignClientAudited(1, 2, 1, { actorUserId: 1, actorUsername: 'dr_t' })).rejects.toThrow('audit down');
    expect(clientSql()).toEqual(['BEGIN', 'SELECT', 'INSERT', 'INSERT', 'ROLLBACK']);
    expect(releaseMock).toHaveBeenCalledTimes(1);
  });

  it('ROLLBACKs before writing anything on a role violation', async () => {
    clientQueryMock.mockResolvedValue({ rows: [] });
    clientQueryMock
      .mockResolvedValueOnce({ rows: [] }) // BEGIN
      .mockResolvedValueOnce({ rows: [{ ...VALID_PAIR, client_role: 'therapist' }] });
    await expect(assignClientAudited(1, 2, 1, { actorUserId: 1, actorUsername: 'dr_t' })).rejects.toBeInstanceOf(
      CaseloadRoleError,
    );
    expect(clientSql()).toEqual(['BEGIN', 'SELECT', 'ROLLBACK']);
    expect(releaseMock).toHaveBeenCalledTimes(1);
  });
});

describe('assignClient', () => {
  it('validates roles with one query, then inserts with ON CONFLICT DO NOTHING', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{ therapist_role: 'therapist', client_role: 'participant' }] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [] });
    await assignClient(1, 2, 3);
    expect(queryMock).toHaveBeenCalledTimes(2);
    expect(queryMock.mock.calls[0][1]).toEqual([1, 2]);
    expect(queryMock.mock.calls[1][0]).toMatch(/ON CONFLICT DO NOTHING/i);
    expect(queryMock.mock.calls[1][1]).toEqual([1, 2, 3]);
  });

  it('passes a null assignedBy through to the insert', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{ therapist_role: 'therapist', client_role: 'participant' }] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [] });
    await assignClient(1, 2, null);
    expect(queryMock.mock.calls[1][1]).toEqual([1, 2, null]);
  });

  it('throws CaseloadRoleError when therapistId is not a therapist', async () => {
    queryMock.mockResolvedValueOnce({
      rows: [{ therapist_role: 'participant', client_role: 'participant' }],
    });
    await expect(assignClient(1, 2, null)).rejects.toBeInstanceOf(CaseloadRoleError);
    expect(queryMock).toHaveBeenCalledTimes(1);
  });

  it('throws CaseloadRoleError when clientId is not a participant', async () => {
    queryMock.mockResolvedValueOnce({
      rows: [{ therapist_role: 'therapist', client_role: 'researcher' }],
    });
    await expect(assignClient(1, 2, null)).rejects.toBeInstanceOf(CaseloadRoleError);
    expect(queryMock).toHaveBeenCalledTimes(1);
  });

  it('throws CaseloadRoleError when either user does not exist (null role)', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ therapist_role: null, client_role: null }] });
    await expect(assignClient(99, 100, null)).rejects.toBeInstanceOf(CaseloadRoleError);
    expect(queryMock).toHaveBeenCalledTimes(1);
  });

  it('is idempotent: a conflicting insert (rowCount 0) resolves without error', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{ therapist_role: 'therapist', client_role: 'participant' }] })
      .mockResolvedValueOnce({ rowCount: 0, rows: [] });
    await expect(assignClient(1, 2, 3)).resolves.toBeUndefined();
  });
});

describe('unassignClient', () => {
  it('returns true when a row was deleted', async () => {
    queryMock.mockResolvedValueOnce({ rowCount: 1, rows: [] });
    await expect(unassignClient(1, 2)).resolves.toBe(true);
    expect(queryMock.mock.calls[0][1]).toEqual([1, 2]);
  });

  it('returns false when no row matched', async () => {
    queryMock.mockResolvedValueOnce({ rowCount: 0, rows: [] });
    await expect(unassignClient(1, 2)).resolves.toBe(false);
  });
});

describe('isAssigned', () => {
  it('returns true when the assignment exists', async () => {
    queryMock.mockResolvedValueOnce({ rowCount: 1, rows: [{ '?column?': 1 }] });
    await expect(isAssigned(1, 2)).resolves.toBe(true);
    expect(queryMock.mock.calls[0][1]).toEqual([1, 2]);
  });

  it('returns false when it does not', async () => {
    queryMock.mockResolvedValueOnce({ rowCount: 0, rows: [] });
    await expect(isAssigned(1, 2)).resolves.toBe(false);
  });
});

describe('getCaseloadClientIds', () => {
  it('returns the client ids as a flat number array', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ client_id: 4 }, { client_id: 7 }] });
    await expect(getCaseloadClientIds(1)).resolves.toEqual([4, 7]);
    expect(queryMock.mock.calls[0][1]).toEqual([1]);
  });

  it('returns an empty array for an empty caseload', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] });
    await expect(getCaseloadClientIds(1)).resolves.toEqual([]);
  });
});

describe('listCaseload', () => {
  it('returns client rows for the therapist and casts timestamps to text in SQL', async () => {
    const rows = [
      { userid: 4, username: 'p1', created_at: '2026-08-01 00:00:00+00', assigned_at: '2026-08-20 00:00:00+00' },
    ];
    queryMock.mockResolvedValueOnce({ rows });
    await expect(listCaseload(1)).resolves.toEqual(rows);
    expect(queryMock.mock.calls[0][1]).toEqual([1]);
    expect(queryMock.mock.calls[0][0]).toMatch(/::text/);
  });
});

describe('listAllAssignments', () => {
  it('returns every assignment with therapist and client usernames', async () => {
    const rows = [
      {
        therapist_id: 1,
        therapist_username: 'dr_t',
        client_id: 4,
        client_username: 'p1',
        assigned_at: '2026-08-20 00:00:00+00',
      },
    ];
    queryMock.mockResolvedValueOnce({ rows });
    await expect(listAllAssignments()).resolves.toEqual(rows);
  });
});

describe('CaseloadRoleError', () => {
  it('is an Error subclass with a stable name', () => {
    const err = new CaseloadRoleError('bad role');
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('CaseloadRoleError');
    expect(err.message).toBe('bad role');
  });
});

describe('assignClient research-org caseworker invariant', () => {
  it('rejects a caseworker assignment when the member org is a research org', async () => {
    queryMock.mockResolvedValueOnce({
      rows: [
        {
          therapist_role: 'caseworker',
          client_role: 'participant',
          member_org: 1,
          client_org: 1,
          member_org_kind: 'research',
        },
      ],
    });
    await expect(assignClient(1, 2, null, 'caseworker')).rejects.toThrow(/research organization/);
    // Fails before any INSERT.
    expect(queryMock).toHaveBeenCalledTimes(1);
  });

  it('allows a caseworker assignment inside a practice org', async () => {
    queryMock
      .mockResolvedValueOnce({
        rows: [
          {
            therapist_role: 'caseworker',
            client_role: 'participant',
            member_org: 2,
            client_org: 2,
            member_org_kind: 'practice',
          },
        ],
      })
      .mockResolvedValueOnce({ rowCount: 1, rows: [] });
    await expect(assignClient(1, 2, null, 'caseworker')).resolves.toBeUndefined();
    expect(queryMock).toHaveBeenCalledTimes(2);
  });

  it('does not block therapist assignments inside the research org', async () => {
    queryMock
      .mockResolvedValueOnce({
        rows: [
          {
            therapist_role: 'therapist',
            client_role: 'participant',
            member_org: 1,
            client_org: 1,
            member_org_kind: 'research',
          },
        ],
      })
      .mockResolvedValueOnce({ rowCount: 1, rows: [] });
    await expect(assignClient(1, 2, null)).resolves.toBeUndefined();
  });
});
