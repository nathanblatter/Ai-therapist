// Escalations API tests (caseworker portal slice B): create with caseload
// gating + default therapist routing + escalation_inbound work item, list
// scoping, assignee-only ack/resolve (409 on races), reopen, comments,
// claim with auto-caseload-grant, and 404-over-403 for out-of-caseload.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

const dbMocks = vi.hoisted(() => {
  class CaseloadRoleError extends Error {}
  return {
    CaseloadRoleError,
    // escalations.queries
    createEscalation: vi.fn(),
    getEscalationById: vi.fn(),
    listEscalations: vi.fn(),
    countOpenEscalationsForMember: vi.fn(),
    listEscalationEvents: vi.fn(),
    insertEscalationEvent: vi.fn(),
    acknowledgeEscalation: vi.fn(),
    resolveEscalation: vi.fn(),
    reopenEscalation: vi.fn(),
    claimEscalation: vi.fn(),
    // workQueue.queries
    insertWorkItem: vi.fn(),
    expireWorkItemsBySource: vi.fn(),
    // users / caseload / org
    getUserById: vi.fn(),
    getTherapistIdsForClient: vi.fn(),
    getOrgTherapistIds: vi.fn(),
    getCrisisEventClientInfo: vi.fn(),
    getCaseworkerIdsForClient: vi.fn(),
    assignClientAudited: vi.fn(),
    isAssigned: vi.fn(),
    getOrganizationIdForUser: vi.fn(),
    // imported by middleware/caseload.ts + utils/adminBroadcast.ts
    getSessionAccessInfo: vi.fn(),
    getMessageOwner: vi.fn(),
    getCareNoteById: vi.fn(),
  };
});
vi.mock('../../db/index.js', () => dbMocks);

import escalationsRoutes from './escalations.routes.js';

const CLIENT = { userid: 42, username: 'p42', role: 'participant', organization_id: 5, is_sandbox: false };

function baseEscalation(overrides: Record<string, unknown> = {}) {
  return {
    escalation_id: 11,
    org_id: 5,
    client_id: 42,
    raised_by: 2,
    raised_by_role: 'caseworker',
    assigned_to: 9,
    reason: 'Client reported worsening sleep and hopelessness',
    urgency: 'urgent',
    crisis_event_id: null,
    session_id: null,
    note_id: null,
    status: 'open',
    acknowledged_by: null,
    acknowledged_at: null,
    resolved_by: null,
    resolved_at: null,
    resolution_note: null,
    created_at: '2026-08-27T00:00:00Z',
    updated_at: '2026-08-27T00:00:00Z',
    ...overrides,
  };
}

function appAs(role: string | null, userId = 1) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { session: Record<string, unknown> }).session = role
      ? { userId, userRole: role, username: `user${userId}` }
      : {};
    next();
  });
  app.use(escalationsRoutes());
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
  dbMocks.isAssigned.mockResolvedValue(true);
  dbMocks.getUserById.mockResolvedValue(CLIENT);
  dbMocks.getTherapistIdsForClient.mockResolvedValue([9]);
  dbMocks.getOrgTherapistIds.mockResolvedValue([]);
  dbMocks.getCrisisEventClientInfo.mockResolvedValue(null);
  dbMocks.getCaseworkerIdsForClient.mockResolvedValue([2]);
  dbMocks.getOrganizationIdForUser.mockResolvedValue(5);
  dbMocks.createEscalation.mockResolvedValue(baseEscalation());
  dbMocks.insertWorkItem.mockResolvedValue({ item_id: 1 });
  dbMocks.expireWorkItemsBySource.mockResolvedValue([]);
  dbMocks.insertEscalationEvent.mockResolvedValue({ event_id: 77, escalation_id: 11, event_type: 'comment' });
  dbMocks.listEscalationEvents.mockResolvedValue([]);
  dbMocks.assignClientAudited.mockResolvedValue(undefined);
});

