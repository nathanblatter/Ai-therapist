// Audit-trail read API (ai-therapist-197): role gates, filter validation,
// caseload/org scoping on the per-participant history, and the self-audit
// row that read writes.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

const dbMocks = vi.hoisted(() => ({
  listDataAccessLog: vi.fn(),
  getParticipantAccessHistory: vi.fn(),
  listRedactionReviewLog: vi.fn(),
  listAssistantAudit: vi.fn(),
  logDataAccess: vi.fn(),
  isDataAccessAction: (v: unknown) =>
    ['transcript_view', 'recording_stream', 'export', 'dataset_export', 'audit_log_view'].includes(String(v)),
  // Caseload middleware (requireClientAccess).
  isAssigned: vi.fn(),
  getSessionAccessInfo: vi.fn(),
  getMessageOwner: vi.fn(),
  getCareNoteById: vi.fn(),
  getEscalationById: vi.fn(),
  // Org resolution (middleware/org.ts, C13).
  getOrganizationIdForUser: vi.fn(),
  getIrbStudyOrgId: vi.fn(),
}));
vi.mock('../../db/index.js', () => dbMocks);

import auditRoutes from './audit.routes.js';

function appAs(role: string | null, userId = 1) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { session: Record<string, unknown> }).session = role
      ? { userId, userRole: role, username: 'tester' }
      : {};
    next();
  });
  app.use(auditRoutes());
  return app;
}

const ROW = {
  id: 10, accessed_by: 7, actor_username: 'r1', role: 'researcher', action: 'transcript_view',
  session_id: 's-1', participant_user_id: 42, participant_username: 'p42',
  detail: { contentColumn: 'content_redacted' }, created_at: '2026-10-01T00:00:00Z',
};

beforeEach(() => {
  dbMocks.listDataAccessLog.mockReset().mockResolvedValue({ rows: [ROW], total: 1 });
  dbMocks.getParticipantAccessHistory.mockReset().mockResolvedValue({
    rows: [ROW], total: 1,
    actors: [{ accessed_by: 7, actor_username: 'r1', role: 'researcher', action: 'transcript_view', count: 1, first_at: ROW.created_at, last_at: ROW.created_at }],
  });
  dbMocks.listRedactionReviewLog.mockReset().mockResolvedValue({ rows: [], total: 0 });
  dbMocks.listAssistantAudit.mockReset().mockResolvedValue({ rows: [], total: 0 });
  dbMocks.logDataAccess.mockReset().mockResolvedValue(undefined);
  dbMocks.isAssigned.mockReset().mockResolvedValue(false);
  dbMocks.getOrganizationIdForUser.mockReset().mockResolvedValue(1);
  dbMocks.getIrbStudyOrgId.mockReset().mockResolvedValue(1);
});

describe('GET /admin/api/audit/data-access', () => {
  it('returns a page with total for a researcher, org-scoped', async () => {
    const res = await request(appAs('researcher')).get('/admin/api/audit/data-access?limit=25&offset=50');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ total: 1, limit: 25, offset: 50 });
    expect(res.body.rows[0]).toMatchObject({ id: 10, actor_username: 'r1' });
    expect(dbMocks.listDataAccessLog).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 25, offset: 50, participantUserId: null, action: null }),
      1
    );
  });

  it('passes every filter through, normalizing dates to ISO', async () => {
    const res = await request(appAs('researcher')).get(
      '/admin/api/audit/data-access?participantUserId=42&sessionId=s-1&actorUsername=r1&action=export&since=2026-10-01&until=2026-10-02T00:00:00Z'
    );
    expect(res.status).toBe(200);
    expect(dbMocks.listDataAccessLog.mock.calls[0][0]).toMatchObject({
      participantUserId: 42, sessionId: 's-1', actorUsername: 'r1', action: 'export',
      since: '2026-10-01T00:00:00.000Z', until: '2026-10-02T00:00:00.000Z',
    });
  });

  it('rejects malformed filters with 400', async () => {
    const app = appAs('researcher');
    expect((await request(app).get('/admin/api/audit/data-access?action=bogus')).status).toBe(400);
    expect((await request(app).get('/admin/api/audit/data-access?participantUserId=abc')).status).toBe(400);
    expect((await request(app).get('/admin/api/audit/data-access?since=not-a-date')).status).toBe(400);
    expect(dbMocks.listDataAccessLog).not.toHaveBeenCalled();
  });

  it('is researcher-only: therapist/caseworker 403, anonymous 401', async () => {
    expect((await request(appAs('therapist')).get('/admin/api/audit/data-access')).status).toBe(403);
    expect((await request(appAs('caseworker')).get('/admin/api/audit/data-access')).status).toBe(403);
    expect((await request(appAs(null)).get('/admin/api/audit/data-access')).status).toBe(401);
  });

  it('does not write a self-audit row for the global list', async () => {
    await request(appAs('researcher')).get('/admin/api/audit/data-access');
    expect(dbMocks.logDataAccess).not.toHaveBeenCalled();
  });

  it('maps a query failure to 500', async () => {
    dbMocks.listDataAccessLog.mockRejectedValueOnce(new Error('db down'));
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect((await request(appAs('researcher')).get('/admin/api/audit/data-access')).status).toBe(500);
    spy.mockRestore();
  });
});

