// Route tests for the Simulation Runs endpoints (ai-therapist-124 phase 3):
// role guards hold, list clamps its limit, detail 404s cleanly.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

vi.mock('../../config/db.js', () => ({
  pool: { query: vi.fn().mockResolvedValue({ rows: [] }), connect: vi.fn(), on: vi.fn() },
}));

const dbMocks = vi.hoisted(() => ({
  getSessionEval: vi.fn(),
  getSession: vi.fn(),
  getSessionHumanRatings: vi.fn(),
  upsertSessionHumanRating: vi.fn(),
  getCalibrationPromptVersions: vi.fn(),
  acknowledgeDriftAlert: vi.fn(),
  listHarnessRuns: vi.fn().mockResolvedValue([{ id: 7, suite: 'voice', pass_count: 1, scenario_count: 2 }]),
  getHarnessRun: vi.fn(),
}));
vi.mock('../../db/index.js', () => dbMocks);

import evalsRoutes from './evals.routes.js';

function appAs(role: string | null) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.session = role
      ? ({ userId: 1, userRole: role, username: 'tester' } as unknown as typeof req.session)
      : ({} as unknown as typeof req.session);
    next();
  });
  app.use(evalsRoutes());
  return app;
}

beforeEach(() => {
  dbMocks.listHarnessRuns.mockClear();
  dbMocks.getHarnessRun.mockReset();
});

describe('GET /admin/api/harness/runs', () => {
  it('is role-gated: anonymous gets 401', async () => {
    const res = await request(appAs(null)).get('/admin/api/harness/runs');
    expect(res.status).toBe(401);
  });

  it('participants are rejected', async () => {
    const res = await request(appAs('participant')).get('/admin/api/harness/runs');
    expect(res.status).toBe(403);
  });

  it('researchers get the run list, limit passed through', async () => {
    const res = await request(appAs('researcher')).get('/admin/api/harness/runs?limit=10');
    expect(res.status).toBe(200);
    expect(res.body.runs).toHaveLength(1);
    expect(dbMocks.listHarnessRuns).toHaveBeenCalledWith(10);
  });

  it('a bad limit falls back to the default 50', async () => {
    await request(appAs('therapist')).get('/admin/api/harness/runs?limit=abc');
    expect(dbMocks.listHarnessRuns).toHaveBeenCalledWith(50);
  });
});

describe('GET /admin/api/harness/runs/:runId', () => {
  it('rejects a non-numeric id with 400', async () => {
    const res = await request(appAs('researcher')).get('/admin/api/harness/runs/nope');
    expect(res.status).toBe(400);
  });

  it('404s on an unknown run', async () => {
    dbMocks.getHarnessRun.mockResolvedValueOnce(null);
    const res = await request(appAs('researcher')).get('/admin/api/harness/runs/99');
    expect(res.status).toBe(404);
  });

  it('returns run + results for a known run', async () => {
    dbMocks.getHarnessRun.mockResolvedValueOnce({ run: { id: 7 }, results: [{ scenario_id: 'a' }] });
    const res = await request(appAs('researcher')).get('/admin/api/harness/runs/7');
    expect(res.status).toBe(200);
    expect(res.body.run.id).toBe(7);
    expect(res.body.results).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Run-control endpoints (admin run-now / status / schedule)
// ---------------------------------------------------------------------------
const runnerMocks = vi.hoisted(() => ({
  startHarnessRun: vi.fn(),
  getRunnerStatus: vi.fn().mockReturnValue({ running: false, logTail: [] }),
  getHarnessSchedule: vi.fn().mockResolvedValue({ enabled: false, suite: 'voice', hour_utc: 9, variations: 1 }),
  setHarnessSchedule: vi.fn(),
}));
vi.mock('../../services/harnessRunner.service.js', () => runnerMocks);

describe('POST /admin/api/harness/run', () => {
  beforeEach(() => {
    runnerMocks.startHarnessRun.mockReset();
  });

  it('is researcher-only: therapists get 403', async () => {
    const res = await request(appAs('therapist')).post('/admin/api/harness/run').send({ suite: 'voice' });
    expect(res.status).toBe(403);
  });

  it('starts a run and echoes pid/suite', async () => {
    runnerMocks.startHarnessRun.mockResolvedValueOnce({ pid: 123, suite: 'voice' });
    const res = await request(appAs('researcher')).post('/admin/api/harness/run').send({ suite: 'voice', variations: 2 });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ started: true, pid: 123, suite: 'voice' });
    expect(runnerMocks.startHarnessRun).toHaveBeenCalledWith({ suite: 'voice', scenarioId: undefined, variations: 2, trigger: 'admin' });
  });

  it('409s when a run is already in progress', async () => {
    runnerMocks.startHarnessRun.mockRejectedValueOnce(new Error('a voice run is already in progress (pid 99)'));
    const res = await request(appAs('researcher')).post('/admin/api/harness/run').send({ suite: 'voice' });
    expect(res.status).toBe(409);
  });

  it('400s on an unknown suite', async () => {
    runnerMocks.startHarnessRun.mockRejectedValueOnce(new Error("unknown suite 'bogus'"));
    const res = await request(appAs('researcher')).post('/admin/api/harness/run').send({ suite: 'bogus' });
    expect(res.status).toBe(400);
  });
});

describe('GET /admin/api/harness/status + PUT schedule', () => {
  it('status includes runner state and the schedule', async () => {
    const res = await request(appAs('therapist')).get('/admin/api/harness/status');
    expect(res.status).toBe(200);
    expect(res.body.running).toBe(false);
    expect(res.body.schedule.suite).toBe('voice');
  });

  it('schedule saves are researcher-only and echo the normalized schedule', async () => {
    expect((await request(appAs('therapist')).put('/admin/api/harness/schedule').send({ enabled: true })).status).toBe(403);
    runnerMocks.setHarnessSchedule.mockResolvedValueOnce({ enabled: true, suite: 'quality', hour_utc: 8, variations: 2 });
    const res = await request(appAs('researcher')).put('/admin/api/harness/schedule').send({ enabled: true, suite: 'quality', hour_utc: 8, variations: 2 });
    expect(res.status).toBe(200);
    expect(res.body.schedule.enabled).toBe(true);
  });
});
