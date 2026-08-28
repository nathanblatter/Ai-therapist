// Caseload assignment API tests (ai-therapist-119, caseload RBAC MVP):
// therapist sees own caseload, researcher sees the full matrix and is the
// only role allowed to assign/unassign; CaseloadRoleError maps to 400.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

const dbMocks = vi.hoisted(() => {
  class CaseloadRoleError extends Error {}
  return {
    CaseloadRoleError,
    insertCaseloadAudit: vi.fn().mockResolvedValue(undefined),
    listCaseloadAudit: vi.fn().mockResolvedValue([]),
    assignClient: vi.fn(),
    unassignClient: vi.fn(),
    listCaseload: vi.fn(),
    listAllAssignments: vi.fn(),
    getAllUsers: vi.fn(),
    freezeThreadsForPair: vi.fn(),
    // Transitive import of middleware/org.ts (researcher org scoping, C13).
    getOrganizationIdForUser: vi.fn().mockResolvedValue(1),
    getIrbStudyOrgId: vi.fn().mockResolvedValue(1),
  };
});
vi.mock('../../db/index.js', () => dbMocks);

import caseloadRoutes from './caseload.routes.js';

function appAs(role: string | null, userId = 1) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { session: Record<string, unknown> }).session = role
      ? { userId, userRole: role, username: 'tester' }
      : {};
    next();
  });
  app.use(caseloadRoutes());
  return app;
}

beforeEach(() => {
  dbMocks.assignClient.mockReset().mockResolvedValue(undefined);
  dbMocks.unassignClient.mockReset().mockResolvedValue(true);
  dbMocks.listCaseload.mockReset().mockResolvedValue([
    { userid: 42, username: 'p42', created_at: '2026-01-01', assigned_at: '2026-08-01' },
  ]);
  dbMocks.listAllAssignments.mockReset().mockResolvedValue([
    { therapist_id: 1, therapist_username: 't1', client_id: 42, client_username: 'p42', assigned_at: '2026-08-01' },
  ]);
  dbMocks.freezeThreadsForPair.mockReset().mockResolvedValue([]);
  dbMocks.getAllUsers.mockReset().mockResolvedValue([
    { userid: 1, username: 't1', role: 'therapist', created_at: '2026-01-01' },
    { userid: 42, username: 'p42', role: 'participant', created_at: '2026-01-02' },
    { userid: 7, username: 'r1', role: 'researcher', created_at: '2026-01-03' },
  ]);
  // Everyone in org 1 by default; cross-org tests override per-user.
  dbMocks.getOrganizationIdForUser.mockReset().mockResolvedValue(1);
  dbMocks.getIrbStudyOrgId.mockReset().mockResolvedValue(1);
});

describe('GET /admin/api/caseload', () => {
  it('returns the therapist own caseload', async () => {
    const res = await request(appAs('therapist', 9)).get('/admin/api/caseload');
    expect(res.status).toBe(200);
    expect(res.body.clients).toHaveLength(1);
    expect(res.body.clients[0]).toMatchObject({ userid: 42, username: 'p42' });
    expect(dbMocks.listCaseload).toHaveBeenCalledWith(9);
    expect(dbMocks.listAllAssignments).not.toHaveBeenCalled();
  });

  it('returns all assignments for a researcher', async () => {
    const res = await request(appAs('researcher')).get('/admin/api/caseload');
    expect(res.status).toBe(200);
    expect(res.body.assignments[0]).toMatchObject({ therapist_id: 1, client_id: 42 });
    expect(dbMocks.listCaseload).not.toHaveBeenCalled();
  });

  it('denies participants (403) and anonymous (401)', async () => {
    expect((await request(appAs('participant')).get('/admin/api/caseload')).status).toBe(403);
    expect((await request(appAs(null)).get('/admin/api/caseload')).status).toBe(401);
  });
});

describe('GET /admin/api/caseload/therapists', () => {
  it('is researcher-only: therapists get 403', async () => {
    expect((await request(appAs('therapist')).get('/admin/api/caseload/therapists')).status).toBe(403);
    expect(dbMocks.getAllUsers).not.toHaveBeenCalled();
  });

  it('returns only users with role=therapist', async () => {
    const res = await request(appAs('researcher')).get('/admin/api/caseload/therapists');
    expect(res.status).toBe(200);
    expect(res.body.therapists).toEqual([
      { userid: 1, username: 't1', created_at: '2026-01-01' },
    ]);
  });
});

