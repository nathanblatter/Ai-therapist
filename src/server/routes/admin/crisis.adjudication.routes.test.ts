// Crisis adjudication endpoints (eval program WP2): verdict validation, the
// 404-over-403 owner rule for session- and thread-origin events, and the
// caseworker denial (a verdict is a clinical judgement, not a summary read).
import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

const dbMocks = vi.hoisted(() => ({
  getCrisisEventClientInfo: vi.fn(),
  getCrisisEventAdjudications: vi.fn(async () => []),
  upsertCrisisEventAdjudication: vi.fn(async (eventId: number, adjudicatorId: number, verdict: string, note: string | null) => ({ adjudication_id: 1, crisis_event_id: eventId, adjudicator_id: adjudicatorId, verdict, note })),
  ADJUDICATION_VERDICTS: ['confirmed', 'false_positive', 'unclear'],
  sessionExists: vi.fn(async () => true),
  getSessionCrisisFlag: vi.fn(),
  getAllCrisisData: vi.fn(),
  getAllCrisisEvents: vi.fn(),
  getCaseloadClientIds: vi.fn(async () => [42]),
  getSessionRiskCheckLadder: vi.fn(),
  getParticipantRiskCheckLadders: vi.fn(),
  getSessionAccessInfo: vi.fn(async () => ({ user_id: 42, status: 'ended', owner_organization_id: 1 })),
  isAssigned: vi.fn(async () => true),
  getMessageOwner: vi.fn(),
  getCareNoteById: vi.fn(),
  getEscalationById: vi.fn(),
  getOrganizationIdForUser: vi.fn(async () => 1),
  getIrbStudyOrgId: vi.fn(async () => 1),
}));
vi.mock('../../db/index.js', () => dbMocks);

const { default: crisisRoutes } = await import('./crisis.routes.js');

function appAs(role: string, userId = 1, orgId = 1) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { session: Record<string, unknown> }).session = { userId, userRole: role, username: 'tester', orgId };
    next();
  });
  app.use(crisisRoutes());
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
  dbMocks.getCrisisEventClientInfo.mockResolvedValue({ event_id: 12, session_id: 'sess_1', client_user_id: null, session_user_id: 42 });
  dbMocks.getSessionAccessInfo.mockResolvedValue({ user_id: 42, status: 'ended', owner_organization_id: 1 });
  dbMocks.isAssigned.mockResolvedValue(true);
  dbMocks.getOrganizationIdForUser.mockResolvedValue(1);
});

describe('PUT /admin/api/crisis/events/:eventId/adjudication', () => {
  it('upserts the caller verdict (and trimmed note) for a researcher in the owner org', async () => {
    const res = await request(appAs('researcher', 1)).put('/admin/api/crisis/events/12/adjudication').send({ verdict: 'false_positive', note: '  benign  ' });
    expect(res.status).toBe(200);
    expect(dbMocks.upsertCrisisEventAdjudication).toHaveBeenCalledWith(12, 1, 'false_positive', 'benign');
    expect(res.body.adjudication.verdict).toBe('false_positive');
  });

  it('rejects an unknown verdict, a long note and a bad id before any lookup', async () => {
    expect((await request(appAs('researcher')).put('/admin/api/crisis/events/12/adjudication').send({ verdict: 'maybe' })).status).toBe(400);
    expect((await request(appAs('researcher')).put('/admin/api/crisis/events/12/adjudication').send({ verdict: 'unclear', note: 'x'.repeat(2001) })).status).toBe(400);
    expect((await request(appAs('researcher')).put('/admin/api/crisis/events/abc/adjudication').send({ verdict: 'unclear' })).status).toBe(400);
    expect(dbMocks.getCrisisEventClientInfo).not.toHaveBeenCalled();
  });

  it('404s for a therapist whose caseload lacks the session owner', async () => {
    dbMocks.isAssigned.mockResolvedValue(false);
    const res = await request(appAs('therapist', 7)).put('/admin/api/crisis/events/12/adjudication').send({ verdict: 'confirmed' });
    expect(res.status).toBe(404);
    expect(dbMocks.upsertCrisisEventAdjudication).not.toHaveBeenCalled();
  });

  it('404s for a researcher outside the owner org and for an unknown event', async () => {
    expect((await request(appAs('researcher', 1, 9)).put('/admin/api/crisis/events/12/adjudication').send({ verdict: 'confirmed' })).status).toBe(404);
    dbMocks.getCrisisEventClientInfo.mockResolvedValueOnce(null);
    expect((await request(appAs('researcher')).put('/admin/api/crisis/events/999/adjudication').send({ verdict: 'confirmed' })).status).toBe(404);
  });

  it('resolves a thread-origin event through client_user_id (therapist caseload, researcher org)', async () => {
    dbMocks.getCrisisEventClientInfo.mockResolvedValue({ event_id: 13, session_id: null, client_user_id: 42, session_user_id: null });
    expect((await request(appAs('therapist', 7)).put('/admin/api/crisis/events/13/adjudication').send({ verdict: 'confirmed' })).status).toBe(200);
    expect(dbMocks.isAssigned).toHaveBeenCalledWith(7, 42);
    dbMocks.getOrganizationIdForUser.mockResolvedValue(2);
    expect((await request(appAs('researcher', 1, 1)).put('/admin/api/crisis/events/13/adjudication').send({ verdict: 'confirmed' })).status).toBe(404);
  });

  it('is denied to caseworkers (403) even when assigned', async () => {
    expect((await request(appAs('caseworker', 7)).put('/admin/api/crisis/events/12/adjudication').send({ verdict: 'confirmed' })).status).toBe(403);
  });
});

describe('GET /admin/api/crisis/events/:eventId/adjudications', () => {
  it('lists verdicts for an in-scope event and 404s otherwise', async () => {
    dbMocks.getCrisisEventAdjudications.mockResolvedValue([{ adjudication_id: 1, verdict: 'unclear' }] as never);
    const ok = await request(appAs('therapist', 7)).get('/admin/api/crisis/events/12/adjudications');
    expect(ok.status).toBe(200);
    expect(ok.body.adjudications).toHaveLength(1);
    dbMocks.isAssigned.mockResolvedValue(false);
    expect((await request(appAs('therapist', 7)).get('/admin/api/crisis/events/12/adjudications')).status).toBe(404);
  });
});
