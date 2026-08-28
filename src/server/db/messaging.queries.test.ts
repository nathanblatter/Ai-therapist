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
  getThreadById,
  getOrCreateThread,
  insertThreadMessage,
  listThreadMessages,
  markThreadRead,
  freezeThreadsForPair,
  countUnreadForUser,
  countUnreadByClientForMember,
  listMessageOriginCrisisEvents,
  updateThreadMessageScan,
} from './messaging.queries.js';

beforeEach(() => {
  queryMock.mockReset();
  clientQueryMock.mockReset();
  releaseMock.mockReset();
});

describe('getOrCreateThread', () => {
  it('upserts on the (client, clinician) pair and only unfreezes assignment freezes', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ thread_id: 1, status: 'active' }] });
    await getOrCreateThread({ clientId: 42, clinicianId: 7, clinicianRole: 'caseworker', orgId: 1 });
    const sql = String(queryMock.mock.calls[0][0]);
    expect(sql).toContain('ON CONFLICT (client_id, clinician_id) DO UPDATE');
    expect(sql).toContain(`frozen_reason = 'unassigned'`);
    expect(queryMock.mock.calls[0][1]).toEqual([42, 7, 'caseworker', 1, false]);
  });
});

describe('insertThreadMessage', () => {
  it('inserts and bumps last_message_at in one transaction', async () => {
    clientQueryMock
      .mockResolvedValueOnce({ rows: [] })                                 // BEGIN
      .mockResolvedValueOnce({ rows: [{ message_id: 9, thread_id: 1 }] })  // INSERT
      .mockResolvedValueOnce({ rows: [] })                                 // UPDATE thread
      .mockResolvedValueOnce({ rows: [] });                                // COMMIT
    const row = await insertThreadMessage({
      threadId: 1, senderId: 42, senderRole: 'participant', body: 'hi', scanStatus: 'pending',
    });
    expect(row.message_id).toBe(9);
    const sqls = clientQueryMock.mock.calls.map((c) => String(c[0]));
    expect(sqls[2]).toContain('last_message_at = now()');
    expect(sqls[3]).toBe('COMMIT');
    expect(releaseMock).toHaveBeenCalledOnce();
  });

  it('rolls back on failure', async () => {
    clientQueryMock
      .mockResolvedValueOnce({ rows: [] })
      .mockRejectedValueOnce(new Error('too long'))
      .mockResolvedValueOnce({ rows: [] }); // ROLLBACK
    await expect(
      insertThreadMessage({ threadId: 1, senderId: 42, senderRole: 'participant', body: 'x' })
    ).rejects.toThrow('too long');
    expect(String(clientQueryMock.mock.calls[2][0])).toBe('ROLLBACK');
  });
});

describe('listThreadMessages', () => {
  it('keyset-paginates and returns oldest-first pages', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] });
    await listThreadMessages(1, { beforeMessageId: 50, limit: 20 });
    const sql = String(queryMock.mock.calls[0][0]);
    expect(sql).toContain('message_id < $2');
    expect(sql).toContain('ORDER BY message_id ASC');
    expect(queryMock.mock.calls[0][1]).toEqual([1, 50, 20]);
  });
});

describe('markThreadRead', () => {
  it('never moves the read pointer backwards', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] });
    await markThreadRead(1, 42, 30);
    expect(String(queryMock.mock.calls[0][0])).toContain('GREATEST(');
  });
});

describe('freezeThreadsForPair', () => {
  it('freezes only active pair threads and returns their ids', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ thread_id: 1 }] });
    await expect(freezeThreadsForPair(7, 42, 'unassigned')).resolves.toEqual([1]);
    const sql = String(queryMock.mock.calls[0][0]);
    expect(sql).toContain(`status = 'active'`);
    expect(queryMock.mock.calls[0][1]).toEqual([7, 42, 'unassigned']);
  });
});

describe('unread counts', () => {
  it('countUnreadForUser excludes own messages', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ total: '3' }] });
    await expect(countUnreadForUser(42)).resolves.toBe(3);
    expect(String(queryMock.mock.calls[0][0])).toContain('tm.sender_id <> $1');
  });

  it('countUnreadByClientForMember groups by client', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ client_id: 42, unread_count: 2 }] });
    await expect(countUnreadByClientForMember(7)).resolves.toEqual([
      { client_id: 42, unread_count: 2 },
    ]);
    expect(String(queryMock.mock.calls[0][0])).toContain('GROUP BY t.client_id');
  });
});

describe('listMessageOriginCrisisEvents', () => {
  it('filters to thread_message origin and scopes to the member caseload when given', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] });
    await listMessageOriginCrisisEvents(7, null, 25);
    const sql = String(queryMock.mock.calls[0][0]);
    expect(sql).toContain(`ce.origin = 'thread_message'`);
    expect(sql).toContain('therapist_clients');
    expect(queryMock.mock.calls[0][1]).toEqual([25, 7]);
  });

  it('scopes to the org when given (researchers, C13)', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] });
    await listMessageOriginCrisisEvents(null, 3);
    const sql = String(queryMock.mock.calls[0][0]);
    expect(sql).not.toContain('therapist_clients');
    expect(sql).toContain('ou.organization_id');
    expect(queryMock.mock.calls[0][1]).toEqual([100, 3]);
  });

  it('the org clause has no NULL bypass: rows must positively match the org (sandbox/cross-org excluded)', async () => {
    // Red-team round 3, finding 8 verification: sandbox clients live in their
    // own kind='sandbox' orgs (C8), so a positive EXISTS on
    // ce.client_user_id -> users.organization_id structurally excludes them
    // from any other org's researcher view; a NULL client_user_id fails the
    // EXISTS too (fail closed) rather than passing as "anonymous".
    queryMock.mockResolvedValueOnce({ rows: [] });
    await listMessageOriginCrisisEvents(null, 3);
    const sql = String(queryMock.mock.calls[0][0]);
    expect(sql).toContain(
      'AND EXISTS (SELECT 1 FROM users ou WHERE ou.userid = ce.client_user_id AND ou.organization_id = $2)'
    );
    expect(sql).not.toMatch(/client_user_id IS NULL OR/i);
  });

  it('is unscoped without a member id', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] });
    await listMessageOriginCrisisEvents();
    expect(String(queryMock.mock.calls[0][0])).not.toContain('therapist_clients');
  });
});

describe('updateThreadMessageScan / getThreadById', () => {
  it('records scan results and preserves an existing crisis link', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] });
    await updateThreadMessageScan(9, { scanStatus: 'flagged', riskScore: 80, riskSeverity: 'high' });
    expect(String(queryMock.mock.calls[0][0])).toContain('COALESCE($5, crisis_event_id)');
    expect(queryMock.mock.calls[0][1]).toEqual([9, 'flagged', 80, 'high', null]);
  });

  it('getThreadById returns null on a miss', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] });
    await expect(getThreadById(1)).resolves.toBeNull();
  });
});
