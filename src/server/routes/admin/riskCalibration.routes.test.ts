// Risk calibration routes (eval spec WP3): role matrix, sandbox 404, org
// scoping through orgIdFor (list, get, start), parameter validation, the
// one-run-at-a-time guard, and the absence of any data_access_log write.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

const mocks = vi.hoisted(() => ({
  logDataAccess: vi.fn().mockResolvedValue(undefined),
  getOrganizationIdForUser: vi.fn().mockResolvedValue(1),
  getIrbStudyOrgId: vi.fn().mockResolvedValue(1),
  listRiskCalibrationRuns: vi.fn(),
  getRiskCalibrationRun: vi.fn(),
  runAndStoreRiskCalibration: vi.fn(),
}));
vi.mock('../../db/index.js', () => ({
  logDataAccess: mocks.logDataAccess,
  getOrganizationIdForUser: mocks.getOrganizationIdForUser,
  getIrbStudyOrgId: mocks.getIrbStudyOrgId,
  listRiskCalibrationRuns: mocks.listRiskCalibrationRuns,
  getRiskCalibrationRun: mocks.getRiskCalibrationRun,
}));
vi.mock('../../services/riskCalibration.service.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../services/riskCalibration.service.js')>();
  return { ...real, runAndStoreRiskCalibration: mocks.runAndStoreRiskCalibration };
});

import riskCalibrationRoutes from './riskCalibration.routes.js';

const run = (id: number, orgId: number) => ({
  run_id: id, org_id: orgId, started_at: new Date('2026-10-23T06:00:00Z'), finished_at: new Date('2026-10-23T06:00:10Z'),
  params: { sample_size: 50 }, report: { labels: { insufficient_labels: true, scored_messages: 558, positives: 0, negatives: 555 }, advisory: true },
  recommended_thresholds: { advisory: true }, created_by: 'res1',
});

function appAs(session: Record<string, unknown> | null, router = riskCalibrationRoutes()) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { session: Record<string, unknown> }).session = session ? { ...session } : {};
    next();
  });
  app.use(router);
  return app;
}
const researcher = (orgId = 1) => ({ userId: 9, userRole: 'researcher', username: 'res1', orgId });

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getOrganizationIdForUser.mockResolvedValue(1);
  mocks.getIrbStudyOrgId.mockResolvedValue(1);
  mocks.listRiskCalibrationRuns.mockImplementation(async (orgId: number) => [run(1, orgId)]);
  mocks.getRiskCalibrationRun.mockImplementation(async (id: number, orgId: number) => (id === 1 && orgId === 1 ? run(1, 1) : null));
  mocks.runAndStoreRiskCalibration.mockImplementation(async (i: { orgId: number }) => run(2, i.orgId));
});

describe('role matrix', () => {
  const calls: Array<[string, string, number]> = [
    ['get', '/admin/api/risk-calibration/runs', 200],
    ['get', '/admin/api/risk-calibration/runs/1', 200],
    ['post', '/admin/api/risk-calibration/runs', 201],
  ];
  for (const [method, path, ok] of calls) {
    it(`${method.toUpperCase()} ${path}: 401 anonymous, 403 other roles, 404 sandbox, ${ok} researcher`, async () => {
      const send = (session: Record<string, unknown> | null) => {
        const r = request(appAs(session));
        return method === 'get' ? r.get(path) : r.post(path).send({});
      };
      expect((await send(null)).status).toBe(401);
      for (const role of ['participant', 'therapist', 'caseworker', 'demo']) {
        expect((await send({ userId: 2, userRole: role, username: 'u', orgId: 1 })).status).toBe(403);
      }
      expect((await send({ ...researcher(), isSandbox: true })).status).toBe(404);
      expect(mocks.runAndStoreRiskCalibration).not.toHaveBeenCalled();
      expect((await send(researcher())).status).toBe(ok);
    });
  }
});

