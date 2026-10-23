// Route coverage for adverse-event admin API (ai-therapist-95): auth (403 for
// participant) and invalid-transition 409. Caseworker AE filing (caseworker
// portal spec s10 item 6): file for caseload client, 404 for non-caseload,
// reporter-filtered reads, review endpoints stay closed. Org scoping
// (ai-therapist-228): every read/write resolves through an AdverseEventScope;
// a report outside the caller's org reads as 404, never 403.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

const {
  listMock, countsMock, getByIdMock, submitMock,
  insertDraftMock, isAssignedMock, isSandboxMock, auditMock, enqueueMock,
  getSessionAccessInfoMock, draftFromCrisisMock, getOrgForUserMock,
} = vi.hoisted(() => ({
  listMock: vi.fn(),
  countsMock: vi.fn(),
  getByIdMock: vi.fn(),
  submitMock: vi.fn(),
  insertDraftMock: vi.fn(),
  isAssignedMock: vi.fn(),
  isSandboxMock: vi.fn(),
  auditMock: vi.fn().mockResolvedValue(undefined),
  enqueueMock: vi.fn().mockResolvedValue(null),
  getSessionAccessInfoMock: vi.fn(),
  draftFromCrisisMock: vi.fn(),
  getOrgForUserMock: vi.fn().mockResolvedValue(1),
}));

vi.mock('../../db/index.js', () => ({
  listAdverseEvents: listMock,
  getAdverseEventCounts: countsMock,
  getAdverseEventById: getByIdMock,
  updateAdverseEventDraft: vi.fn(),
  submitAdverseEvent: submitMock,
  closeAdverseEvent: vi.fn(),
  reopenAdverseEvent: vi.fn(),
  insertAdverseEventDraft: insertDraftMock,
  insertCaseloadAudit: auditMock,
  isSandboxAccount: isSandboxMock,
  // Transitive imports of middleware/caseload.ts + middleware/org.ts.
  isAssigned: isAssignedMock,
  getSessionAccessInfo: getSessionAccessInfoMock,
  getMessageOwner: vi.fn(),
  getCareNoteById: vi.fn(),
  getEscalationById: vi.fn(),
  getOrganizationIdForUser: getOrgForUserMock,
  getIrbStudyOrgId: vi.fn().mockResolvedValue(1),
}));
vi.mock('../../services/workQueue.service.js', () => ({ enqueueWorkItem: enqueueMock }));
vi.mock('../../services/adverseEvent.service.js', () => ({ draftAdverseEventFromCrisis: draftFromCrisisMock }));
vi.mock('../../utils/aePrintView.js', () => ({ renderAdverseEventPrintHtml: () => '<html></html>' }));

import adverseEventsRoutes from './adverseEvents.routes.js';

// orgId lands on the session the way login stamps it (orgIdFor reads it first).
function appAs(role: string | null, userId = 1, username = 'tester', orgId = 1) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { session: Record<string, unknown> }).session = role
      ? { userId, userRole: role, username, orgId }
      : {};
    next();
  });
  app.use(adverseEventsRoutes());
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
  auditMock.mockResolvedValue(undefined);
  enqueueMock.mockResolvedValue(null);
  getOrgForUserMock.mockResolvedValue(1);
});

/** Simulate the SQL scope: the row is visible only to org 1 callers. */
function visibleOnlyToOrg1(row: Record<string, unknown>) {
  getByIdMock.mockImplementation(async (_id: number, scope: { orgId: number }) => (scope.orgId === 1 ? row : null));
}

