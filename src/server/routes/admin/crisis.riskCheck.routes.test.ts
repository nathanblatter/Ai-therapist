// Admin read surface for the structured risk ladder (ai-therapist-198).
// The ladder's `answer` column is a participant's verbatim reply to a suicide
// assessment question — the single most sensitive free text in the crisis
// surface — so the caseworker (summary-tier) scrub is the load-bearing test
// here, alongside role and ownership enforcement.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

const dbMocks = vi.hoisted(() => ({
  getSessionRiskCheckLadder: vi.fn(),
  getParticipantRiskCheckLadders: vi.fn(),
  sessionExists: vi.fn(async () => true),
  getSessionCrisisFlag: vi.fn(),
  getAllCrisisData: vi.fn(),
  getAllCrisisEvents: vi.fn(),
  getCaseloadClientIds: vi.fn(async () => [42]),
  // Transitive: caseload middleware + org scoping.
  getSessionAccessInfo: vi.fn(async () => ({ user_id: 42, status: 'ended' })),
  isAssigned: vi.fn(async () => true),
  getMessageOwner: vi.fn(),
  getCareNoteById: vi.fn(),
  getEscalationById: vi.fn(),
  getOrganizationIdForUser: vi.fn(async () => 1),
  getIrbStudyOrgId: vi.fn(async () => 1),
  getTherapistIdsForClient: vi.fn(async () => []),
  getCaseworkerIdsForClient: vi.fn(async () => []),
}));
vi.mock('../../db/index.js', () => dbMocks);

const { default: crisisRoutes } = await import('./crisis.routes.js');

function appAs(role: string, userId = 1) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { session: Record<string, unknown> }).session = {
      userId, userRole: role, username: 'tester',
    };
    next();
  });
  app.use(crisisRoutes());
  return app;
}

const LADDER = {
  session_id: 'sess_1',
  steps: [
    {
      check_step_id: 1, session_id: 'sess_1', crisis_event_id: 9, step: 'ideation',
      answer: 'yes, most nights', risk_band: 'moderate', sequence: 1,
      created_at: '2026-09-20T10:00:00.000Z',
    },
    {
      check_step_id: 2, session_id: 'sess_1', crisis_event_id: 9, step: 'plan',
      answer: 'no plan', risk_band: 'low', sequence: 2,
      created_at: '2026-09-20T10:02:00.000Z',
    },
  ],
  resolved_band: 'moderate',
  furthest_step: 'plan',
  completed: false,
  started_at: '2026-09-20T10:00:00.000Z',
  last_step_at: '2026-09-20T10:02:00.000Z',
};

beforeEach(() => {
  vi.clearAllMocks();
  dbMocks.getSessionRiskCheckLadder.mockResolvedValue(LADDER);
  dbMocks.getParticipantRiskCheckLadders.mockResolvedValue([LADDER]);
  dbMocks.getSessionAccessInfo.mockResolvedValue({ user_id: 42, status: 'ended' });
  dbMocks.getCaseloadClientIds.mockResolvedValue([42]);
  dbMocks.isAssigned.mockResolvedValue(true);
});

describe('GET /admin/api/sessions/:sessionId/risk-check', () => {
  it('returns the full ladder, answers included, for a therapist', async () => {
    const res = await request(appAs('therapist')).get('/admin/api/sessions/sess_1/risk-check');
    expect(res.status).toBe(200);
    expect(res.body.ladder.resolved_band).toBe('moderate');
    expect(res.body.ladder.steps[0].answer).toBe('yes, most nights');
    expect(dbMocks.getSessionRiskCheckLadder).toHaveBeenCalledWith('sess_1');
  });

  it('strips every answer for a summary-tier caseworker but keeps rungs and bands', async () => {
    const res = await request(appAs('caseworker', 1)).get('/admin/api/sessions/sess_1/risk-check');
    expect(res.status).toBe(200);
    expect(JSON.stringify(res.body)).not.toContain('most nights');
    for (const step of res.body.ladder.steps) {
      expect(step).not.toHaveProperty('answer');
      expect(step).toHaveProperty('risk_band');
      expect(step).toHaveProperty('step');
    }
    // The clinically useful summary still survives the scrub.
    expect(res.body.ladder.resolved_band).toBe('moderate');
    expect(res.body.ladder.furthest_step).toBe('plan');
  });

  it('404s (not 403) for a care-team member the session is not assigned to', async () => {
    dbMocks.isAssigned.mockResolvedValue(false);
    const res = await request(appAs('therapist', 5)).get('/admin/api/sessions/sess_1/risk-check');
    expect(res.status).toBe(404);
    expect(dbMocks.getSessionRiskCheckLadder).not.toHaveBeenCalled();
  });

  it('is denied to roles outside the crisis surface', async () => {
    const res = await request(appAs('participant', 42)).get('/admin/api/sessions/sess_1/risk-check');
    expect(res.status).toBe(403);
    expect(dbMocks.getSessionRiskCheckLadder).not.toHaveBeenCalled();
  });

  it('returns 500 rather than a partial payload when the read fails', async () => {
    dbMocks.getSessionRiskCheckLadder.mockRejectedValue(new Error('db down'));
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await request(appAs('researcher')).get('/admin/api/sessions/sess_1/risk-check');
    expect(res.status).toBe(500);
    spy.mockRestore();
  });
});

describe('GET /admin/api/users/:userId/risk-checks', () => {
  it('returns every ladder for the participant', async () => {
    const res = await request(appAs('researcher')).get('/admin/api/users/42/risk-checks');
    expect(res.status).toBe(200);
    expect(res.body.ladders).toHaveLength(1);
    expect(dbMocks.getParticipantRiskCheckLadders).toHaveBeenCalledWith(42);
  });

  it('scrubs answers for a caseworker', async () => {
    const res = await request(appAs('caseworker', 1)).get('/admin/api/users/42/risk-checks');
    expect(res.status).toBe(200);
    expect(JSON.stringify(res.body)).not.toContain('most nights');
  });

  it('rejects a non-numeric user id before touching the database', async () => {
    const res = await request(appAs('researcher')).get('/admin/api/users/abc/risk-checks');
    expect(res.status).toBe(400);
    expect(dbMocks.getParticipantRiskCheckLadders).not.toHaveBeenCalled();
  });
});
