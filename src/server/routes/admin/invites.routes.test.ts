// Auth + shape coverage for the therapist invite-management API
// (ai-therapist-119): minting one-time links and listing own invites with a
// derived pending/used/expired state.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

const mocks = vi.hoisted(() => ({
  createInvite: vi.fn(),
  listInvites: vi.fn(),
}));

vi.mock('../../db/index.js', () => ({
  createInvite: mocks.createInvite,
  listInvites: mocks.listInvites,
  insertCaseloadAudit: vi.fn().mockResolvedValue(undefined),
}));

import invitesRoutes from './invites.routes.js';

function appAs(role: string | null) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { session: Record<string, unknown> }).session = role
      ? { userId: 1, userRole: role, username: 'tester' }
      : {};
    next();
  });
  app.use(invitesRoutes());
  return app;
}

const RAW_TOKEN = 'A'.repeat(43);
const INVITE_ROW = {
  invite_id: 7,
  token_hash: 'deadbeef',
  therapist_id: 1,
  label: 'JB',
  created_at: '2026-08-21T00:00:00.000Z',
  expires_at: '2026-08-28T00:00:00.000Z',
  used_at: null,
  used_by: null,
};

beforeEach(() => {
  mocks.createInvite.mockReset().mockResolvedValue({ rawToken: RAW_TOKEN, invite: INVITE_ROW });
  mocks.listInvites.mockReset().mockResolvedValue([]);
});

describe('POST /admin/api/caseload/invites', () => {
  it('is therapist-only: 403 researcher/participant, 401 anonymous', async () => {
    expect((await request(appAs('researcher')).post('/admin/api/caseload/invites').send({})).status).toBe(403);
    expect((await request(appAs('participant')).post('/admin/api/caseload/invites').send({})).status).toBe(403);
    expect((await request(appAs(null)).post('/admin/api/caseload/invites').send({})).status).toBe(401);
    expect(mocks.createInvite).not.toHaveBeenCalled();
  });

  it('mints an invite for the calling therapist and returns the one-time /join link', async () => {
    const res = await request(appAs('therapist'))
      .post('/admin/api/caseload/invites')
      .send({ label: 'JB' });

    expect(res.status).toBe(200);
    expect(res.body.link).toBe(`/join/${RAW_TOKEN}`);
    expect(mocks.createInvite).toHaveBeenCalledWith(1, 'JB', 168);
    expect(res.body.invite).toMatchObject({ invite_id: 7, label: 'JB', state: 'pending' });
    // The token hash never leaves the server.
    expect(res.body.invite.token_hash).toBeUndefined();
  });

  it('defaults a blank label to null and accepts a custom ttlHours', async () => {
    await request(appAs('therapist')).post('/admin/api/caseload/invites').send({ label: '  ', ttlHours: 24 });
    expect(mocks.createInvite).toHaveBeenCalledWith(1, null, 24);
  });

  it('rejects a non-positive or garbage ttlHours with 400', async () => {
    expect((await request(appAs('therapist')).post('/admin/api/caseload/invites').send({ ttlHours: 0 })).status).toBe(400);
    expect((await request(appAs('therapist')).post('/admin/api/caseload/invites').send({ ttlHours: 'soon' })).status).toBe(400);
    expect(mocks.createInvite).not.toHaveBeenCalled();
  });

  it('500s when the insert fails', async () => {
    mocks.createInvite.mockRejectedValue(new Error('db down'));
    expect((await request(appAs('therapist')).post('/admin/api/caseload/invites').send({})).status).toBe(500);
  });
});

describe('GET /admin/api/caseload/invites', () => {
  it('is therapist-only: 403 researcher, 401 anonymous', async () => {
    expect((await request(appAs('researcher')).get('/admin/api/caseload/invites')).status).toBe(403);
    expect((await request(appAs(null)).get('/admin/api/caseload/invites')).status).toBe(401);
    expect(mocks.listInvites).not.toHaveBeenCalled();
  });

  it('returns own invites with derived pending/used/expired state, sans token hash', async () => {
    const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const past = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    mocks.listInvites.mockResolvedValue([
      { ...INVITE_ROW, invite_id: 1, expires_at: future }, // pending
      { ...INVITE_ROW, invite_id: 2, expires_at: future, used_at: past, used_by: 42 }, // used
      { ...INVITE_ROW, invite_id: 3, expires_at: past }, // expired
      { ...INVITE_ROW, invite_id: 4, expires_at: past, used_at: past }, // used wins over expired
    ]);

    const res = await request(appAs('therapist')).get('/admin/api/caseload/invites');

    expect(res.status).toBe(200);
    expect(mocks.listInvites).toHaveBeenCalledWith(1);
    expect(res.body.invites.map((i: { state: string }) => i.state)).toEqual([
      'pending', 'used', 'expired', 'used',
    ]);
    for (const invite of res.body.invites) {
      expect(invite.token_hash).toBeUndefined();
    }
  });
});
