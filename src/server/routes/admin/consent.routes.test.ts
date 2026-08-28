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
  resolveConsentAudienceMock,
} = vi.hoisted(() => ({
  listConsentDocumentsMock: vi.fn(),
  getConsentDocumentByVersionMock: vi.fn(),
  insertConsentDocumentMock: vi.fn(),
  getActiveConsentDocumentMock: vi.fn(),
  getActiveConsentMock: vi.fn(),
  invalidateConsentCacheMock: vi.fn(),
  resolveConsentAudienceMock: vi.fn(),
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
  resolveConsentAudience: resolveConsentAudienceMock,
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
  getActiveConsentMock.mockResolvedValue({ version: 'v1', body: 'b', bodyHash: 'h', audience: 'research' });
  getActiveConsentDocumentMock.mockResolvedValue({ version: 'v2' });
  resolveConsentAudienceMock.mockResolvedValue('research');
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

  it('publishes an audience-targeted clinical version (078)', async () => {
    insertConsentDocumentMock.mockResolvedValueOnce({ document_id: 3, version: 'c2', audience: 'clinical' });
    const res = await request(appAs('researcher'))
      .post('/admin/api/consent/versions')
      .send({ version: 'c2', body: 'clinical copy', audience: 'clinical' });
    expect(res.status).toBe(201);
    expect(insertConsentDocumentMock).toHaveBeenCalledWith(
      expect.objectContaining({ version: 'c2', audience: 'clinical' })
    );
    expect(getActiveConsentDocumentMock).toHaveBeenCalledWith('clinical');
  });

  it('defaults audience to research and rejects an invalid one', async () => {
    insertConsentDocumentMock.mockResolvedValueOnce({ document_id: 4, version: 'v3' });
    await request(appAs('researcher')).post('/admin/api/consent/versions').send({ version: 'v3', body: 'copy' });
    expect(insertConsentDocumentMock).toHaveBeenCalledWith(expect.objectContaining({ audience: 'research' }));

    const bad = await request(appAs('researcher'))
      .post('/admin/api/consent/versions')
      .send({ version: 'v4', body: 'copy', audience: 'participant' });
    expect(bad.status).toBe(400);
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

  it('reports the per-audience active versions and the audience in effect', async () => {
    listConsentDocumentsMock.mockResolvedValueOnce([]);
    getActiveConsentDocumentMock
      .mockResolvedValueOnce({ version: 'r9' })   // research
      .mockResolvedValueOnce({ version: '2026-08-27.c1' }); // clinical
    resolveConsentAudienceMock.mockResolvedValue('clinical');
    const res = await request(appAs('researcher')).get('/admin/api/consent/versions');
    expect(res.status).toBe(200);
    expect(res.body.audienceInEffect).toBe('clinical');
    expect(res.body.activeVersions).toEqual({ research: 'r9', clinical: '2026-08-27.c1' });
  });

  it('403s a participant', async () => {
    const res = await request(appAs('participant')).get('/admin/api/consent/versions');
    expect(res.status).toBe(403);
  });
});