describe('POST /admin/api/caseload/:therapistId/:clientId', () => {
  it('assigns for a researcher, recording who assigned', async () => {
    const res = await request(appAs('researcher', 7)).post('/admin/api/caseload/1/42');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ success: true, therapistId: 1, clientId: 42 });
    expect(dbMocks.assignClient).toHaveBeenCalledWith(1, 42, 7);
  });

  it('is researcher-only: therapists cannot self-assign', async () => {
    const res = await request(appAs('therapist')).post('/admin/api/caseload/1/42');
    expect(res.status).toBe(403);
    expect(dbMocks.assignClient).not.toHaveBeenCalled();
  });

  it('maps CaseloadRoleError to 400', async () => {
    dbMocks.assignClient.mockRejectedValueOnce(new dbMocks.CaseloadRoleError('user 42 is not a participant'));
    const res = await request(appAs('researcher')).post('/admin/api/caseload/1/42');
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('user 42 is not a participant');
  });

  it('400s on non-numeric ids without hitting the db', async () => {
    const res = await request(appAs('researcher')).post('/admin/api/caseload/abc/42');
    expect(res.status).toBe(400);
    expect(dbMocks.assignClient).not.toHaveBeenCalled();
  });

  it('500s on unexpected db errors', async () => {
    dbMocks.assignClient.mockRejectedValueOnce(new Error('db down'));
    const res = await request(appAs('researcher')).post('/admin/api/caseload/1/42');
    expect(res.status).toBe(500);
  });

  it('404s (never assigns) when the target member is in another org', async () => {
    // Caller (userId 7) resolves org 1; member 1 resolves org 9.
    dbMocks.getOrganizationIdForUser.mockImplementation(async (id: number) => (id === 1 ? 9 : 1));
    const res = await request(appAs('researcher', 7)).post('/admin/api/caseload/1/42');
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('Not found');
    expect(dbMocks.assignClient).not.toHaveBeenCalled();
  });

  it('404s when the target client is in another org', async () => {
    dbMocks.getOrganizationIdForUser.mockImplementation(async (id: number) => (id === 42 ? 9 : 1));
    const res = await request(appAs('researcher', 7)).post('/admin/api/caseload/1/42');
    expect(res.status).toBe(404);
    expect(dbMocks.assignClient).not.toHaveBeenCalled();
  });

  it('404s when the member does not exist (org unresolvable, 404-over-403)', async () => {
    dbMocks.getOrganizationIdForUser.mockImplementation(async (id: number) => (id === 1 ? null : 1));
    const res = await request(appAs('researcher', 7)).post('/admin/api/caseload/1/42');
    expect(res.status).toBe(404);
    expect(dbMocks.assignClient).not.toHaveBeenCalled();
  });
});

describe('DELETE /admin/api/caseload/:therapistId/:clientId', () => {
  it('unassigns for a researcher and reports whether a row was removed', async () => {
    const res = await request(appAs('researcher')).delete('/admin/api/caseload/1/42');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ success: true, removed: true });
    expect(dbMocks.unassignClient).toHaveBeenCalledWith(1, 42);

    dbMocks.unassignClient.mockResolvedValueOnce(false);
    const noop = await request(appAs('researcher')).delete('/admin/api/caseload/1/42');
    expect(noop.body.removed).toBe(false);
  });

  it('freezes the pair message thread on unassign (messaging slice)', async () => {
    dbMocks.freezeThreadsForPair.mockResolvedValueOnce([7]);
    const res = await request(appAs('researcher')).delete('/admin/api/caseload/1/42');
    expect(res.status).toBe(200);
    expect(dbMocks.freezeThreadsForPair).toHaveBeenCalledWith(1, 42, 'unassigned');
  });

  it('does not freeze threads when no assignment row was removed', async () => {
    dbMocks.unassignClient.mockResolvedValueOnce(false);
    await request(appAs('researcher')).delete('/admin/api/caseload/1/42');
    expect(dbMocks.freezeThreadsForPair).not.toHaveBeenCalled();
  });

  it('still unassigns successfully when the thread freeze fails', async () => {
    dbMocks.freezeThreadsForPair.mockRejectedValueOnce(new Error('db down'));
    const res = await request(appAs('researcher')).delete('/admin/api/caseload/1/42');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ success: true, removed: true });
  });

  it('is researcher-only', async () => {
    expect((await request(appAs('therapist')).delete('/admin/api/caseload/1/42')).status).toBe(403);
    expect((await request(appAs(null)).delete('/admin/api/caseload/1/42')).status).toBe(401);
    expect(dbMocks.unassignClient).not.toHaveBeenCalled();
  });

  it('400s on non-numeric ids', async () => {
    expect((await request(appAs('researcher')).delete('/admin/api/caseload/1/xyz')).status).toBe(400);
    expect(dbMocks.unassignClient).not.toHaveBeenCalled();
  });

  it('404s (never unassigns) a cross-org pair', async () => {
    dbMocks.getOrganizationIdForUser.mockImplementation(async (id: number) => (id === 1 ? 9 : 1));
    const res = await request(appAs('researcher', 7)).delete('/admin/api/caseload/1/42');
    expect(res.status).toBe(404);
    expect(dbMocks.unassignClient).not.toHaveBeenCalled();
    expect(dbMocks.freezeThreadsForPair).not.toHaveBeenCalled();
  });
});
