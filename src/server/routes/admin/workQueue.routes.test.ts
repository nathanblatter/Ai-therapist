// Work-queue API tests: member vs researcher scoping, 404-over-403 on
// ack/resolve (a member can never distinguish "not mine" from "missing"),
// and 409 on lost state races.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

const dbMocks = vi.hoisted(() => ({
  listWorkItemsForMember: vi.fn(),
  listWorkItemsForOrg: vi.fn(),
  getWorkItemById: vi.fn(),
  ackWorkItem: vi.fn(),
  resolveWorkItem: vi.fn(),
  isAssigned: vi.fn(),
  insertCaseloadAudit: vi.fn(),
  getOrganizationIdForUser: vi.fn(),
  getIrbStudyOrgId: vi.fn(),
}));
vi.mock('../../db/index.js', () => dbMocks);

const { emitWorkItemUpdatedMock } = vi.hoisted(() => ({ emitWorkItemUpdatedMock: vi.fn() }));
vi.mock('../../services/workQueue.service.js', () => ({
  emitWorkItemUpdated: emitWorkItemUpdatedMock,
}));

import workQueueRoutes from './workQueue.routes.js';

function appAs(role: string | null, userId = 1, orgId?: number) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { session: Record<string, unknown> }).session = role
      ? { userId, userRole: role, username: 'tester', ...(orgId !== undefined ? { orgId } : {}) }
      : {};
    next();
  });
  app.use(workQueueRoutes());
  return app;
}

const ITEM = {
  item_id: 5, org_id: 1, client_id: 42, assignee_id: null, assignee_role: null,
  item_type: 'crisis_flag', severity: 'urgent', title: 'Crisis flag', detail: null,
  source_table: 'crisis_events', source_id: '7', status: 'open',
  acked_by: null, acked_at: null, resolved_by: null, resolved_at: null,
  resolution_note: null, is_sandbox: false, created_at: 'now',
};

beforeEach(() => {
  vi.clearAllMocks();
  dbMocks.listWorkItemsForMember.mockResolvedValue([ITEM]);
  dbMocks.listWorkItemsForOrg.mockResolvedValue([ITEM]);
  dbMocks.getWorkItemById.mockResolvedValue(ITEM);
  dbMocks.ackWorkItem.mockResolvedValue({ ...ITEM, status: 'acked' });
  dbMocks.resolveWorkItem.mockResolvedValue({ ...ITEM, status: 'resolved' });
  dbMocks.isAssigned.mockResolvedValue(true);
  dbMocks.insertCaseloadAudit.mockResolvedValue(undefined);
  emitWorkItemUpdatedMock.mockResolvedValue(undefined);
});

describe('GET /admin/api/work-items', () => {
  it('lists member-visible items for care-team roles with default statuses', async () => {
    const res = await request(appAs('caseworker', 8)).get('/admin/api/work-items');
    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(1);
    expect(dbMocks.listWorkItemsForMember).toHaveBeenCalledWith(8, { statuses: ['open', 'acked'], limit: 200 });
  });

  it('passes a custom status filter through', async () => {
    await request(appAs('therapist', 7)).get('/admin/api/work-items?status=resolved&limit=10');
    expect(dbMocks.listWorkItemsForMember).toHaveBeenCalledWith(7, { statuses: ['resolved'], limit: 10 });
  });

  it('rejects unknown statuses with 400', async () => {
    const res = await request(appAs('therapist')).get('/admin/api/work-items?status=bogus');
    expect(res.status).toBe(400);
  });

  it('gives researchers the org-scoped view', async () => {
    const res = await request(appAs('researcher', 3, 1)).get('/admin/api/work-items');
    expect(res.status).toBe(200);
    expect(dbMocks.listWorkItemsForOrg).toHaveBeenCalledWith(1, expect.anything());
    expect(dbMocks.listWorkItemsForMember).not.toHaveBeenCalled();
  });

  it('scopes a researcher with no org row to the irb-study fallback org (orgIdFor contract)', async () => {
    dbMocks.getOrganizationIdForUser.mockResolvedValue(null);
    dbMocks.getIrbStudyOrgId.mockResolvedValue(99);
    const res = await request(appAs('researcher', 3)).get('/admin/api/work-items');
    expect(res.status).toBe(200);
    expect(dbMocks.listWorkItemsForOrg).toHaveBeenCalledWith(99, expect.anything());
  });

  it('500s (fail closed) when org resolution throws — never an unscoped read', async () => {
    dbMocks.getOrganizationIdForUser.mockRejectedValue(new Error('db down'));
    const res = await request(appAs('researcher', 3)).get('/admin/api/work-items');
    expect(res.status).toBe(500);
    expect(dbMocks.listWorkItemsForOrg).not.toHaveBeenCalled();
  });

  it('denies participants (403) and anonymous (401)', async () => {
    expect((await request(appAs('participant')).get('/admin/api/work-items')).status).toBe(403);
    expect((await request(appAs(null)).get('/admin/api/work-items')).status).toBe(401);
  });
});