describe('POST /admin/api/escalations', () => {
  const body = { client_id: 42, reason: 'Worsening symptoms, please review', urgency: 'urgent' };

  it('creates for a caseworker with the client on caseload, routing to the care-team therapist', async () => {
    const res = await request(appAs('caseworker', 2)).post('/admin/api/escalations').send(body);
    expect(res.status).toBe(201);
    expect(res.body.escalation.escalation_id).toBe(11);
    expect(dbMocks.createEscalation).toHaveBeenCalledWith(
      expect.objectContaining({ clientId: 42, raisedBy: 2, raisedByRole: 'caseworker', assignedTo: 9, urgency: 'urgent', orgId: 5 }),
      'user2'
    );
  });

  it('enqueues an escalation_inbound work item (direct queries insert)', async () => {
    await request(appAs('caseworker', 2)).post('/admin/api/escalations').send(body);
    expect(dbMocks.insertWorkItem).toHaveBeenCalledWith(
      expect.objectContaining({
        itemType: 'escalation_inbound',
        assigneeId: 9,
        severity: 'warning',
        sourceTable: 'escalations',
        sourceId: '11',
        isSandbox: false,
      })
    );
  });

  it('maps emergency urgency to an urgent work item and null assignee to the org pool', async () => {
    dbMocks.getTherapistIdsForClient.mockResolvedValue([]);
    dbMocks.createEscalation.mockResolvedValue(baseEscalation({ assigned_to: null, urgency: 'emergency' }));
    const res = await request(appAs('caseworker', 2))
      .post('/admin/api/escalations')
      .send({ ...body, urgency: 'emergency' });
    expect(res.status).toBe(201);
    expect(dbMocks.createEscalation).toHaveBeenCalledWith(
      expect.objectContaining({ assignedTo: null }), expect.anything()
    );
    expect(dbMocks.insertWorkItem).toHaveBeenCalledWith(
      expect.objectContaining({ severity: 'urgent', assigneeId: null, assigneeRole: null })
    );
    // Spec 072: unassigned emergency fans out to every org therapist.
    expect(dbMocks.getOrgTherapistIds).toHaveBeenCalledWith(5);
  });

  it('does not fan out to org therapists for a non-emergency pool item', async () => {
    dbMocks.getTherapistIdsForClient.mockResolvedValue([]);
    dbMocks.createEscalation.mockResolvedValue(baseEscalation({ assigned_to: null }));
    await request(appAs('caseworker', 2)).post('/admin/api/escalations').send(body);
    expect(dbMocks.getOrgTherapistIds).not.toHaveBeenCalled();
  });

  it('400s a crisis_event_id that belongs to a different client', async () => {
    dbMocks.getCrisisEventClientInfo.mockResolvedValue({
      event_id: 33, session_id: 's1', client_user_id: null, session_user_id: 77,
    });
    const res = await request(appAs('caseworker', 2))
      .post('/admin/api/escalations')
      .send({ ...body, crisis_event_id: 33 });
    expect(res.status).toBe(400);
    expect(dbMocks.createEscalation).not.toHaveBeenCalled();
  });

  it('accepts a crisis_event_id that belongs to the client', async () => {
    dbMocks.getCrisisEventClientInfo.mockResolvedValue({
      event_id: 33, session_id: 's1', client_user_id: null, session_user_id: 42,
    });
    const res = await request(appAs('caseworker', 2))
      .post('/admin/api/escalations')
      .send({ ...body, crisis_event_id: 33 });
    expect(res.status).toBe(201);
  });

  it('400s a session_id owned by a different client', async () => {
    dbMocks.getSessionAccessInfo.mockResolvedValue({ user_id: 77 });
    const res = await request(appAs('caseworker', 2))
      .post('/admin/api/escalations')
      .send({ ...body, session_id: 'sess_x' });
    expect(res.status).toBe(400);
    expect(dbMocks.createEscalation).not.toHaveBeenCalled();
  });

  it('404s (not 403) when the client is not on the raiser caseload', async () => {
    dbMocks.isAssigned.mockResolvedValue(false);
    const res = await request(appAs('caseworker', 2)).post('/admin/api/escalations').send(body);
    expect(res.status).toBe(404);
    expect(dbMocks.createEscalation).not.toHaveBeenCalled();
  });

  it('rejects researchers (403) and anonymous (401)', async () => {
    expect((await request(appAs('researcher')).post('/admin/api/escalations').send(body)).status).toBe(403);
    expect((await request(appAs(null)).post('/admin/api/escalations').send(body)).status).toBe(401);
  });

  it('400s on missing reason, bad urgency, and off-care-team assigned_to', async () => {
    const app = appAs('caseworker', 2);
    expect((await request(app).post('/admin/api/escalations').send({ ...body, reason: '  ' })).status).toBe(400);
    expect((await request(app).post('/admin/api/escalations').send({ ...body, urgency: 'meh' })).status).toBe(400);
    expect((await request(app).post('/admin/api/escalations').send({ ...body, assigned_to: 777 })).status).toBe(400);
    expect(dbMocks.createEscalation).not.toHaveBeenCalled();
  });

  it('does not fail the create when the work-item insert throws', async () => {
    dbMocks.insertWorkItem.mockRejectedValue(new Error('queue down'));
    const res = await request(appAs('caseworker', 2)).post('/admin/api/escalations').send(body);
    expect(res.status).toBe(201);
  });
});

