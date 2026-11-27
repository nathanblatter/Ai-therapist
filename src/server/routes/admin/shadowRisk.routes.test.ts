// Shadow scorer report route: role matrix, sandbox 404, organisation scope
// through orgIdFor (never a query-supplied one), window validation, and the
// absence of any data_access_log write.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

const mocks = vi.hoisted(() => ({
  logDataAccess: vi.fn().mockResolvedValue(undefined),
  getOrganizationIdForUser: vi.fn().mockResolvedValue(1),
  getIrbStudyOrgId: vi.fn().mockResolvedValue(1),
  getSystemConfigByKey: vi.fn(),
  getShadowRiskReport: vi.fn(),
}));
vi.mock('../../db/index.js', () => ({
  logDataAccess: mocks.logDataAccess,
  getOrganizationIdForUser: mocks.getOrganizationIdForUser,
  getIrbStudyOrgId: mocks.getIrbStudyOrgId,
  getSystemConfigByKey: mocks.getSystemConfigByKey,
}));
vi.mock('../../db/shadowRisk.queries.js', () => ({ getShadowRiskReport: mocks.getShadowRiskReport }));

import shadowRiskRoutes from './shadowRisk.routes.js';

const PATH = '/admin/api/shadow-risk/report';

function appAs(session: Record<string, unknown> | null) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { session: Record<string, unknown> }).session = session ? { ...session } : {};
    next();
  });
  app.use(shadowRiskRoutes());
  return app;
}
const researcher = (orgId = 1) => ({ userId: 9, userRole: 'researcher', username: 'res1', orgId });

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getOrganizationIdForUser.mockResolvedValue(1);
  mocks.getIrbStudyOrgId.mockResolvedValue(1);
  mocks.getSystemConfigByKey.mockResolvedValue(null);
  mocks.getShadowRiskReport.mockImplementation(async (w: { from: string; to: string }) => ({
    window: { from: w.from, to: w.to },
    counts: { total: 0, scored: 0, errored: 0 },
    agreement: {},
    disagreements: [],
    disagreements_truncated: false,
  }));
});

describe('GET /admin/api/shadow-risk/report', () => {
  it('401 anonymous, 403 other roles, 404 sandbox, 200 researcher', async () => {
    expect((await request(appAs(null)).get(PATH)).status).toBe(401);
    for (const role of ['participant', 'therapist', 'caseworker', 'demo']) {
      expect((await request(appAs({ userId: 2, userRole: role, username: 'u', orgId: 1 })).get(PATH)).status).toBe(403);
    }
    expect((await request(appAs({ ...researcher(), isSandbox: true })).get(PATH)).status).toBe(404);
    expect(mocks.getShadowRiskReport).not.toHaveBeenCalled();
    expect((await request(appAs(researcher())).get(PATH)).status).toBe(200);
  });

  it('scopes to the session organisation, never a query-supplied one', async () => {
    const res = await request(appAs(researcher(5))).get(`${PATH}?orgId=1&organization_id=1`);
    expect(res.status).toBe(200);
    expect(mocks.getShadowRiskReport).toHaveBeenCalledTimes(1);
    expect(mocks.getShadowRiskReport.mock.calls[0][0]).toMatchObject({ orgId: 5, includeUnattributed: false });
  });

  it('includes unattributed sessions only for the irb-study organisation', async () => {
    await request(appAs(researcher(1))).get(PATH);
    expect(mocks.getShadowRiskReport.mock.calls[0][0]).toMatchObject({ orgId: 1, includeUnattributed: true });
    mocks.getIrbStudyOrgId.mockResolvedValue(null);
    await request(appAs(researcher(1))).get(PATH);
    expect(mocks.getShadowRiskReport.mock.calls[1][0]).toMatchObject({ orgId: 1, includeUnattributed: false });
  });

  it('defaults to 30 days and validates the window', async () => {
    const res = await request(appAs(researcher())).get(PATH);
    expect(res.body.days).toBe(30);
    const w = mocks.getShadowRiskReport.mock.calls[0][0] as { from: string; to: string };
    expect(new Date(w.to).getTime() - new Date(w.from).getTime()).toBe(30 * 24 * 60 * 60 * 1000);
    for (const bad of ['0', '-1', '366', '1.5', 'abc']) {
      expect((await request(appAs(researcher())).get(`${PATH}?days=${bad}`)).status).toBe(400);
    }
    expect((await request(appAs(researcher())).get(`${PATH}?days=7`)).body.days).toBe(7);
  });

  it('reports the switch as off unless the config row says a literal true', async () => {
    expect((await request(appAs(researcher())).get(PATH)).body).toMatchObject({
      enabled: false,
      model: 'gpt-6-luna',
      question_set_version: 1,
    });
    mocks.getSystemConfigByKey.mockResolvedValue({ config_value: { enabled: 'yes' } });
    expect((await request(appAs(researcher())).get(PATH)).body.enabled).toBe(false);
    mocks.getSystemConfigByKey.mockResolvedValue({ config_value: { enabled: true } });
    expect((await request(appAs(researcher())).get(PATH)).body.enabled).toBe(true);
    expect(mocks.getSystemConfigByKey).toHaveBeenCalledWith('shadow_risk_scorer');
  });

  it('writes no data_access_log row and answers 500 without detail when the read fails', async () => {
    await request(appAs(researcher())).get(PATH);
    expect(mocks.logDataAccess).not.toHaveBeenCalled();
    mocks.getShadowRiskReport.mockRejectedValue(new Error('relation does not exist'));
    const res = await request(appAs(researcher())).get(PATH);
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'Failed to build the shadow scorer report' });
  });
});