describe('org scope', () => {
  it('lists only the session org, never a query-supplied one, with bands and defaults', async () => {
    const res = await request(appAs(researcher(5))).get('/admin/api/risk-calibration/runs?orgId=1');
    expect(res.status).toBe(200);
    expect(mocks.listRiskCalibrationRuns).toHaveBeenCalledWith(5, 20);
    expect(res.body.runs[0].org_id).toBe(5);
    expect(res.body.current_bands).toEqual({ low: 25, medium: 50, high: 75 });
    expect(res.body.defaults).toEqual({ sample_size: 50, max_sample_size: 500, budget_usd: 0.5 });
  });

  it("reads another org's run as 404 and a bad id as 400", async () => {
    expect((await request(appAs(researcher(5))).get('/admin/api/risk-calibration/runs/1')).status).toBe(404);
    expect(mocks.getRiskCalibrationRun).toHaveBeenCalledWith(1, 5);
    expect((await request(appAs(researcher(1))).get('/admin/api/risk-calibration/runs/abc')).status).toBe(400);
    const ok = await request(appAs(researcher(1))).get('/admin/api/risk-calibration/runs/1');
    expect(ok.status).toBe(200);
    expect(ok.body.run.report.labels.insufficient_labels).toBe(true);
  });

  it('starts a run for the session org with the caller as creator, normalised params, and never logs data access', async () => {
    const res = await request(appAs(researcher(5))).post('/admin/api/risk-calibration/runs')
      .send({ sample_size: '10', since: '2026-01-01', dry_run: true, orgId: 1, budget_usd: 50 });
    expect(res.status).toBe(201);
    const call = mocks.runAndStoreRiskCalibration.mock.calls[0][0];
    expect(call.orgId).toBe(5);
    expect(call.createdBy).toBe('res1');
    expect(call.params).toMatchObject({ sample_size: 10, since: '2026-01-01T00:00:00.000Z', dry_run: true, unflagged_as_negative: true, budget_usd: 0.5 });
    expect(res.body.run.org_id).toBe(5);
    expect(mocks.logDataAccess).not.toHaveBeenCalled();
  });

  it('rejects invalid parameters with 400 before touching the service', async () => {
    const bad = await request(appAs(researcher())).post('/admin/api/risk-calibration/runs').send({ sample_size: 9999 });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toMatch(/sample_size/);
    const badWindow = await request(appAs(researcher())).post('/admin/api/risk-calibration/runs').send({ since: '2026-12-01', until: '2026-01-01' });
    expect(badWindow.status).toBe(400);
    expect(mocks.runAndStoreRiskCalibration).not.toHaveBeenCalled();
  });

  it('refuses a second concurrent run with 409', async () => {
    let release: () => void = () => {};
    mocks.runAndStoreRiskCalibration.mockImplementationOnce(() => new Promise(resolve => { release = () => resolve(run(3, 1)); }));
    const router = riskCalibrationRoutes();
    // supertest is lazy: .then() is what actually sends the first request.
    const first = request(appAs(researcher(), router)).post('/admin/api/risk-calibration/runs').send({}).then(r => r);
    await new Promise(r => setTimeout(r, 50));
    const second = await request(appAs(researcher(), router)).post('/admin/api/risk-calibration/runs').send({});
    expect(second.status).toBe(409);
    release();
    expect((await first).status).toBe(201);
    expect(mocks.runAndStoreRiskCalibration).toHaveBeenCalledTimes(1);
  });

  it('500s (never widens) when org resolution fails', async () => {
    mocks.getOrganizationIdForUser.mockRejectedValueOnce(new Error('db down'));
    const res = await request(appAs({ userId: 9, userRole: 'researcher', username: 'res1' })).get('/admin/api/risk-calibration/runs');
    expect(res.status).toBe(500);
    expect(mocks.listRiskCalibrationRuns).not.toHaveBeenCalled();
  });
});
