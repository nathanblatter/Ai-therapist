// GET /admin/api/sessions/:sessionId/alliance-rating (ai-therapist-173):
// researcher-only, scoped to the caller's organisation through the session,
// read-only.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

const dbMocks = vi.hoisted(() => ({
  getLatestAllianceRating: vi.fn(),
  // Blind-rating state (eval program WP2).
  getRatingQueueRowForSession: vi.fn(),
  hasHumanRating: vi.fn(),
  // Transitive: caseload middleware + org scoping.
  getSessionAccessInfo: vi.fn(),
  isAssigned: vi.fn(async () => true),
  getOrganizationIdForUser: vi.fn(async () => 1),
  getIrbStudyOrgId: vi.fn(async () => 1),
}));
vi.mock('../../db/index.js', () => dbMocks);

const { default: evalsRoutes } = await import('./evals.routes.js');

function appAs(role: string, userId = 1, orgId = 1) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { session: Record<string, unknown> }).session = {
      userId,
      userRole: role,
      username: 'tester',
      orgId,
    };
    next();
  });
  app.use(evalsRoutes());
  return app;
}

const RATING = {
  rating_id: '9',
  session_id: 'sess_1',
  judge_version: 'alliance-v1',
  status: 'rated',
  task_rateable: true,
  task_level: 4,
  task_score: 4.2,
  goal_rateable: false,
  goal_score: null,
};
const URL_ = '/admin/api/sessions/sess_1/alliance-rating';

beforeEach(() => {
  dbMocks.getLatestAllianceRating.mockReset();
  dbMocks.getLatestAllianceRating.mockResolvedValue(RATING);
  dbMocks.getSessionAccessInfo.mockReset();
  dbMocks.getSessionAccessInfo.mockResolvedValue({ user_id: 42, status: 'ended', owner_organization_id: 1 });
  dbMocks.getRatingQueueRowForSession.mockReset();
  dbMocks.getRatingQueueRowForSession.mockResolvedValue(null);
  dbMocks.hasHumanRating.mockReset();
  dbMocks.hasHumanRating.mockResolvedValue(false);
});

describe('alliance rating read', () => {
  it('returns the stored rating to a researcher in the session owner organisation', async () => {
    const res = await request(appAs('researcher')).get(URL_);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ rating: RATING, blind: false });
    expect(dbMocks.getLatestAllianceRating).toHaveBeenCalledWith('sess_1');
  });

  it('withholds the rating while the caller still owes a blind human rating for the session', async () => {
    dbMocks.getRatingQueueRowForSession.mockResolvedValue({ queue_id: 3, session_id: 'sess_1', status: 'queued' });
    const res = await request(appAs('researcher')).get(URL_);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ rating: null, blind: true });
    expect(dbMocks.getLatestAllianceRating).not.toHaveBeenCalled();

    // Once their own rating is stored, it is shown.
    dbMocks.hasHumanRating.mockResolvedValue(true);
    expect((await request(appAs('researcher')).get(URL_)).body).toEqual({ rating: RATING, blind: false });
  });

  it('is 404 when the session has no rating', async () => {
    dbMocks.getLatestAllianceRating.mockResolvedValue(null);
    expect((await request(appAs('researcher')).get(URL_)).status).toBe(404);
  });

  it.each(['therapist', 'caseworker', 'participant'])('refuses the %s role', async (role) => {
    const res = await request(appAs(role)).get(URL_);
    expect(res.status).toBe(403);
    expect(dbMocks.getLatestAllianceRating).not.toHaveBeenCalled();
  });

  it('does not read a session owned by another organisation', async () => {
    dbMocks.getSessionAccessInfo.mockResolvedValue({ user_id: 42, status: 'ended', owner_organization_id: 2 });
    const res = await request(appAs('researcher')).get(URL_);
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(dbMocks.getLatestAllianceRating).not.toHaveBeenCalled();
  });

  it('has no write route', async () => {
    for (const method of ['post', 'put', 'delete'] as const) {
      expect((await request(appAs('researcher'))[method](URL_).send({})).status).toBe(404);
    }
    expect(dbMocks.getLatestAllianceRating).not.toHaveBeenCalled();
  });
});
