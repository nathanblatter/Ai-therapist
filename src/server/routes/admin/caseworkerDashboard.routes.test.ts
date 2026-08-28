// Triage roster API tests: attention ranking order + explainable reasons,
// 404-over-403 on the drill-down for unassigned clients, and the researcher
// org overview.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

const dbMocks = vi.hoisted(() => ({
  listCaseworkerRoster: vi.fn(),
  getRosterClientDetail: vi.fn(),
  countUnreadByClientForMember: vi.fn(),
  getSystemConfigByKey: vi.fn(),
  getAllUsers: vi.fn(),
  getUserById: vi.fn(),
  getOrganizationIdForUser: vi.fn(),
  getIrbStudyOrgId: vi.fn(),
  // Transitive imports of middleware/caseload.ts:
  isAssigned: vi.fn(),
  getSessionAccessInfo: vi.fn(),
  getMessageOwner: vi.fn(),
  getCareNoteById: vi.fn(),
  getEscalationById: vi.fn(),
}));
vi.mock('../../db/index.js', () => dbMocks);

import caseworkerDashboardRoutes, { computeAttention, DEFAULT_ATTENTION_RANKING } from './caseworkerDashboard.routes.js';

function appAs(role: string | null, userId = 8, orgId?: number) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { session: Record<string, unknown> }).session = role
      ? { userId, userRole: role, username: 'tester', ...(orgId !== undefined ? { orgId } : {}) }
      : {};
    next();
  });
  app.use(caseworkerDashboardRoutes());
  return app;
}

function rosterRow(overrides: Record<string, unknown> = {}) {
  return {
    client_id: 42, username: 'p42', assigned_at: '2026-08-01', member_role: 'caseworker',
    last_session_at: new Date(Date.now() - 2 * 24 * 3600 * 1000).toISOString(),
    ended_session_count: 5, last_checkin_mood: 7,
    last_summary: { headline: 'steady' }, last_summary_session_id: 's1',
    latest_risk_score: 20, latest_risk_severity: 'low', latest_risk_at: '2026-08-20',
    open_crisis_count: 0, latest_scales: null, open_escalation_count: 0,
    overdue_practice_count: 0, has_safety_plan: false,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  dbMocks.getSystemConfigByKey.mockResolvedValue(null);
  dbMocks.countUnreadByClientForMember.mockResolvedValue([]);
  dbMocks.listCaseworkerRoster.mockResolvedValue([rosterRow()]);
  dbMocks.getRosterClientDetail.mockResolvedValue({
    recent_summaries: [], scale_history: [], risk_history: [], mood_history: [], safety_plan: null,
  });
  dbMocks.isAssigned.mockResolvedValue(true);
  // orgIdFor contract: an authenticated caller's org always resolves (a
  // failed lookup throws -> 500), so give researchers a resolvable org.
  dbMocks.getOrganizationIdForUser.mockResolvedValue(1);
  dbMocks.getIrbStudyOrgId.mockResolvedValue(1);
});

describe('computeAttention', () => {
  it('scores an open crisis above everything and explains each reason', () => {
    const { score, reasons } = computeAttention(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      rosterRow({ open_crisis_count: 1, latest_risk_severity: 'high', open_escalation_count: 2 }) as any,
      3
    );
    const codes = reasons.map((r) => r.code);
    expect(codes).toEqual(expect.arrayContaining(['crisis_open', 'risk_high', 'escalation_open', 'unread_messages']));
    expect(score).toBe(
      DEFAULT_ATTENTION_RANKING.crisis_open + DEFAULT_ATTENTION_RANKING.risk_high +
      DEFAULT_ATTENTION_RANKING.escalation_open + DEFAULT_ATTENTION_RANKING.unread_messages
    );
    for (const reason of reasons) {
      expect(reason.label).toBeTruthy();
      expect(reason.points).toBeGreaterThan(0);
    }
  });

  it('flags inactivity only for clients with session history', () => {
    const idle = new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const withHistory = computeAttention(rosterRow({ last_session_at: idle }) as any, 0);
    expect(withHistory.reasons.map((r) => r.code)).toContain('inactive');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const brandNew = computeAttention(rosterRow({ last_session_at: null, ended_session_count: 0 }) as any, 0);
    expect(brandNew.reasons.map((r) => r.code)).not.toContain('inactive');
  });

  it('scores zero for a quiet client', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(computeAttention(rosterRow() as any, 0).score).toBe(0);
  });
});

