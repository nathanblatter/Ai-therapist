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
  createEscalation,
  getEscalationById,
  listEscalations,
  countOpenEscalationsForMember,
  acknowledgeEscalation,
  resolveEscalation,
  reopenEscalation,
  claimEscalation,
  insertEscalationEvent,
} from './escalations.queries.js';

beforeEach(() => {
  queryMock.mockReset();
  clientQueryMock.mockReset();
  releaseMock.mockReset();
});

const ROW = { escalation_id: 1, org_id: 1, client_id: 42, status: 'open', assigned_to: null };

describe('createEscalation', () => {
  it('inserts the escalation and its created event in one transaction', async () => {
    clientQueryMock
      .mockResolvedValueOnce({ rows: [] })      // BEGIN
      .mockResolvedValueOnce({ rows: [ROW] })   // INSERT escalation
      .mockResolvedValueOnce({ rows: [] })      // INSERT event
      .mockResolvedValueOnce({ rows: [] });     // COMMIT
    const row = await createEscalation(
      {
        orgId: 1, clientId: 42, raisedBy: 9, raisedByRole: 'caseworker',
        reason: 'sleep collapse', urgency: 'urgent',
      },
      'cw_1'
    );
    expect(row).toEqual(ROW);
    const sqls = clientQueryMock.mock.calls.map((c) => String(c[0]));
    expect(sqls[1]).toContain('INSERT INTO escalations');
    expect(sqls[2]).toContain(`'created'`);
    expect(sqls[3]).toBe('COMMIT');
    expect(releaseMock).toHaveBeenCalledOnce();
  });

  it('rolls back when the event insert fails', async () => {
    clientQueryMock
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [ROW] })
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce({ rows: [] }); // ROLLBACK
    await expect(
      createEscalation(
        { orgId: 1, clientId: 42, raisedBy: 9, raisedByRole: 'caseworker', reason: 'r', urgency: 'routine' },
        null
      )
    ).rejects.toThrow('boom');
    expect(String(clientQueryMock.mock.calls[3][0])).toBe('ROLLBACK');
  });
});

describe('guarded transitions', () => {
  it('acknowledge only fires from open (409 race -> null)', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] });
    await expect(acknowledgeEscalation(1, 7)).resolves.toBeNull();
    expect(String(queryMock.mock.calls[0][0])).toContain(`status = 'open'`);
  });

  it('resolve fires from open or acknowledged', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ ...ROW, status: 'resolved' }] });
    await expect(resolveEscalation(1, 7, 'done')).resolves.toMatchObject({ status: 'resolved' });
    expect(String(queryMock.mock.calls[0][0])).toContain(`status IN ('open', 'acknowledged')`);
  });

  it('reopen clears ack/resolve fields and only fires from resolved', async () => {
    queryMock.mockResolvedValueOnce({ rows: [ROW] });
    await reopenEscalation(1);
    const sql = String(queryMock.mock.calls[0][0]);
    expect(sql).toContain('acknowledged_by = NULL');
    expect(sql).toContain('resolution_note = NULL');
    expect(sql).toContain(`status = 'resolved'`);
  });

  it('claim is atomic on assigned_to IS NULL', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] });
    await expect(claimEscalation(1, 7)).resolves.toBeNull();
    const sql = String(queryMock.mock.calls[0][0]);
    expect(sql).toContain('assigned_to IS NULL');
    expect(sql).toContain(`status <> 'resolved'`);
  });
});

describe('listEscalations', () => {
  it('therapist member scope covers assignee, raiser, caseload, and same-org unassigned', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] });
    await listEscalations({ memberId: 7, memberRole: 'therapist', openOnly: true });
    const sql = String(queryMock.mock.calls[0][0]);
    expect(sql).toContain('e.assigned_to = $1');
    expect(sql).toContain('e.raised_by = $1');
    expect(sql).toContain('therapist_clients');
    expect(sql).toContain('e.assigned_to IS NULL AND e.org_id =');
    expect(sql).toContain(`e.status <> 'resolved'`);
  });

  it('caseworker member scope EXCLUDES the org-unassigned pool (ai-therapist-144)', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] });
    await listEscalations({ memberId: 7, memberRole: 'caseworker', openOnly: true });
    const sql = String(queryMock.mock.calls[0][0]);
    expect(sql).toContain('e.assigned_to = $1');
    expect(sql).toContain('therapist_clients');
    // the leak: reason text + client identity for escalations the caseworker
    // cannot even open (detail route 404s) must not appear in their list
    expect(sql).not.toContain('e.assigned_to IS NULL AND e.org_id =');
  });

  it('memberRole omitted defaults to the restrictive (no org-unassigned) scope', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] });
    await listEscalations({ memberId: 7, openOnly: true });
    expect(String(queryMock.mock.calls[0][0])).not.toContain('e.assigned_to IS NULL AND e.org_id =');
  });

  it('org filter applies for researcher reads', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] });
    await listEscalations({ orgId: 3 });
    expect(String(queryMock.mock.calls[0][0])).toContain('e.org_id = $1');
    expect(queryMock.mock.calls[0][1]).toEqual([3, 200]);
  });
});

describe('countOpenEscalationsForMember', () => {
  it('parses the count', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ total: '4' }] });
    await expect(countOpenEscalationsForMember(7, 'therapist')).resolves.toBe(4);
    expect(String(queryMock.mock.calls[0][0])).toContain('e.assigned_to IS NULL AND e.org_id =');
  });

  it('caseworker count excludes the org-unassigned pool (badge matches openable set)', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ total: '1' }] });
    await expect(countOpenEscalationsForMember(7, 'caseworker')).resolves.toBe(1);
    expect(String(queryMock.mock.calls[0][0])).not.toContain('e.assigned_to IS NULL AND e.org_id =');
  });
});

describe('insertEscalationEvent / getEscalationById', () => {
  it('serializes detail as JSON', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ event_id: 1 }] });
    await insertEscalationEvent({
      escalationId: 1, eventType: 'comment', actorUserId: 7, actorUsername: 'dr_t',
      detail: { text: 'checking in' },
    });
    expect(queryMock.mock.calls[0][1][4]).toBe(JSON.stringify({ text: 'checking in' }));
  });

  it('getEscalationById returns null on a miss', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] });
    await expect(getEscalationById(99)).resolves.toBeNull();
  });
});