describe('GET /admin/api/escalations', () => {
  it('scopes care-team members via memberId', async () => {
    dbMocks.listEscalations.mockResolvedValue([baseEscalation()]);
    const res = await request(appAs('caseworker', 2)).get('/admin/api/escalations');
    expect(res.status).toBe(200);
    expect(res.body.escalations).toHaveLength(1);
    expect(dbMocks.listEscalations).toHaveBeenCalledWith(
      // ai-therapist-144: a caseworker's list scope must carry the role so the
      // query EXCLUDES org-unassigned escalations (they can't open those).
      expect.objectContaining({ memberId: 2, memberRole: 'caseworker', orgId: null })
    );
  });

  it('passes memberRole=therapist so the claimable org-unassigned pool stays visible to therapists', async () => {
    dbMocks.listEscalations.mockResolvedValue([]);
    const res = await request(appAs('therapist', 9)).get('/admin/api/escalations');
    expect(res.status).toBe(200);
    expect(dbMocks.listEscalations).toHaveBeenCalledWith(
      expect.objectContaining({ memberId: 9, memberRole: 'therapist' })
    );
  });

  it('scopes researchers to their org', async () => {
    dbMocks.listEscalations.mockResolvedValue([]);
    const res = await request(appAs('researcher', 7)).get('/admin/api/escalations');
    expect(res.status).toBe(200);
    expect(dbMocks.listEscalations).toHaveBeenCalledWith(expect.objectContaining({ memberId: null, orgId: 5 }));
  });

  it('returns the open count for count_only=1 (nav badge)', async () => {
    dbMocks.countOpenEscalationsForMember.mockResolvedValue(4);
    const res = await request(appAs('therapist', 9)).get('/admin/api/escalations?count_only=1');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ count: 4 });
    expect(dbMocks.countOpenEscalationsForMember).toHaveBeenCalledWith(9, 'therapist');
  });

  it('filters mine=1 to escalations raised by me', async () => {
    dbMocks.listEscalations.mockResolvedValue([
      baseEscalation({ escalation_id: 1, raised_by: 2 }),
      baseEscalation({ escalation_id: 2, raised_by: 3 }),
    ]);
    const res = await request(appAs('caseworker', 2)).get('/admin/api/escalations?mine=1');
    expect(res.body.escalations.map((e: { escalation_id: number }) => e.escalation_id)).toEqual([1]);
  });

  it('400s an invalid status filter', async () => {
    expect((await request(appAs('therapist', 9)).get('/admin/api/escalations?status=bogus')).status).toBe(400);
  });
});

describe('GET /admin/api/escalations/:id', () => {
  it('returns detail + events for the raising caseworker', async () => {
    dbMocks.getEscalationById.mockResolvedValue(baseEscalation());
    dbMocks.listEscalationEvents.mockResolvedValue([{ event_id: 1, event_type: 'created' }]);
    const res = await request(appAs('caseworker', 2)).get('/admin/api/escalations/11');
    expect(res.status).toBe(200);
    expect(res.body.escalation.escalation_id).toBe(11);
    expect(res.body.events).toHaveLength(1);
  });

  it('404s a caseworker who neither raised it nor has the client on caseload', async () => {
    dbMocks.getEscalationById.mockResolvedValue(baseEscalation({ raised_by: 99 }));
    dbMocks.isAssigned.mockResolvedValue(false);
    expect((await request(appAs('caseworker', 2)).get('/admin/api/escalations/11')).status).toBe(404);
  });

  it('404s a missing escalation', async () => {
    dbMocks.getEscalationById.mockResolvedValue(null);
    expect((await request(appAs('therapist', 9)).get('/admin/api/escalations/11')).status).toBe(404);
  });
});