describe('GET /admin/api/adverse-events', () => {
  it('returns counts + reports for a therapist, scoped to org + caseload/own-filed', async () => {
    countsMock.mockResolvedValueOnce({ draft: 1, submitted: 0, overdue: 0, due_soon: 0 });
    listMock.mockResolvedValueOnce([{ report_id: 1 }]);
    const res = await request(appAs('therapist', 7, 'ther1', 3)).get('/admin/api/adverse-events?status=draft');
    expect(res.status).toBe(200);
    expect(res.body.reports).toHaveLength(1);
    const scope = { orgId: 3, careTeam: { role: 'therapist', memberId: 7, username: 'ther1' } };
    expect(listMock).toHaveBeenCalledWith({ status: 'draft' }, scope);
    expect(countsMock).toHaveBeenCalledWith(scope);
  });

  it('scopes a researcher to their organization only (no care-team restriction)', async () => {
    countsMock.mockResolvedValueOnce({ draft: 0, submitted: 0, overdue: 0, due_soon: 0 });
    listMock.mockResolvedValueOnce([]);
    const res = await request(appAs('researcher', 9, 'res1', 2)).get('/admin/api/adverse-events');
    expect(res.status).toBe(200);
    expect(listMock).toHaveBeenCalledWith({ status: null }, { orgId: 2, careTeam: null });
    expect(countsMock).toHaveBeenCalledWith({ orgId: 2, careTeam: null });
  });

  it('403s a participant', async () => {
    const res = await request(appAs('participant')).get('/admin/api/adverse-events');
    expect(res.status).toBe(403);
  });

  it('404s a sandbox account (stopgap kept alongside org scoping)', async () => {
    const app = express();
    app.use((req, _res, next) => {
      (req as unknown as { session: Record<string, unknown> }).session =
        { userId: 5, userRole: 'therapist', username: 'sb', orgId: 4, isSandbox: true };
      next();
    });
    app.use(adverseEventsRoutes());
    const res = await request(app).get('/admin/api/adverse-events');
    expect(res.status).toBe(404);
    expect(listMock).not.toHaveBeenCalled();
  });

  it('scopes a caseworker to their own filed reports in SQL and scrubs transcript excerpts', async () => {
    countsMock.mockResolvedValueOnce({ draft: 1, submitted: 1, overdue: 0, due_soon: 0 });
    listMock.mockResolvedValueOnce([
      { report_id: 1, status: 'draft', created_by: 'cw1', transcript_excerpt: 'Participant: [redacted]' },
      { report_id: 3, status: 'submitted', created_by: 'cw1', transcript_excerpt: null },
    ]);
    const res = await request(appAs('caseworker', 7, 'cw1')).get('/admin/api/adverse-events?status=all');
    expect(res.status).toBe(200);
    expect(res.body.reports.map((r: { report_id: number }) => r.report_id)).toEqual([1, 3]);
    expect(res.body.reports.every((r: { transcript_excerpt: unknown }) => r.transcript_excerpt === null)).toBe(true);
    expect(res.body.counts).toEqual({ draft: 1, submitted: 1, overdue: 0, due_soon: 0 });
    const scope = { orgId: 1, careTeam: { role: 'caseworker', memberId: 7, username: 'cw1' } };
    expect(listMock).toHaveBeenCalledWith({ status: 'all' }, scope);
    // Counts come from the same scoped SQL, never the global table.
    expect(countsMock).toHaveBeenCalledWith(scope);
  });

  it('500s (fail closed) when the org cannot be resolved instead of widening the read', async () => {
    getOrgForUserMock.mockRejectedValueOnce(new Error('db down'));
    const app = express();
    app.use((req, _res, next) => {
      (req as unknown as { session: Record<string, unknown> }).session = { userId: 9, userRole: 'researcher', username: 'res1' };
      next();
    });
    app.use(adverseEventsRoutes());
    const res = await request(app).get('/admin/api/adverse-events');
    expect(res.status).toBe(500);
    expect(listMock).not.toHaveBeenCalled();
  });
});

