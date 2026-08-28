// Caseload gating on the raw data export (docs/caseload-rbac.md): bulk export
// is researcher-only; a therapist must name a single assigned session.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

const mocks = vi.hoisted(() => ({
  getFullExport: vi.fn(),
  getMetadataExport: vi.fn(),
  getAnonymizedExport: vi.fn(),
  getAggregateExport: vi.fn(),
  isAssigned: vi.fn(),
  getSessionAccessInfo: vi.fn(),
  // orgIdFor contract (middleware/org.ts): researcher org must resolve, else
  // the route fails closed with a 500.
  getOrganizationIdForUser: vi.fn().mockResolvedValue(1),
  getIrbStudyOrgId: vi.fn().mockResolvedValue(1),
}));

vi.mock('../../db/index.js', () => mocks);

import exportRoutes from './export.routes.js';

function appAs(role: string, userId = 1) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { session: Record<string, unknown> }).session = {
      userId,
      userRole: role,
      username: 'tester',
    };
    next();
  });
  app.use(exportRoutes());
  return app;
}

describe('GET /admin/api/export caseload gating', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getFullExport.mockResolvedValue([]);
    mocks.getMetadataExport.mockResolvedValue([]);
  });

  it('lets a researcher bulk-export without a sessionId', async () => {
    const res = await request(appAs('researcher')).get('/admin/api/export');
    expect(res.status).toBe(200);
    expect(mocks.getSessionAccessInfo).not.toHaveBeenCalled();
  });

  it('403s a therapist bulk export (no sessionId)', async () => {
    const res = await request(appAs('therapist')).get('/admin/api/export');
    expect(res.status).toBe(403);
    expect(mocks.getFullExport).not.toHaveBeenCalled();
  });

  it('404s a therapist exporting an unassigned session', async () => {
    mocks.getSessionAccessInfo.mockResolvedValue({ user_id: 7 });
    mocks.isAssigned.mockResolvedValue(false);
    const res = await request(appAs('therapist')).get('/admin/api/export?sessionId=s1');
    expect(res.status).toBe(404);
    expect(mocks.getFullExport).not.toHaveBeenCalled();
  });

  it('404s a therapist when the session is missing or ownerless', async () => {
    mocks.getSessionAccessInfo.mockResolvedValue(null);
    expect((await request(appAs('therapist')).get('/admin/api/export?sessionId=s1')).status).toBe(404);
    mocks.getSessionAccessInfo.mockResolvedValue({ user_id: null });
    expect((await request(appAs('therapist')).get('/admin/api/export?sessionId=s2')).status).toBe(404);
    expect(mocks.getFullExport).not.toHaveBeenCalled();
  });

  it('allows a therapist to export an assigned session', async () => {
    mocks.getSessionAccessInfo.mockResolvedValue({ user_id: 7 });
    mocks.isAssigned.mockResolvedValue(true);
    const res = await request(appAs('therapist')).get('/admin/api/export?sessionId=s1');
    expect(res.status).toBe(200);
    expect(mocks.isAssigned).toHaveBeenCalledWith(1, 7);
    expect(mocks.getFullExport).toHaveBeenCalled();
  });
});
