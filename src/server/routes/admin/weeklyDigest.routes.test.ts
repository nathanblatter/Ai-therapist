// Weekly digest routes (eval spec WP7): role matrix, sandbox 404, org scoping
// through orgIdFor (list, get, download, generate), week validation, the
// schedule endpoint, and the absence of any data_access_log write.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

const mocks = vi.hoisted(() => ({
  logDataAccess: vi.fn().mockResolvedValue(undefined),
  getOrganizationIdForUser: vi.fn().mockResolvedValue(1),
  getIrbStudyOrgId: vi.fn().mockResolvedValue(1),
  listWeeklyDigests: vi.fn(),
  getWeeklyDigest: vi.fn(),
  generateAndStoreWeeklyDigest: vi.fn(),
  getDigestSchedule: vi.fn(),
  setDigestSchedule: vi.fn(),
}));
vi.mock('../../db/index.js', () => ({
  logDataAccess: mocks.logDataAccess,
  getOrganizationIdForUser: mocks.getOrganizationIdForUser,
  getIrbStudyOrgId: mocks.getIrbStudyOrgId,
  listWeeklyDigests: mocks.listWeeklyDigests,
  getWeeklyDigest: mocks.getWeeklyDigest,
}));
vi.mock('../../services/weeklyDigest.service.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../services/weeklyDigest.service.js')>();
  return {
    ...real,
    generateAndStoreWeeklyDigest: mocks.generateAndStoreWeeklyDigest,
    getDigestSchedule: mocks.getDigestSchedule,
    setDigestSchedule: mocks.setDigestSchedule,
  };
});

import weeklyDigestRoutes from './weeklyDigest.routes.js';
import { defaultWeekEnding } from '../../services/weeklyDigest.service.js';

const row = (id: number, orgId: number) => ({
  id, org_id: orgId, week_ending: '2026-10-18', markdown: '# Weekly quality digest - week ending 2026-10-18\n',
  data: { meta: { week_ending: '2026-10-18' } }, generated_at: new Date('2026-10-19T06:00:00Z'), generated_by: 'scheduler',
});

function appAs(session: Record<string, unknown> | null) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { session: Record<string, unknown> }).session = session ? { ...session } : {};
    next();
  });
  app.use(weeklyDigestRoutes());
  return app;
}
const researcher = (orgId = 1) => ({ userId: 9, userRole: 'researcher', username: 'res1', orgId });

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getOrganizationIdForUser.mockResolvedValue(1);
  mocks.getIrbStudyOrgId.mockResolvedValue(1);
  mocks.listWeeklyDigests.mockImplementation(async (orgId: number) => [row(1, orgId)]);
  mocks.getWeeklyDigest.mockImplementation(async (id: number, orgId: number) => (id === 1 && orgId === 1 ? row(1, 1) : null));
  mocks.generateAndStoreWeeklyDigest.mockImplementation(async (i: { weekEnding: string; orgId: number }) => ({ ...row(2, i.orgId), week_ending: i.weekEnding }));
  mocks.getDigestSchedule.mockResolvedValue({ enabled: false, weekday: 1, hour_utc: 6 });
  mocks.setDigestSchedule.mockImplementation(async (raw: unknown) => ({ enabled: false, weekday: 1, hour_utc: 6, ...(raw as object) }));
});

describe('role matrix', () => {
  const calls: Array<[string, string, number]> = [
    ['get', '/admin/api/evals/digests', 200],
    ['get', '/admin/api/evals/digests/1', 200],
    ['get', '/admin/api/evals/digests/1.md', 200],
    ['post', '/admin/api/evals/digests/generate', 201],
    ['put', '/admin/api/evals/digests/schedule', 200],
  ];
  for (const [method, path, ok] of calls) {
    it(`${method.toUpperCase()} ${path}: 401 anonymous, 403 other roles, 404 sandbox, ${ok} researcher`, async () => {
      const send = (session: Record<string, unknown> | null) => {
        const r = request(appAs(session));
        return method === 'get' ? r.get(path) : method === 'post' ? r.post(path).send({}) : r.put(path).send({ enabled: true });
      };
      expect((await send(null)).status).toBe(401);
      for (const role of ['participant', 'therapist', 'caseworker', 'demo']) {
        expect((await send({ userId: 2, userRole: role, username: 'u', orgId: 1 })).status).toBe(403);
      }
      expect((await send({ ...researcher(), isSandbox: true })).status).toBe(404);
      expect(mocks.generateAndStoreWeeklyDigest).not.toHaveBeenCalled();
      expect(mocks.setDigestSchedule).not.toHaveBeenCalled();
      expect((await send(researcher())).status).toBe(ok);
    });
  }
});