describe('GET /admin/api/adverse-events/:id', () => {
  it("404s a caseworker on another reporter's report (never 403)", async () => {
    // The SQL scope (created_by = caller) returns no row for someone else's report.
    getByIdMock.mockResolvedValueOnce(null);
    const res = await request(appAs('caseworker', 7, 'cw1')).get('/admin/api/adverse-events/5');
    expect(res.status).toBe(404);
    expect(getByIdMock).toHaveBeenCalledWith(5, { orgId: 1, careTeam: { role: 'caseworker', memberId: 7, username: 'cw1' } });
  });

  it('returns a caseworker their own report with the transcript excerpt scrubbed', async () => {
    getByIdMock.mockResolvedValueOnce({ report_id: 5, created_by: 'cw1', transcript_excerpt: 'Participant: [redacted]' });
    const res = await request(appAs('caseworker', 7, 'cw1')).get('/admin/api/adverse-events/5');
    expect(res.status).toBe(200);
    expect(res.body.report_id).toBe(5);
    expect(res.body.transcript_excerpt).toBeNull();
  });

  it('leaves the transcript excerpt intact for a therapist', async () => {
    getByIdMock.mockResolvedValueOnce({ report_id: 5, created_by: 'cw1', transcript_excerpt: 'Participant: [redacted]' });
    const res = await request(appAs('therapist')).get('/admin/api/adverse-events/5');
    expect(res.status).toBe(200);
    expect(res.body.transcript_excerpt).toBe('Participant: [redacted]');
  });

  describe('cross-organization (org B reading org A)', () => {
    const orgARow = { report_id: 5, organization_id: 1, created_by: 'system', summary: 'org A report' };

    it.each(['researcher', 'therapist'] as const)('404s a %s from org 2 on an org 1 report, and 200s org 1', async (role) => {
      visibleOnlyToOrg1(orgARow);
      const denied = await request(appAs(role, 9, 'orgb', 2)).get('/admin/api/adverse-events/5');
      expect(denied.status).toBe(404);
      expect(denied.body).toEqual({ error: 'not found' });
      expect(getByIdMock).toHaveBeenLastCalledWith(5, expect.objectContaining({ orgId: 2 }));

      const allowed = await request(appAs(role, 9, 'orga', 1)).get('/admin/api/adverse-events/5');
      expect(allowed.status).toBe(200);
      expect(allowed.body.summary).toBe('org A report');
    });

    it('404s the print/export view across orgs', async () => {
      visibleOnlyToOrg1(orgARow);
      const res = await request(appAs('researcher', 9, 'orgb', 2)).get('/admin/api/adverse-events/5/print');
      expect(res.status).toBe(404);
    });

    it.each([
      ['patch', '/admin/api/adverse-events/5'],
      ['post', '/admin/api/adverse-events/5/submit'],
      ['post', '/admin/api/adverse-events/5/reopen'],
      ['post', '/admin/api/adverse-events/5/close'],
    ] as const)('404s %s %s across orgs before any mutation runs', async (method, path) => {
      visibleOnlyToOrg1(orgARow);
      const agent = request(appAs('researcher', 9, 'orgb', 2));
      const res = await (method === 'patch' ? agent.patch(path).send({ summary: 'x' }) : agent.post(path));
      expect(res.status).toBe(404);
      expect(submitMock).not.toHaveBeenCalled();
    });
  });
});

describe('POST /admin/api/adverse-events/:id/submit', () => {
  it('409s when the report is not a draft (transition guard)', async () => {
    getByIdMock.mockResolvedValueOnce({ report_id: 1, status: 'submitted' });
    submitMock.mockResolvedValueOnce(false);
    const res = await request(appAs('researcher')).post('/admin/api/adverse-events/1/submit');
    expect(res.status).toBe(409);
  });

  it('signs off with the session username on success', async () => {
    getByIdMock.mockResolvedValueOnce({ report_id: 1, status: 'draft' });
    submitMock.mockResolvedValueOnce(true);
    getByIdMock.mockResolvedValueOnce({ report_id: 1, status: 'submitted', submitted_by: 'tester' });
    const res = await request(appAs('therapist')).post('/admin/api/adverse-events/1/submit');
    expect(res.status).toBe(200);
    expect(submitMock).toHaveBeenCalledWith(1, 'tester');
  });

  it('403s a participant', async () => {
    const res = await request(appAs('participant')).post('/admin/api/adverse-events/1/submit');
    expect(res.status).toBe(403);
  });
});

