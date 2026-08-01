import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

// Mock the DB pool (db/index.js pulls in every query module at import time).
vi.mock('../../config/db.js', () => ({
  pool: { query: vi.fn().mockResolvedValue({ rows: [] }), connect: vi.fn(), on: vi.fn() },
}));

// Mock the export service so the route never builds a real dataset.
const { buildDatasetMock, streamMock } = vi.hoisted(() => ({
  buildDatasetMock: vi.fn().mockResolvedValue({ asOf: '2026-08-31T23:59:59Z', main: [], transcripts: null }),
  streamMock: vi.fn(),
}));
vi.mock('../../services/datasetExport.service.js', () => ({
  buildDataset: buildDatasetMock,
  streamDatasetZip: (_r: unknown, res: { end: () => void }) => { streamMock(); res.end(); return Promise.resolve(); },
}));

import exportRoutes from './export.routes.js';

function appAs(role: string | null) {
  const app = express();
  app.use((req, _res, next) => {
    req.session = role
      ? ({ userId: 1, userRole: role, username: 'tester' } as unknown as typeof req.session)
      : ({} as unknown as typeof req.session);
    next();
  });
  app.use(exportRoutes());
  return app;
}

beforeEach(() => {
  buildDatasetMock.mockClear();
  streamMock.mockClear();
});

describe('GET /admin/api/export/dataset role guard', () => {
  it('allows a researcher (200, streams a zip)', async () => {
    const res = await request(appAs('researcher')).get('/admin/api/export/dataset');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('zip');
    expect(buildDatasetMock).toHaveBeenCalled();
  });

  it('forbids a therapist (403) — de-identified dataset is researcher-only', async () => {
    const res = await request(appAs('therapist')).get('/admin/api/export/dataset');
    expect(res.status).toBe(403);
    expect(buildDatasetMock).not.toHaveBeenCalled();
  });

  it('rejects an unauthenticated request (401)', async () => {
    const res = await request(appAs(null)).get('/admin/api/export/dataset');
    expect(res.status).toBe(401);
  });

  it('validates asOf', async () => {
    const res = await request(appAs('researcher')).get('/admin/api/export/dataset?asOf=not-a-date');
    expect(res.status).toBe(400);
  });

  it('passes includeTranscripts through to the builder', async () => {
    await request(appAs('researcher')).get('/admin/api/export/dataset?includeTranscripts=true');
    expect(buildDatasetMock).toHaveBeenCalledWith(expect.any(String), { includeTranscripts: true });
  });
});