describe('GET /admin/api/caseworker/roster', () => {
  it('returns the member roster ranked by attention score', async () => {
    dbMocks.listCaseworkerRoster.mockResolvedValue([
      rosterRow({ client_id: 1, username: 'calm' }),
      rosterRow({ client_id: 2, username: 'crisis', open_crisis_count: 1 }),
    ]);
    const res = await request(appAs('caseworker', 8)).get('/admin/api/caseworker/roster');
    expect(res.status).toBe(200);
    expect(dbMocks.listCaseworkerRoster).toHaveBeenCalledWith(8);
    expect(res.body.clients.map((c: { username: string }) => c.username)).toEqual(['crisis', 'calm']);
    expect(res.body.clients[0].attention.reasons[0].code).toBe('crisis_open');
  });

  it('merges unread message counts into the ranking', async () => {
    dbMocks.countUnreadByClientForMember.mockResolvedValue([{ client_id: 42, unread_count: 2 }]);
    const res = await request(appAs('therapist', 7)).get('/admin/api/caseworker/roster');
    expect(res.body.clients[0].unread_count).toBe(2);
    expect(res.body.clients[0].attention.reasons.map((r: { code: string }) => r.code)).toContain('unread_messages');
  });

  it('honors system_config attention_ranking overrides', async () => {
    dbMocks.getSystemConfigByKey.mockResolvedValue({
      config_key: 'attention_ranking', config_value: { unread_messages: 99 },
    });
    dbMocks.countUnreadByClientForMember.mockResolvedValue([{ client_id: 42, unread_count: 1 }]);
    const res = await request(appAs('caseworker', 8)).get('/admin/api/caseworker/roster');
    expect(res.body.clients[0].attention.score).toBe(99);
  });

  it('gives researchers a per-member org overview', async () => {
    dbMocks.getAllUsers.mockResolvedValue([
      { userid: 7, username: 't1', role: 'therapist' },
      { userid: 8, username: 'cw1', role: 'caseworker' },
      { userid: 42, username: 'p42', role: 'participant' },
    ]);
    const res = await request(appAs('researcher', 3, 1)).get('/admin/api/caseworker/roster');
    expect(res.status).toBe(200);
    expect(dbMocks.getAllUsers).toHaveBeenCalledWith(null, 1);
    expect(res.body.members).toHaveLength(2);
    expect(res.body.members[0]).toMatchObject({ member_id: 7, member_role: 'therapist' });
    expect(dbMocks.listCaseworkerRoster).toHaveBeenCalledWith(7);
    expect(dbMocks.listCaseworkerRoster).toHaveBeenCalledWith(8);
  });

  it('denies participants (403) and anonymous (401)', async () => {
    expect((await request(appAs('participant')).get('/admin/api/caseworker/roster')).status).toBe(403);
    expect((await request(appAs(null)).get('/admin/api/caseworker/roster')).status).toBe(401);
  });
});

describe('GET /admin/api/caseworker/roster/:userId/detail', () => {
  it('returns the summary-tier drill-down for an assigned client', async () => {
    const res = await request(appAs('caseworker', 8)).get('/admin/api/caseworker/roster/42/detail');
    expect(res.status).toBe(200);
    expect(res.body.client_id).toBe(42);
    expect(dbMocks.isAssigned).toHaveBeenCalledWith(8, 42);
    expect(dbMocks.getRosterClientDetail).toHaveBeenCalledWith(42);
  });

  it('404s (never 403) for a client outside the caseload', async () => {
    dbMocks.isAssigned.mockResolvedValue(false);
    const res = await request(appAs('caseworker', 8)).get('/admin/api/caseworker/roster/42/detail');
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('Not found');
    expect(dbMocks.getRosterClientDetail).not.toHaveBeenCalled();
  });

  it('lets researchers through without a caseload check', async () => {
    // Org always resolves under the orgIdFor contract, so the C13 same-org
    // target check runs: the client must live in the researcher's org.
    dbMocks.getUserById.mockResolvedValue({ userid: 42, role: 'participant', organization_id: 1 });
    const res = await request(appAs('researcher', 3)).get('/admin/api/caseworker/roster/42/detail');
    expect(res.status).toBe(200);
    expect(dbMocks.isAssigned).not.toHaveBeenCalled();
  });

  it('404s a researcher reading a client outside their org (C13)', async () => {
    dbMocks.getUserById.mockResolvedValue({ userid: 42, role: 'participant', organization_id: 9 });
    const res = await request(appAs('researcher', 3, 1)).get('/admin/api/caseworker/roster/42/detail');
    expect(res.status).toBe(404);
    expect(dbMocks.getRosterClientDetail).not.toHaveBeenCalled();
  });

  it('lets a researcher read a same-org client', async () => {
    dbMocks.getUserById.mockResolvedValue({ userid: 42, role: 'participant', organization_id: 1 });
    const res = await request(appAs('researcher', 3, 1)).get('/admin/api/caseworker/roster/42/detail');
    expect(res.status).toBe(200);
  });

  it('400s on a non-numeric client id', async () => {
    expect((await request(appAs('caseworker', 8)).get('/admin/api/caseworker/roster/abc/detail')).status).toBe(400);
  });
});