describe('org scope', () => {
  it('lists only the session org, never a query-supplied one', async () => {
    const res = await request(appAs(researcher(5))).get('/admin/api/evals/digests?orgId=1');
    expect(res.status).toBe(200);
    expect(mocks.listWeeklyDigests).toHaveBeenCalledWith(5, 26);
    expect(res.body.digests[0].org_id).toBe(5);
    expect(res.body.schedule).toEqual({ enabled: false, weekday: 1, hour_utc: 6 });
    expect(res.body.default_week_ending).toBe(defaultWeekEnding());
  });

  it('reads another org\'s digest as 404 (json and download)', async () => {
    expect((await request(appAs(researcher(5))).get('/admin/api/evals/digests/1')).status).toBe(404);
    expect((await request(appAs(researcher(5))).get('/admin/api/evals/digests/1.md')).status).toBe(404);
    expect(mocks.getWeeklyDigest).toHaveBeenCalledWith(1, 5);
    const ok = await request(appAs(researcher(1))).get('/admin/api/evals/digests/1');
    expect(ok.status).toBe(200);
    expect(ok.body.digest.markdown).toContain('# Weekly quality digest');
    expect(ok.body.digest.data.meta.week_ending).toBe('2026-10-18');
  });

  it('generates for the session org with the caller as generator, and never logs data access', async () => {
    const res = await request(appAs(researcher(5))).post('/admin/api/evals/digests/generate').send({ week_ending: '2026-10-11', orgId: 1 });
    expect(res.status).toBe(201);
    expect(mocks.generateAndStoreWeeklyDigest).toHaveBeenCalledWith({ weekEnding: '2026-10-11', orgId: 5, generatedBy: 'res1' });
    expect(res.body.digest.week_ending).toBe('2026-10-11');
    expect(mocks.logDataAccess).not.toHaveBeenCalled();
  });

  it('resolves a pre-069 session through the user row, and 500s (never widens) when resolution fails', async () => {
    const noOrg = { userId: 9, userRole: 'researcher', username: 'res1' };
    mocks.getOrganizationIdForUser.mockResolvedValueOnce(3);
    expect((await request(appAs(noOrg)).get('/admin/api/evals/digests')).status).toBe(200);
    expect(mocks.listWeeklyDigests).toHaveBeenCalledWith(3, 26);
    mocks.getOrganizationIdForUser.mockRejectedValueOnce(new Error('db down'));
    expect((await request(appAs(noOrg)).get('/admin/api/evals/digests')).status).toBe(500);
    expect(mocks.listWeeklyDigests).toHaveBeenCalledTimes(1);
  });
});

describe('validation', () => {
  it('defaults week_ending to the last complete week', async () => {
    const res = await request(appAs(researcher())).post('/admin/api/evals/digests/generate').send({});
    expect(res.status).toBe(201);
    expect(mocks.generateAndStoreWeeklyDigest).toHaveBeenCalledWith(expect.objectContaining({ weekEnding: defaultWeekEnding() }));
  });

  it('rejects malformed, far-past and future weeks', async () => {
    for (const week_ending of ['soon', '2026-13-01', '2020-01-05', '2099-01-03']) {
      const res = await request(appAs(researcher())).post('/admin/api/evals/digests/generate').send({ week_ending });
      expect(res.status, week_ending).toBe(400);
    }
    expect(mocks.generateAndStoreWeeklyDigest).not.toHaveBeenCalled();
  });

  it('rejects a non-numeric id', async () => {
    expect((await request(appAs(researcher())).get('/admin/api/evals/digests/abc')).status).toBe(400);
    expect((await request(appAs(researcher())).get('/admin/api/evals/digests/abc.md')).status).toBe(400);
  });

  it('serves the download as markdown with a per-week filename', async () => {
    const res = await request(appAs(researcher())).get('/admin/api/evals/digests/1.md');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/markdown/);
    expect(res.headers['content-disposition']).toContain('weekly-digest-2026-10-18.md');
    expect(res.text).toContain('# Weekly quality digest');
  });

  it('saves the schedule under the caller\'s username', async () => {
    const res = await request(appAs(researcher())).put('/admin/api/evals/digests/schedule').send({ enabled: true, weekday: 2, hour_utc: 7 });
    expect(res.status).toBe(200);
    expect(mocks.setDigestSchedule).toHaveBeenCalledWith({ enabled: true, weekday: 2, hour_utc: 7 }, 'res1');
    expect(res.body.schedule).toMatchObject({ enabled: true, weekday: 2, hour_utc: 7 });
  });
});
