// Login-session admin routes (ai-therapist-272): researcher-only and
// organization-scoped — the list and the force-logout both carry the caller's
// org into the query, a session outside it reads as 404 (never 403), and an
// unresolvable org fails closed (500) rather than widening to every org.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

const dbMocks = vi.hoisted(() => ({
  getActiveUserSessions: vi.fn(),
  deleteUserSession: vi.fn(),
  // Org resolution (middleware/org.ts) for sessions without a stamped orgId.
  getOrganizationIdForUser: vi.fn(),
  getIrbStudyOrgId: vi.fn(),
}));
vi.mock('../../db/index.js', () => dbMocks);

import userSessionsRoutes from './userSessions.routes.js';

const IRB_ORG = 1;
const PRACTICE_ORG = 2;

function appAs(role: string | null, orgId?: number) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { session: Record<string, unknown> }).session = role
      ? { userId: 7, userRole: role, username: 'tester', ...(orgId === undefined ? {} : { orgId }) }
      : {};
    next();
  });
  app.use(userSessionsRoutes());
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
  dbMocks.getActiveUserSessions.mockResolvedValue([
    {
      sid: 'a',
      expire: '2026-11-01T00:00:00.000Z',
      sess: { cookie: {}, userId: 9, username: 'p9', userRole: 'participant' },
    },
    { sid: 'b', expire: '2026-11-01T00:00:00.000Z', sess: JSON.stringify({ cookie: {} }) },
  ]);
  dbMocks.deleteUserSession.mockResolvedValue('a');
  dbMocks.getOrganizationIdForUser.mockResolvedValue(PRACTICE_ORG);
  dbMocks.getIrbStudyOrgId.mockResolvedValue(IRB_ORG);
});

describe('GET /admin/api/user-sessions', () => {
  it('lists sessions scoped to the caller org (stamped on the session, no lookup)', async () => {
    const res = await request(appAs('researcher', PRACTICE_ORG)).get('/admin/api/user-sessions');
    expect(res.status).toBe(200);
    expect(dbMocks.getActiveUserSessions).toHaveBeenCalledWith(PRACTICE_ORG);
    expect(dbMocks.getOrganizationIdForUser).not.toHaveBeenCalled();
    expect(res.body).toEqual([
      { sid: 'a', expire: '2026-11-01T00:00:00.000Z', userId: 9, username: 'p9', userRole: 'participant', cookie: {} },
      { sid: 'b', expire: '2026-11-01T00:00:00.000Z', cookie: {} },
    ]);
  });

  it('resolves a pre-069 session org by lookup and scopes to it', async () => {
    const res = await request(appAs('researcher')).get('/admin/api/user-sessions');
    expect(res.status).toBe(200);
    expect(dbMocks.getOrganizationIdForUser).toHaveBeenCalledWith(7);
    expect(dbMocks.getActiveUserSessions).toHaveBeenCalledWith(PRACTICE_ORG);
  });

  it('fails closed when the org cannot be resolved', async () => {
    dbMocks.getOrganizationIdForUser.mockRejectedValue(new Error('db down'));
    expect((await request(appAs('researcher')).get('/admin/api/user-sessions')).status).toBe(500);
    expect(dbMocks.getActiveUserSessions).not.toHaveBeenCalled();
  });

  it('is researcher-only', async () => {
    expect((await request(appAs('therapist', IRB_ORG)).get('/admin/api/user-sessions')).status).toBe(403);
    expect((await request(appAs(null)).get('/admin/api/user-sessions')).status).toBe(401);
    expect(dbMocks.getActiveUserSessions).not.toHaveBeenCalled();
  });
});

describe('DELETE /admin/api/user-sessions/:sid', () => {
  it('deletes within the caller org', async () => {
    const res = await request(appAs('researcher', IRB_ORG)).delete('/admin/api/user-sessions/a');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ message: 'Session deleted successfully', sid: 'a' });
    expect(dbMocks.deleteUserSession).toHaveBeenCalledWith('a', IRB_ORG);
  });

  it('404s a session outside the caller org (the scoped delete matches nothing)', async () => {
    dbMocks.deleteUserSession.mockResolvedValue(null);
    const res = await request(appAs('researcher', PRACTICE_ORG)).delete('/admin/api/user-sessions/a');
    expect(res.status).toBe(404);
    expect(dbMocks.deleteUserSession).toHaveBeenCalledWith('a', PRACTICE_ORG);
  });

  it('is researcher-only', async () => {
    expect((await request(appAs('caseworker', IRB_ORG)).delete('/admin/api/user-sessions/a')).status).toBe(403);
    expect(dbMocks.deleteUserSession).not.toHaveBeenCalled();
  });
});