describe('review/lifecycle endpoints stay closed to caseworkers', () => {
  it.each([
    ['patch', '/admin/api/adverse-events/1'],
    ['post', '/admin/api/adverse-events/1/submit'],
    ['post', '/admin/api/adverse-events/1/reopen'],
    ['post', '/admin/api/adverse-events/1/close'],
    ['get', '/admin/api/adverse-events/1/print'],
    ['post', '/admin/api/sessions/s1/adverse-events'],
  ] as const)('403s a caseworker on %s %s', async (method, path) => {
    const agent = request(appAs('caseworker', 7, 'cw1'));
    const res = await (method === 'patch' ? agent.patch(path).send({ summary: 'x' })
      : method === 'post' ? agent.post(path)
      : agent.get(path));
    expect(res.status).toBe(403);
  });
});

describe('POST /admin/api/sessions/:sessionId/adverse-events (manual session filing)', () => {
  it("404s a therapist filing from a session outside their caseload (never 403; no transcript leak)", async () => {
    // Session owned by client 55, who is NOT on this therapist's caseload.
    getSessionAccessInfoMock.mockResolvedValueOnce({ user_id: 55 });
    isAssignedMock.mockResolvedValueOnce(false);
    const res = await request(appAs('therapist', 7, 'ther1'))
      .post('/admin/api/sessions/s1/adverse-events');
    expect(res.status).toBe(404);
    // The caseload guard must short-circuit before the draft assembler runs,
    // so no redacted transcript excerpt is ever built or returned.
    expect(draftFromCrisisMock).not.toHaveBeenCalled();
  });

  it('files for a session on the caseload therapist', async () => {
    getSessionAccessInfoMock.mockResolvedValueOnce({ user_id: 55 });
    isAssignedMock.mockResolvedValueOnce(true);
    draftFromCrisisMock.mockResolvedValueOnce(77);
    getByIdMock.mockResolvedValueOnce({ report_id: 77, status: 'draft' });
    const res = await request(appAs('therapist', 7, 'ther1'))
      .post('/admin/api/sessions/s1/adverse-events');
    expect(res.status).toBe(201);
    expect(res.body.report_id).toBe(77);
    expect(draftFromCrisisMock).toHaveBeenCalledWith('s1', expect.objectContaining({ triggerSource: 'manual' }));
  });

  it('lets a researcher file from any session owned by their organization', async () => {
    getSessionAccessInfoMock.mockResolvedValue({ user_id: 55 });
    getOrgForUserMock.mockResolvedValue(1); // session owner 55 is in org 1
    draftFromCrisisMock.mockResolvedValueOnce(88);
    getByIdMock.mockResolvedValueOnce({ report_id: 88, status: 'draft' });
    const res = await request(appAs('researcher', 9, 'res1', 1))
      .post('/admin/api/sessions/s1/adverse-events');
    expect(res.status).toBe(201);
    // Researcher passes the care-team gate without a caseload lookup.
    expect(isAssignedMock).not.toHaveBeenCalled();
  });

  it("404s a researcher filing from another organization's session (never 403; no draft)", async () => {
    getSessionAccessInfoMock.mockResolvedValue({ user_id: 55 });
    getOrgForUserMock.mockResolvedValue(1); // owner in org 1, caller in org 2
    const res = await request(appAs('researcher', 9, 'res2', 2))
      .post('/admin/api/sessions/s1/adverse-events');
    expect(res.status).toBe(404);
    expect(draftFromCrisisMock).not.toHaveBeenCalled();
  });

  it('treats an anonymous session as irb-study custody for the manual filing org check', async () => {
    getSessionAccessInfoMock.mockResolvedValue({ user_id: null });
    draftFromCrisisMock.mockResolvedValueOnce(89);
    getByIdMock.mockResolvedValueOnce({ report_id: 89, status: 'draft' });
    const irb = await request(appAs('researcher', 9, 'res1', 1)).post('/admin/api/sessions/s1/adverse-events');
    expect(irb.status).toBe(201);
    const other = await request(appAs('researcher', 9, 'res2', 2)).post('/admin/api/sessions/s1/adverse-events');
    expect(other.status).toBe(404);
    expect(draftFromCrisisMock).toHaveBeenCalledTimes(1);
  });
});

