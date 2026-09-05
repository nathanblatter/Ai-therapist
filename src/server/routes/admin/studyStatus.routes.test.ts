// Admin study-status route contract: researcher-only role guard, validation,
// 404 on missing user, and the 'admin:<username>' source stamp (migration 087)
// that gives paused participants a path back to 'active'.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

vi.mock('../../config/db.js', () => ({
  pool: { query: vi.fn().mockResolvedValue({ rows: [] }), connect: vi.fn(), on: vi.fn() },
}));

const mocks = vi.hoisted(() => ({
  getUserById: vi.fn(),
  getStudyStatusDetail: vi.fn(),
  setStudyStatus: vi.fn(),
}));
vi.mock('../../db/index.js', () => mocks);

import studyStatusRoutes from './studyStatus.routes.js';

function appAs(role: string | null) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.session = role
      ? ({ userId: 1, userRole: role, username: 'coordinator' } as unknown as typeof req.session)
      : ({} as unknown as typeof req.session);
    next();
  });
  app.use(studyStatusRoutes());
  return app;
}

beforeEach(() => {
  Object.values(mocks).forEach((m) => m.mockReset());
  mocks.getUserById.mockResolvedValue({ userid: 42, username: 'p42', role: 'participant' });
  mocks.getStudyStatusDetail.mockResolvedValue({
    study_status: 'paused',
    study_status_changed_at: '2026-09-01T00:00:00Z',
    study_status_source: 'qualtrics:R_1',
  });
  mocks.setStudyStatus.mockResolvedValue(true);
});

describe('role guards', () => {
  it('GET and POST are researcher-only', async () => {
    expect((await request(appAs('researcher')).get('/admin/api/users/42/study-status')).status).toBe(200);
    expect((await request(appAs('therapist')).get('/admin/api/users/42/study-status')).status).toBe(403);
    expect((await request(appAs('therapist')).post('/admin/api/users/42/study-status').send({ status: 'active' })).status).toBe(403);
    expect((await request(appAs('participant')).post('/admin/api/users/42/study-status').send({ status: 'active' })).status).toBe(403);
    expect((await request(appAs(null)).post('/admin/api/users/42/study-status').send({ status: 'active' })).status).toBe(401);
    expect(mocks.setStudyStatus).not.toHaveBeenCalled();
  });
});

describe('GET /admin/api/users/:userId/study-status', () => {
  it('returns status + provenance', async () => {
    const res = await request(appAs('researcher')).get('/admin/api/users/42/study-status');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      study_status: 'paused',
      study_status_changed_at: '2026-09-01T00:00:00Z',
      study_status_source: 'qualtrics:R_1',
    });
  });

  it('404s on a missing user', async () => {
    mocks.getStudyStatusDetail.mockResolvedValue(null);
    expect((await request(appAs('researcher')).get('/admin/api/users/999/study-status')).status).toBe(404);
  });

  it('400s on a non-numeric user id', async () => {
    expect((await request(appAs('researcher')).get('/admin/api/users/abc/study-status')).status).toBe(400);
  });
});

describe('POST /admin/api/users/:userId/study-status', () => {
  it('reactivates a paused participant with source admin:<username>', async () => {
    const res = await request(appAs('researcher'))
      .post('/admin/api/users/42/study-status')
      .send({ status: 'active' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, study_status: 'active', changed: true });
    expect(mocks.setStudyStatus).toHaveBeenCalledWith(42, 'active', 'admin:coordinator');
  });

  it('accepts paused and withdrawn too', async () => {
    for (const status of ['paused', 'withdrawn']) {
      const res = await request(appAs('researcher'))
        .post('/admin/api/users/42/study-status')
        .send({ status });
      expect(res.status).toBe(200);
      expect(mocks.setStudyStatus).toHaveBeenCalledWith(42, status, 'admin:coordinator');
    }
  });

  it('rejects an invalid status without touching the row', async () => {
    const res = await request(appAs('researcher'))
      .post('/admin/api/users/42/study-status')
      .send({ status: 'gone' });
    expect(res.status).toBe(400);
    expect(mocks.setStudyStatus).not.toHaveBeenCalled();
  });

  it('404s when the user does not exist', async () => {
    mocks.getUserById.mockResolvedValue(null);
    const res = await request(appAs('researcher'))
      .post('/admin/api/users/999/study-status')
      .send({ status: 'active' });
    expect(res.status).toBe(404);
    expect(mocks.setStudyStatus).not.toHaveBeenCalled();
  });

  it('reports changed:false on a same-status no-op', async () => {
    mocks.setStudyStatus.mockResolvedValue(false);
    const res = await request(appAs('researcher'))
      .post('/admin/api/users/42/study-status')
      .send({ status: 'paused' });
    expect(res.status).toBe(200);
    expect(res.body.changed).toBe(false);
  });
});