describe('GET /admin/api/audit/data-access/participant/:userId', () => {
  it('returns history plus actor rollup for a researcher in the same org and logs the read', async () => {
    const res = await request(appAs('researcher', 7)).get('/admin/api/audit/data-access/participant/42');
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(1);
    expect(res.body.actors[0]).toMatchObject({ actor_username: 'r1', count: 1 });
    expect(dbMocks.getParticipantAccessHistory).toHaveBeenCalledWith(42, { limit: 50, offset: 0 });
    expect(dbMocks.logDataAccess).toHaveBeenCalledWith(
      expect.objectContaining({ accessedBy: 7, role: 'researcher', action: 'audit_log_view', userId: 42 })
    );
  });

  it('404s a researcher for a participant in another org and does not log', async () => {
    // caller (userId 7) -> org 1; participant 42 -> org 2
    dbMocks.getOrganizationIdForUser.mockImplementation(async (id: number) => (id === 42 ? 2 : 1));
    const res = await request(appAs('researcher', 7)).get('/admin/api/audit/data-access/participant/42');
    expect(res.status).toBe(404);
    expect(dbMocks.getParticipantAccessHistory).not.toHaveBeenCalled();
    expect(dbMocks.logDataAccess).not.toHaveBeenCalled();
  });

  it('allows a therapist only for a caseload client (404 otherwise)', async () => {
    dbMocks.isAssigned.mockResolvedValueOnce(false);
    const denied = await request(appAs('therapist', 3)).get('/admin/api/audit/data-access/participant/42');
    expect(denied.status).toBe(404);
    expect(dbMocks.getParticipantAccessHistory).not.toHaveBeenCalled();

    dbMocks.isAssigned.mockResolvedValueOnce(true);
    const ok = await request(appAs('therapist', 3)).get('/admin/api/audit/data-access/participant/42?limit=10');
    expect(ok.status).toBe(200);
    expect(dbMocks.isAssigned).toHaveBeenLastCalledWith(3, 42);
    expect(dbMocks.getParticipantAccessHistory).toHaveBeenCalledWith(42, { limit: 10, offset: 0 });
    expect(dbMocks.logDataAccess).toHaveBeenCalledWith(
      expect.objectContaining({ accessedBy: 3, role: 'therapist', action: 'audit_log_view', userId: 42 })
    );
  });

  it('excludes caseworkers (403) and anonymous (401)', async () => {
    expect((await request(appAs('caseworker')).get('/admin/api/audit/data-access/participant/42')).status).toBe(403);
    expect((await request(appAs(null)).get('/admin/api/audit/data-access/participant/42')).status).toBe(401);
  });

  it('rejects a non-numeric user id with 400', async () => {
    expect((await request(appAs('researcher')).get('/admin/api/audit/data-access/participant/abc')).status).toBe(400);
  });
});

describe('GET /admin/api/audit/redaction-review', () => {
  it('returns a page for a researcher with validated filters', async () => {
    const res = await request(appAs('researcher')).get('/admin/api/audit/redaction-review?reviewedBy=5&action=corrected');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ rows: [], total: 0, limit: 50, offset: 0 });
    expect(dbMocks.listRedactionReviewLog).toHaveBeenCalledWith({ reviewedBy: 5, action: 'corrected', limit: 50, offset: 0 });
  });

  it('rejects an unknown action and non-researchers', async () => {
    expect((await request(appAs('researcher')).get('/admin/api/audit/redaction-review?action=nope')).status).toBe(400);
    expect((await request(appAs('therapist')).get('/admin/api/audit/redaction-review')).status).toBe(403);
  });
});

describe('GET /admin/api/audit/assistant', () => {
  it('returns an org-scoped page for a researcher', async () => {
    const res = await request(appAs('researcher')).get('/admin/api/audit/assistant?username=t1&since=2026-10-01');
    expect(res.status).toBe(200);
    expect(dbMocks.listAssistantAudit).toHaveBeenCalledWith(
      expect.objectContaining({ username: 't1', since: '2026-10-01T00:00:00.000Z', userId: null }),
      1
    );
  });

  it('rejects malformed filters and non-researchers', async () => {
    expect((await request(appAs('researcher')).get('/admin/api/audit/assistant?userId=x')).status).toBe(400);
    expect((await request(appAs('caseworker')).get('/admin/api/audit/assistant')).status).toBe(403);
  });
});