describe('POST /admin/api/escalations/:id/acknowledge', () => {
  beforeEach(() => {
    dbMocks.getEscalationById.mockResolvedValue(baseEscalation());
    dbMocks.acknowledgeEscalation.mockResolvedValue(baseEscalation({ status: 'acknowledged' }));
  });

  it('lets the assignee acknowledge, logging the event and notifying the raiser', async () => {
    const res = await request(appAs('therapist', 9)).post('/admin/api/escalations/11/acknowledge');
    expect(res.status).toBe(200);
    expect(res.body.escalation.status).toBe('acknowledged');
    expect(dbMocks.insertEscalationEvent).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: 'acknowledged', actorUserId: 9 })
    );
    expect(dbMocks.insertWorkItem).toHaveBeenCalledWith(
      expect.objectContaining({ itemType: 'escalation_response', assigneeId: 2, sourceTable: 'escalation_events', sourceId: '77' })
    );
  });

  it('403s a therapist who can see it but is not the assignee', async () => {
    const res = await request(appAs('therapist', 8)).post('/admin/api/escalations/11/acknowledge');
    expect(res.status).toBe(403);
    expect(dbMocks.acknowledgeEscalation).not.toHaveBeenCalled();
  });

  it('403s the raising caseworker (ack is a therapist action)', async () => {
    expect((await request(appAs('caseworker', 2)).post('/admin/api/escalations/11/acknowledge')).status).toBe(403);
  });

  it('409s a lost race (no longer open)', async () => {
    dbMocks.acknowledgeEscalation.mockResolvedValue(null);
    expect((await request(appAs('therapist', 9)).post('/admin/api/escalations/11/acknowledge')).status).toBe(409);
  });
});

describe('POST /admin/api/escalations/:id/resolve', () => {
  beforeEach(() => {
    dbMocks.getEscalationById.mockResolvedValue(baseEscalation());
    dbMocks.resolveEscalation.mockResolvedValue(baseEscalation({ status: 'resolved', resolution_note: 'Spoke with client' }));
  });

  it('resolves for the assignee and expires the inbound work item', async () => {
    const res = await request(appAs('therapist', 9))
      .post('/admin/api/escalations/11/resolve')
      .send({ resolution_note: 'Spoke with client' });
    expect(res.status).toBe(200);
    expect(dbMocks.resolveEscalation).toHaveBeenCalledWith(11, 9, 'Spoke with client');
    expect(dbMocks.expireWorkItemsBySource).toHaveBeenCalledWith('escalation_inbound', 'escalations', ['11']);
    expect(dbMocks.insertWorkItem).toHaveBeenCalledWith(
      expect.objectContaining({ itemType: 'escalation_response', assigneeId: 2 })
    );
  });

  it('409s when already resolved', async () => {
    dbMocks.resolveEscalation.mockResolvedValue(null);
    expect((await request(appAs('therapist', 9)).post('/admin/api/escalations/11/resolve')).status).toBe(409);
  });
});