describe('POST /admin/api/work-items/:itemId/ack', () => {
  it('acks a visible open item and emits the update', async () => {
    const res = await request(appAs('caseworker', 8)).post('/admin/api/work-items/5/ack');
    expect(res.status).toBe(200);
    expect(res.body.item.status).toBe('acked');
    expect(dbMocks.ackWorkItem).toHaveBeenCalledWith(5, 8);
    expect(emitWorkItemUpdatedMock).toHaveBeenCalled();
  });

  it('appends a caseload_audit_log row for the ack (spec section 3)', async () => {
    await request(appAs('caseworker', 8)).post('/admin/api/work-items/5/ack');
    expect(dbMocks.insertCaseloadAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'work_item_ack',
        therapistId: 8,
        clientId: 42,
        actorUserId: 8,
        actorUsername: 'tester',
        detail: expect.objectContaining({ item_id: 5, item_type: 'crisis_flag' }),
      })
    );
  });

  it('does not audit a failed ack', async () => {
    dbMocks.ackWorkItem.mockResolvedValue(null);
    dbMocks.getWorkItemById.mockResolvedValue(null);
    await request(appAs('caseworker', 8)).post('/admin/api/work-items/5/ack');
    expect(dbMocks.insertCaseloadAudit).not.toHaveBeenCalled();
  });

  it('404s on a missing item', async () => {
    dbMocks.ackWorkItem.mockResolvedValue(null);
    dbMocks.getWorkItemById.mockResolvedValue(null);
    expect((await request(appAs('caseworker', 8)).post('/admin/api/work-items/5/ack')).status).toBe(404);
  });

  it('404s (not 403) on an item outside the member caseload', async () => {
    dbMocks.ackWorkItem.mockResolvedValue(null);
    dbMocks.isAssigned.mockResolvedValue(false);
    const res = await request(appAs('caseworker', 8)).post('/admin/api/work-items/5/ack');
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('Not found');
  });

  it('409s when the item is visible but the state race was lost', async () => {
    dbMocks.ackWorkItem.mockResolvedValue(null);
    dbMocks.getWorkItemById.mockResolvedValue({ ...ITEM, status: 'resolved' });
    const res = await request(appAs('caseworker', 8)).post('/admin/api/work-items/5/ack');
    expect(res.status).toBe(409);
    expect(res.body.status).toBe('resolved');
  });

  it('is care-team only: researchers get 403', async () => {
    expect((await request(appAs('researcher')).post('/admin/api/work-items/5/ack')).status).toBe(403);
    expect(dbMocks.ackWorkItem).not.toHaveBeenCalled();
  });

  it('400s on a non-numeric id', async () => {
    expect((await request(appAs('caseworker')).post('/admin/api/work-items/abc/ack')).status).toBe(400);
  });
});

describe('POST /admin/api/work-items/:itemId/resolve', () => {
  it('resolves with a trimmed note', async () => {
    const res = await request(appAs('therapist', 7))
      .post('/admin/api/work-items/5/resolve')
      .send({ resolution_note: '  followed up by phone  ' });
    expect(res.status).toBe(200);
    expect(dbMocks.resolveWorkItem).toHaveBeenCalledWith(5, 7, 'followed up by phone');
  });

  it('resolves without a note', async () => {
    await request(appAs('therapist', 7)).post('/admin/api/work-items/5/resolve').send({});
    expect(dbMocks.resolveWorkItem).toHaveBeenCalledWith(5, 7, null);
  });

  it('appends a caseload_audit_log row for the resolve (spec section 3)', async () => {
    await request(appAs('therapist', 7))
      .post('/admin/api/work-items/5/resolve')
      .send({ resolution_note: 'called client' });
    expect(dbMocks.insertCaseloadAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'work_item_resolve',
        therapistId: 7,
        clientId: 42,
        detail: expect.objectContaining({ item_id: 5, has_resolution_note: true }),
      })
    );
  });

  it('400s on a non-string note', async () => {
    const res = await request(appAs('therapist', 7))
      .post('/admin/api/work-items/5/resolve')
      .send({ resolution_note: 42 });
    expect(res.status).toBe(400);
    expect(dbMocks.resolveWorkItem).not.toHaveBeenCalled();
  });

  it('500s on unexpected db errors', async () => {
    dbMocks.resolveWorkItem.mockRejectedValue(new Error('db down'));
    expect((await request(appAs('therapist', 7)).post('/admin/api/work-items/5/resolve').send({})).status).toBe(500);
  });
});