describe('POST /admin/api/clients/:userId/adverse-events (caseworker filing)', () => {
  const body = { summary: 'Client reported severe distress after discharge call.', severity: 'high' };

  it('files a draft for a caseload client, audits, and enqueues the work item', async () => {
    isAssignedMock.mockResolvedValueOnce(true);
    isSandboxMock.mockResolvedValueOnce(false);
    insertDraftMock.mockResolvedValueOnce(42);
    getByIdMock.mockResolvedValueOnce({ report_id: 42, status: 'draft', created_by: 'cw1' });

    const res = await request(appAs('caseworker', 7, 'cw1'))
      .post('/admin/api/clients/33/adverse-events')
      .send({ ...body, actions_taken: ['Called client back', '  '] });

    expect(res.status).toBe(201);
    expect(res.body.report_id).toBe(42);
    expect(isAssignedMock).toHaveBeenCalledWith(7, 33);
    expect(insertDraftMock).toHaveBeenCalledWith(expect.objectContaining({
      userId: 33,
      sessionId: null,
      crisisEventId: null,
      triggerSource: 'manual',
      severity: 'high',
      createdBy: 'cw1',
      transcriptExcerpt: null,
      actionsTaken: [expect.objectContaining({ action: 'Called client back', by: 'cw1' })],
    }));
    expect(auditMock).toHaveBeenCalledWith(expect.objectContaining({
      action: 'adverse_event_filed',
      therapistId: 7,
      clientId: 33,
      actorUsername: 'cw1',
      detail: expect.objectContaining({ report_id: 42 }),
    }));
    expect(enqueueMock).toHaveBeenCalledWith(expect.objectContaining({
      itemType: 'adverse_event',
      sourceTable: 'adverse_event_reports',
      sourceId: '42',
      clientId: 33,
    }));
  });

  it('404s a caseworker filing for a client NOT on their caseload (never 403)', async () => {
    isAssignedMock.mockResolvedValueOnce(false);
    const res = await request(appAs('caseworker', 7, 'cw1'))
      .post('/admin/api/clients/99/adverse-events')
      .send(body);
    expect(res.status).toBe(404);
    expect(insertDraftMock).not.toHaveBeenCalled();
    expect(auditMock).not.toHaveBeenCalled();
    expect(enqueueMock).not.toHaveBeenCalled();
  });

  it('400s a missing summary and an invalid severity', async () => {
    isAssignedMock.mockResolvedValue(true);
    const app = appAs('caseworker', 7, 'cw1');
    const noSummary = await request(app).post('/admin/api/clients/33/adverse-events').send({ severity: 'high' });
    expect(noSummary.status).toBe(400);
    const badSeverity = await request(app).post('/admin/api/clients/33/adverse-events').send({ summary: 'x', severity: 'catastrophic' });
    expect(badSeverity.status).toBe(400);
    expect(insertDraftMock).not.toHaveBeenCalled();
  });

  it('422s filing for a sandbox client (synthetic accounts are not IRB reports)', async () => {
    isAssignedMock.mockResolvedValueOnce(true);
    isSandboxMock.mockResolvedValueOnce(true);
    const res = await request(appAs('caseworker', 7, 'cw1'))
      .post('/admin/api/clients/33/adverse-events')
      .send(body);
    expect(res.status).toBe(422);
    expect(insertDraftMock).not.toHaveBeenCalled();
  });

  it('403s a researcher (filing is a care-team act)', async () => {
    const res = await request(appAs('researcher')).post('/admin/api/clients/33/adverse-events').send(body);
    expect(res.status).toBe(403);
  });
});