describe('POST /admin/api/escalations/:id/reopen', () => {
  it('reopens a resolved escalation for the raiser', async () => {
    dbMocks.getEscalationById.mockResolvedValue(baseEscalation({ status: 'resolved' }));
    dbMocks.reopenEscalation.mockResolvedValue(baseEscalation({ status: 'open' }));
    const res = await request(appAs('caseworker', 2)).post('/admin/api/escalations/11/reopen');
    expect(res.status).toBe(200);
    expect(dbMocks.insertEscalationEvent).toHaveBeenCalledWith(expect.objectContaining({ eventType: 'reopened' }));
  });

  it('re-enqueues the escalation_inbound work item for the assignee (reopen reactivates the expired row)', async () => {
    dbMocks.getEscalationById.mockResolvedValue(baseEscalation({ status: 'resolved' }));
    dbMocks.reopenEscalation.mockResolvedValue(baseEscalation({ status: 'open' }));
    await request(appAs('caseworker', 2)).post('/admin/api/escalations/11/reopen');
    expect(dbMocks.insertWorkItem).toHaveBeenCalledWith(
      expect.objectContaining({
        itemType: 'escalation_inbound',
        assigneeId: 9,
        assigneeRole: 'therapist',
        severity: 'warning',
        sourceTable: 'escalations',
        sourceId: '11', // same source key as the create: the resolve-expired row is reactivated
        reopen: true,
      })
    );
  });

  it('fans an unassigned emergency reopen out to every org therapist', async () => {
    dbMocks.getEscalationById.mockResolvedValue(baseEscalation({ status: 'resolved', assigned_to: null, urgency: 'emergency' }));
    dbMocks.reopenEscalation.mockResolvedValue(baseEscalation({ status: 'open', assigned_to: null, urgency: 'emergency' }));
    await request(appAs('caseworker', 2)).post('/admin/api/escalations/11/reopen');
    expect(dbMocks.insertWorkItem).toHaveBeenCalledWith(
      expect.objectContaining({ itemType: 'escalation_inbound', assigneeId: null, severity: 'urgent', reopen: true })
    );
    expect(dbMocks.getOrgTherapistIds).toHaveBeenCalledWith(5);
  });

  it('409s when not resolved', async () => {
    dbMocks.getEscalationById.mockResolvedValue(baseEscalation());
    dbMocks.reopenEscalation.mockResolvedValue(null);
    expect((await request(appAs('caseworker', 2)).post('/admin/api/escalations/11/reopen')).status).toBe(409);
  });
});

describe('POST /admin/api/escalations/:id/comments', () => {
  beforeEach(() => {
    dbMocks.getEscalationById.mockResolvedValue(baseEscalation());
  });

  it('appends a comment event and notifies the raiser when someone else comments', async () => {
    const res = await request(appAs('therapist', 9))
      .post('/admin/api/escalations/11/comments')
      .send({ comment: 'Following up tomorrow' });
    expect(res.status).toBe(201);
    expect(dbMocks.insertEscalationEvent).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: 'comment', detail: { comment: 'Following up tomorrow' } })
    );
    expect(dbMocks.insertWorkItem).toHaveBeenCalledWith(expect.objectContaining({ itemType: 'escalation_response' }));
  });

  it('does not enqueue a response item when the raiser comments on their own escalation', async () => {
    await request(appAs('caseworker', 2)).post('/admin/api/escalations/11/comments').send({ comment: 'Adding context' });
    expect(dbMocks.insertWorkItem).not.toHaveBeenCalled();
  });

  it('400s an empty comment', async () => {
    expect((await request(appAs('therapist', 9)).post('/admin/api/escalations/11/comments').send({})).status).toBe(400);
  });
});

describe('POST /admin/api/escalations/:id/claim', () => {
  beforeEach(() => {
    dbMocks.getEscalationById.mockResolvedValue(baseEscalation({ assigned_to: null }));
    dbMocks.claimEscalation.mockResolvedValue(baseEscalation({ assigned_to: 8 }));
  });

  it('lets a same-org therapist claim, auto-granting audited caseload access', async () => {
    const res = await request(appAs('therapist', 8)).post('/admin/api/escalations/11/claim');
    expect(res.status).toBe(200);
    expect(dbMocks.claimEscalation).toHaveBeenCalledWith(11, 8);
    // ai-therapist-145: grant + audit are one transactional call now.
    expect(dbMocks.assignClientAudited).toHaveBeenCalledWith(
      8, 42, 8,
      expect.objectContaining({ detail: expect.objectContaining({ via: 'escalation_claim' }) })
    );
    expect(dbMocks.insertEscalationEvent).toHaveBeenCalledWith(expect.objectContaining({ eventType: 'claimed' }));
  });

  it('404s a therapist from a different org', async () => {
    dbMocks.getOrganizationIdForUser.mockResolvedValue(6);
    dbMocks.isAssigned.mockResolvedValue(false);
    expect((await request(appAs('therapist', 8)).post('/admin/api/escalations/11/claim')).status).toBe(404);
  });

  it('409s when someone else won the claim race', async () => {
    dbMocks.claimEscalation.mockResolvedValue(null);
    expect((await request(appAs('therapist', 8)).post('/admin/api/escalations/11/claim')).status).toBe(409);
  });

  it('is therapist-only (caseworkers cannot claim)', async () => {
    expect((await request(appAs('caseworker', 2)).post('/admin/api/escalations/11/claim')).status).toBe(403);
  });
});
