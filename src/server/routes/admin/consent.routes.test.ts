// Route coverage for admin consent-version publishing (ai-therapist-94):
// publish happy path, duplicate 409, role 403, and cache invalidation.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

const {
  listConsentDocumentsMock,
  getConsentDocumentByVersionMock,
  insertConsentDocumentMock,
  getActiveConsentDocumentMock,
  getActiveConsentMock,
  invalidateConsentCacheMock,
} = vi.hoisted(() => ({
  listConsentDocumentsMock: vi.fn(),
  getConsentDocumentByVersionMock: vi.fn(),
  insertConsentDocumentMock: vi.fn(),
  getActiveConsentDocumentMock: vi.fn(),
  getActiveConsentMock: vi.fn(),
  invalidateConsentCacheMock: vi.fn(),
}));

vi.mock('../../db/index.js', () => ({
  listConsentDocuments: listConsentDocumentsMock,
  getConsentDocumentByVersion: getConsentDocumentByVersionMock,
  insertConsentDocument: insertConsentDocumentMock,
  getActiveConsentDocument: getActiveConsentDocumentMock,
}));
vi.mock('../../utils/consent.js', () => ({
  getActiveConsent: getActiveConsentMock,
  invalidateConsentCache: invalidateConsentCacheMock,
  sha256Hex: (s: string) => `hash(${s})`,
}));

import adminConsentRoutes from './consent.routes.js';

function appAs(role: string | null, username = 'nathan') {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { session: Record<string, unknown> }).session = role
      ? { userId: 1, userRole: role, username }
      : {};
    next();
  });
  app.use(adminConsentRoutes());
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
  getActiveConsentMock.mockResolvedValue({ version: 'v1', body: 'b', bodyHash: 'h' });
  getActiveConsentDocumentMock.mockResolvedValue({ version: 'v2' });
});

describe('POST /admin/api/consent/versions', () => {
  it('publishes a new version and busts the cache (researcher)', async () => {
    insertConsentDocumentMock.mockResolvedValueOnce({ document_id: 2, version: 'v2', body: 'new copy' });
    const res = await request(appAs('researcher'))
      .post('/admin/api/consent/versions')
      .send({ version: 'v2', body: 'new copy' });
    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(insertConsentDocumentMock).toHaveBeenCalledWith(
      expect.objectContaining({ version: 'v2', body: 'new copy', bodyHash: 'hash(new copy)', publishedBy: 'nathan' })
    );
    expect(invalidateConsentCacheMock).toHaveBeenCalledOnce();
  });

  it('returns 409 on a duplicate version', async () => {
    insertConsentDocumentMock.mockRejectedValueOnce({ code: '23505' });
    const res = await request(appAs('researcher'))
      .post('/admin/api/consent/versions')
      .send({ version: 'v1', body: 'copy' });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/already exists/);
  });

  it('rejects a non-researcher with 403', async () => {
    const res = await request(appAs('therapist'))
      .post('/admin/api/consent/versions')
      .send({ version: 'v2', body: 'copy' });
    expect(res.status).toBe(403);
    expect(insertConsentDocumentMock).not.toHaveBeenCalled();
  });

  it('rejects a missing body with 400', async () => {
    const res = await request(appAs('researcher'))
      .post('/admin/api/consent/versions')
      .send({ version: 'v2', body: '   ' });
    expect(res.status).toBe(400);
  });
});

describe('GET /admin/api/consent/versions', () => {
  it('lists versions + active version for therapist', async () => {
    listConsentDocumentsMock.mockResolvedValueOnce([{ version: 'v1', acceptance_count: 3 }]);
    const res = await request(appAs('therapist')).get('/admin/api/consent/versions');
    expect(res.status).toBe(200);
    expect(res.body.activeVersion).toBe('v1');
    expect(res.body.versions).toHaveLength(1);
  });

  it('403s a participant', async () => {
    const res = await request(appAs('participant')).get('/admin/api/consent/versions');
    expect(res.status).toBe(403);
  });
});
