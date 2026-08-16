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
