// Auth + shape coverage for researcher sandbox-invite minting (caseworker
// portal, spec section 7): batch mint returns raw /join-sandbox links exactly
// once; listing exposes batch counts, never token hashes.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

const mocks = vi.hoisted(() => ({
  createSandboxInviteBatch: vi.fn(),
  listSandboxInviteBatches: vi.fn(),
}));

vi.mock('../../db/index.js', () => ({
  createSandboxInviteBatch: mocks.createSandboxInviteBatch,
  listSandboxInviteBatches: mocks.listSandboxInviteBatches,
  insertCaseloadAudit: vi.fn().mockResolvedValue(undefined),
}));

import sandboxInvitesRoutes from './sandboxInvites.routes.js';

function appAs(role: string | null) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { session: Record<string, unknown> }).session = role
      ? { userId: 1, userRole: role, username: 'res_1' }
      : {};
    next();
  });
  app.use(sandboxInvitesRoutes());
  return app;
}

const FUTURE = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();

function mintResult(n: number) {
  return {
    batchId: 'batch-uuid-1',
    invites: Array.from({ length: n }, (_, i) => ({
      rawToken: `rawtok${i}`,
      invite: { invite_id: i + 1, token_hash: `hash${i}`, expires_at: FUTURE },
    })),
  };
}

beforeEach(() => {
  mocks.createSandboxInviteBatch.mockReset().mockResolvedValue(mintResult(2));
  mocks.listSandboxInviteBatches.mockReset().mockResolvedValue([]);
});

describe('POST /admin/api/sandbox/invites', () => {
  it('is researcher-only: 403 therapist/caseworker/participant, 401 anonymous', async () => {
    for (const role of ['therapist', 'caseworker', 'participant']) {
      expect((await request(appAs(role)).post('/admin/api/sandbox/invites').send({ count: 1, role: 'therapist' })).status).toBe(403);
    }
    expect((await request(appAs(null)).post('/admin/api/sandbox/invites').send({ count: 1, role: 'therapist' })).status).toBe(401);
    expect(mocks.createSandboxInviteBatch).not.toHaveBeenCalled();
  });

  it('mints a batch and returns raw /join-sandbox links exactly once (no token hashes)', async () => {
    const res = await request(appAs('researcher'))
      .post('/admin/api/sandbox/invites')
      .send({ count: 2, role: 'caseworker', label: 'conference demo' });

    expect(res.status).toBe(201);
    expect(res.body.batchId).toBe('batch-uuid-1');
    expect(res.body.links).toEqual([
      { inviteId: 1, link: '/join-sandbox/rawtok0' },
      { inviteId: 2, link: '/join-sandbox/rawtok1' },
    ]);
    expect(JSON.stringify(res.body)).not.toContain('hash0');
    expect(mocks.createSandboxInviteBatch).toHaveBeenCalledWith({
      count: 2,
      inviteRole: 'caseworker',
      label: 'conference demo',
      ttlHours: 24 * 30,
      createdBy: 1,
    });
  });

  it('validates count (1-500 integer) and role before touching the db', async () => {
    const bad = [
      { count: 0, role: 'therapist' },
      { count: 501, role: 'therapist' },
      { count: 2.5, role: 'therapist' },
      { count: 'many', role: 'therapist' },
      { count: 3, role: 'researcher' },
      { count: 3 },
    ];
    for (const body of bad) {
      expect((await request(appAs('researcher')).post('/admin/api/sandbox/invites').send(body)).status).toBe(400);
    }
    expect(mocks.createSandboxInviteBatch).not.toHaveBeenCalled();
  });

  it('rejects a non-positive or oversized ttlHours', async () => {
    expect((await request(appAs('researcher')).post('/admin/api/sandbox/invites').send({ count: 1, role: 'therapist', ttlHours: 0 })).status).toBe(400);
    expect((await request(appAs('researcher')).post('/admin/api/sandbox/invites').send({ count: 1, role: 'therapist', ttlHours: 24 * 365 })).status).toBe(400);
    expect(mocks.createSandboxInviteBatch).not.toHaveBeenCalled();
  });

  it('500s when the insert fails', async () => {
    mocks.createSandboxInviteBatch.mockRejectedValue(new Error('db down'));
    expect((await request(appAs('researcher')).post('/admin/api/sandbox/invites').send({ count: 1, role: 'therapist' })).status).toBe(500);
  });
});

describe('GET /admin/api/sandbox/invites', () => {
  it('is researcher-only', async () => {
    expect((await request(appAs('therapist')).get('/admin/api/sandbox/invites')).status).toBe(403);
    expect((await request(appAs(null)).get('/admin/api/sandbox/invites')).status).toBe(401);
  });

  it('returns batch history', async () => {
    mocks.listSandboxInviteBatches.mockResolvedValue([
      { batch_id: 'b1', invite_role: 'therapist', label: 'wave 1', total: 20, used: 12 },
    ]);
    const res = await request(appAs('researcher')).get('/admin/api/sandbox/invites');
    expect(res.status).toBe(200);
    expect(res.body.batches).toHaveLength(1);
    expect(res.body.batches[0]).toMatchObject({ batch_id: 'b1', total: 20, used: 12 });
  });
});
