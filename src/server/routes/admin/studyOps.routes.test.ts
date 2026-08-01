import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

vi.mock('../../config/db.js', () => ({
  pool: { query: vi.fn().mockResolvedValue({ rows: [] }), connect: vi.fn(), on: vi.fn() },
}));

const mocks = vi.hoisted(() => ({
  getStudyOpsSummary: vi.fn().mockResolvedValue({ enrollment: {}, arm_balance: {}, sessions_per_participant: {}, conditions: [], deviations: {} }),
  listDeviations: vi.fn().mockResolvedValue([]),
  createDeviation: vi.fn().mockResolvedValue({ deviation_id: 1 }),
  updateDeviation: vi.fn().mockResolvedValue({ deviation_id: 1 }),
  deleteDeviation: vi.fn().mockResolvedValue(true),
  scanForDeviations: vi.fn().mockResolvedValue({ inserted: 0 }),
}));
vi.mock('../../db/index.js', () => mocks);
vi.mock('../../db/config.queries.js', () => ({
  updateSystemConfig: vi.fn().mockResolvedValue({ config_value: {} }),
}));

import studyOpsRoutes from './studyOps.routes.js';

function appAs(role: string | null) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.session = role
      ? ({ userId: 1, userRole: role, username: 'tester' } as unknown as typeof req.session)
      : ({} as unknown as typeof req.session);
    next();
  });
  app.use(studyOpsRoutes());
  return app;
}

beforeEach(() => Object.values(mocks).forEach(m => m.mockClear()));

describe('study-ops role guards', () => {
  it('summary is readable by therapist and researcher, not participant', async () => {
    expect((await request(appAs('researcher')).get('/admin/api/study-ops/summary')).status).toBe(200);
    expect((await request(appAs('therapist')).get('/admin/api/study-ops/summary')).status).toBe(200);
    expect((await request(appAs('participant')).get('/admin/api/study-ops/summary')).status).toBe(403);
  });

  it('deviations list is researcher-only (therapist 403)', async () => {
    expect((await request(appAs('researcher')).get('/admin/api/study-ops/deviations')).status).toBe(200);
    expect((await request(appAs('therapist')).get('/admin/api/study-ops/deviations')).status).toBe(403);
  });

  it('scan + protocol writes are researcher-only', async () => {
    expect((await request(appAs('therapist')).post('/admin/api/study-ops/scan')).status).toBe(403);
    expect((await request(appAs('researcher')).post('/admin/api/study-ops/scan')).status).toBe(200);
  });
});

describe('deviation validation', () => {
  it('rejects an auto-only category on manual create', async () => {
    const res = await request(appAs('researcher')).post('/admin/api/study-ops/deviations')
      .send({ category: 'arm_imbalance', description: 'x' });
    expect(res.status).toBe(400);
    expect(mocks.createDeviation).not.toHaveBeenCalled();
  });

  it('accepts a valid manual deviation', async () => {
    const res = await request(appAs('researcher')).post('/admin/api/study-ops/deviations')
      .send({ category: 'procedure', severity: 'minor', description: 'consent form typo' });
    expect(res.status).toBe(201);
    expect(mocks.createDeviation).toHaveBeenCalled();
  });

  it('requires a description', async () => {
    const res = await request(appAs('researcher')).post('/admin/api/study-ops/deviations')
      .send({ category: 'procedure', description: '   ' });
    expect(res.status).toBe(400);
  });

  it('404s when deleting a non-manual / missing row', async () => {
    mocks.deleteDeviation.mockResolvedValueOnce(false);
    const res = await request(appAs('researcher')).delete('/admin/api/study-ops/deviations/9');
    expect(res.status).toBe(404);
  });

  it('validates protocol numeric bounds', async () => {
    const res = await request(appAs('researcher')).put('/admin/api/study-ops/protocol')
      .send({ enrollment_target: 40, expected_sessions_per_participant: 4, arm_imbalance_threshold: 2 });
    expect(res.status).toBe(400);
  });
});
