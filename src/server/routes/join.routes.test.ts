// Public /join/:token invite-registration flow (ai-therapist-119):
// dead/expired/reused tokens are 410; a live invite serves the registration
// page; the happy path atomically consumes the invite, creates a participant,
// assigns them to the inviting therapist, and logs them in.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

const mocks = vi.hoisted(() => ({
  findInviteByToken: vi.fn(),
  consumeInvite: vi.fn(),
  releaseInvite: vi.fn(),
  markInviteUsedBy: vi.fn(),
  createUser: vi.fn(),
  deleteUser: vi.fn(),
  getUserById: vi.fn(),
  assignClient: vi.fn(),
  // Sandbox flow (caseworker portal, spec section 7)
  findSandboxInviteByToken: vi.fn(),
  consumeSandboxInvite: vi.fn(),
  releaseSandboxInvite: vi.fn(),
  markSandboxInviteUsed: vi.fn(),
  createOrganization: vi.fn(),
  deleteSandboxOrganization: vi.fn(),
  seedSandboxCaseload: vi.fn(),
}));

vi.mock('../db/index.js', () => ({
  findInviteByToken: mocks.findInviteByToken,
  consumeInvite: mocks.consumeInvite,
  releaseInvite: mocks.releaseInvite,
  markInviteUsedBy: mocks.markInviteUsedBy,
  createUser: mocks.createUser,
  deleteUser: mocks.deleteUser,
  getUserById: mocks.getUserById,
  assignClient: mocks.assignClient,
  insertCaseloadAudit: vi.fn().mockResolvedValue(undefined),
  findSandboxInviteByToken: mocks.findSandboxInviteByToken,
  consumeSandboxInvite: mocks.consumeSandboxInvite,
  releaseSandboxInvite: mocks.releaseSandboxInvite,
  markSandboxInviteUsed: mocks.markSandboxInviteUsed,
  createOrganization: mocks.createOrganization,
  deleteSandboxOrganization: mocks.deleteSandboxOrganization,
}));

vi.mock('../services/sandboxSeed.js', () => ({
  seedSandboxCaseload: mocks.seedSandboxCaseload,
}));

import joinRoutes from './join.routes.js';

type FakeSession = Record<string, unknown> & { save: (cb?: (err?: unknown) => void) => void };

function makeApp() {
  const session: FakeSession = { save: (cb) => cb?.() };
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { session: FakeSession }).session = session;
    next();
  });
  app.use(joinRoutes());
  return { app, session };
}

const FUTURE = new Date(Date.now() + 60 * 60 * 1000).toISOString();
const PAST = new Date(Date.now() - 60 * 60 * 1000).toISOString();
const LIVE_INVITE = {
  invite_id: 7,
  token_hash: 'deadbeef',
  therapist_id: 3,
  label: 'JB',
  created_at: PAST,
  expires_at: FUTURE,
  used_at: null,
  used_by: null,
};
const GOOD_BODY = { username: 'newclient', password: 'longenough12' };

const LIVE_SANDBOX_INVITE = {
  invite_id: 21,
  token_hash: 'a1b2c3d4'.repeat(8),
  batch_id: 'batch-uuid',
  invite_role: 'caseworker',
  seed_profile: 'standard',
  label: 'demo wave',
  created_by: 1,
  created_at: PAST,
  expires_at: FUTURE,
  used_at: null,
  used_by: null,
  org_id: null,
};
const SEED_RESULT = {
  clientIds: [101, 102, 103, 104, 105, 106],
  counterpartId: 110,
  seededUserIds: [101, 102, 103, 104, 105, 106, 110],
  sessionCount: 30,
  rowCount: 420,
  escalationId: 5,
};

beforeEach(() => {
  mocks.findInviteByToken.mockReset().mockResolvedValue(LIVE_INVITE);
  mocks.consumeInvite.mockReset().mockResolvedValue({ ...LIVE_INVITE, used_at: FUTURE });
  mocks.releaseInvite.mockReset().mockResolvedValue(undefined);
  mocks.markInviteUsedBy.mockReset().mockResolvedValue(undefined);
  mocks.createUser.mockReset().mockResolvedValue({ userid: 42, username: 'newclient', role: 'participant' });
  mocks.deleteUser.mockReset().mockResolvedValue({ userid: 42, username: 'newclient' });
  // Caseworker portal (spec section 2): the consume flow now looks the
  // inviter up to inherit their care-team role and organization.
  mocks.getUserById.mockReset().mockResolvedValue({
    userid: 3, username: 'dr_t', role: 'therapist', organization_id: 1,
  });
  mocks.assignClient.mockReset().mockResolvedValue(undefined);
  mocks.findSandboxInviteByToken.mockReset().mockResolvedValue(LIVE_SANDBOX_INVITE);
  mocks.consumeSandboxInvite.mockReset().mockResolvedValue({ ...LIVE_SANDBOX_INVITE, used_at: FUTURE });
  mocks.releaseSandboxInvite.mockReset().mockResolvedValue(undefined);
  mocks.markSandboxInviteUsed.mockReset().mockResolvedValue(undefined);
  mocks.createOrganization.mockReset().mockResolvedValue({ org_id: 9, slug: 'newclient-s-sandbox-x', name: "newclient's Sandbox", kind: 'sandbox' });
  mocks.deleteSandboxOrganization.mockReset().mockResolvedValue(true);
  mocks.seedSandboxCaseload.mockReset().mockResolvedValue(SEED_RESULT);
});

describe('GET /join/:token', () => {
  it('serves the self-contained registration page for a live invite', async () => {
    const { app } = makeApp();
    const res = await request(app).get('/join/some-raw-token');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
    expect(res.text).toContain('Create your account');
    expect(res.text).toContain('id="join-form"');
    // The raw token is never reflected into the page.
    expect(res.text).not.toContain('some-raw-token');
    expect(mocks.findInviteByToken).toHaveBeenCalledWith('some-raw-token');
  });

  it('410s for an unknown token', async () => {
    mocks.findInviteByToken.mockResolvedValue(null);
    const res = await request(makeApp().app).get('/join/unknown');
    expect(res.status).toBe(410);
    expect(res.text).toContain('no longer valid');
  });

  it('410s for an already-used invite', async () => {
    mocks.findInviteByToken.mockResolvedValue({ ...LIVE_INVITE, used_at: PAST, used_by: 9 });
    expect((await request(makeApp().app).get('/join/used')).status).toBe(410);
  });

  it('410s for an expired invite', async () => {
    mocks.findInviteByToken.mockResolvedValue({ ...LIVE_INVITE, expires_at: PAST });
    expect((await request(makeApp().app).get('/join/expired')).status).toBe(410);
  });
});

describe('POST /join/:token', () => {
  it('happy path: consumes, creates a participant, assigns to the inviting therapist, logs in', async () => {
    const { app, session } = makeApp();
    const res = await request(app).post('/join/some-raw-token').send(GOOD_BODY);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      success: true,
      user: { userid: 42, username: 'newclient', role: 'participant' },
    });
    expect(mocks.consumeInvite).toHaveBeenCalledWith('some-raw-token');
    // Spec change (caseworker portal): the new participant inherits the
    // inviter's organization and the edge carries the inviter's role.
    expect(mocks.createUser).toHaveBeenCalledWith('newclient', 'longenough12', 'participant', { orgId: 1, isSandbox: false });
    expect(mocks.assignClient).toHaveBeenCalledWith(3, 42, 3, 'therapist');
    expect(mocks.markInviteUsedBy).toHaveBeenCalledWith(7, 42);
    // Session established like login.
    expect(session.userId).toBe(42);
    expect(session.username).toBe('newclient');
    expect(session.userRole).toBe('participant');
    expect(session.mfaVerified).toBe(true);
  });

  it("a caseworker's invite assigns a caseworker care-team edge", async () => {
    mocks.getUserById.mockResolvedValue({
      userid: 3, username: 'cw_1', role: 'caseworker', organization_id: 2,
    });
    const res = await request(makeApp().app).post('/join/tok').send(GOOD_BODY);
    expect(res.status).toBe(200);
    expect(mocks.createUser).toHaveBeenCalledWith('newclient', 'longenough12', 'participant', { orgId: 2, isSandbox: false });
    expect(mocks.assignClient).toHaveBeenCalledWith(3, 42, 3, 'caseworker');
  });

  it("a sandbox owner's invite creates the participant with is_sandbox (C3)", async () => {
    mocks.getUserById.mockResolvedValue({
      userid: 3, username: 'sandbox_owner', role: 'therapist', organization_id: 9, is_sandbox: true,
    });
    const res = await request(makeApp().app).post('/join/tok').send(GOOD_BODY);
    expect(res.status).toBe(200);
    expect(mocks.createUser).toHaveBeenCalledWith('newclient', 'longenough12', 'participant', { orgId: 9, isSandbox: true });
  });

  it('410s and releases the invite when the inviter is gone or not a care-team member', async () => {
    mocks.getUserById.mockResolvedValue(null);
    const res = await request(makeApp().app).post('/join/tok').send(GOOD_BODY);
    expect(res.status).toBe(410);
    expect(mocks.releaseInvite).toHaveBeenCalledWith(7);
    expect(mocks.createUser).not.toHaveBeenCalled();
  });

  it('410s on a dead/expired/reused token (consumeInvite null) without creating a user', async () => {
    mocks.consumeInvite.mockResolvedValue(null);
    const res = await request(makeApp().app).post('/join/dead').send(GOOD_BODY);
    expect(res.status).toBe(410);
    expect(mocks.createUser).not.toHaveBeenCalled();
    expect(mocks.assignClient).not.toHaveBeenCalled();
  });

  it('single-use under racing posts: the second consume loses and gets 410', async () => {
    mocks.consumeInvite
      .mockResolvedValueOnce({ ...LIVE_INVITE, used_at: FUTURE })
      .mockResolvedValueOnce(null);
    const { app } = makeApp();
    expect((await request(app).post('/join/tok').send(GOOD_BODY)).status).toBe(200);
    expect((await request(app).post('/join/tok').send({ username: 'other', password: 'longenough12' })).status).toBe(410);
    expect(mocks.createUser).toHaveBeenCalledTimes(1);
  });

  it('400s on missing username/password or a too-short password, leaving the invite untouched', async () => {
    const { app } = makeApp();
    expect((await request(app).post('/join/tok').send({ username: 'x' })).status).toBe(400);
    expect((await request(app).post('/join/tok').send({ password: 'longenough12' })).status).toBe(400);
    expect((await request(app).post('/join/tok').send({ username: 'x', password: 'short' })).status).toBe(400);
    expect(mocks.consumeInvite).not.toHaveBeenCalled();
  });

  it('409s on a duplicate username and releases the invite for reuse', async () => {
    mocks.createUser.mockRejectedValue(new Error('Username already exists'));
    const res = await request(makeApp().app).post('/join/tok').send(GOOD_BODY);
    expect(res.status).toBe(409);
    expect(mocks.releaseInvite).toHaveBeenCalledWith(7);
    expect(mocks.assignClient).not.toHaveBeenCalled();
  });

  it('500s (and releases the invite) when user creation fails unexpectedly', async () => {
    mocks.createUser.mockRejectedValue(new Error('db down'));
    const res = await request(makeApp().app).post('/join/tok').send(GOOD_BODY);
    expect(res.status).toBe(500);
    expect(mocks.releaseInvite).toHaveBeenCalledWith(7);
  });
});

describe('GET /join-sandbox/:token', () => {
  it('serves the sandbox signup page with the synthetic-data disclosure', async () => {
    const res = await request(makeApp().app).get('/join-sandbox/raw-sandbox-token');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
    expect(res.text).toContain('Create your sandbox');
    expect(res.text).toContain('All client records are synthetic');
    expect(res.text).toContain('care-coordinator (caseworker)');
    // The raw token is never reflected into the page.
    expect(res.text).not.toContain('raw-sandbox-token');
  });

  it('410s for dead/expired/used sandbox invites', async () => {
    mocks.findSandboxInviteByToken.mockResolvedValue(null);
    expect((await request(makeApp().app).get('/join-sandbox/x')).status).toBe(410);
    mocks.findSandboxInviteByToken.mockResolvedValue({ ...LIVE_SANDBOX_INVITE, used_at: PAST });
    expect((await request(makeApp().app).get('/join-sandbox/x')).status).toBe(410);
    mocks.findSandboxInviteByToken.mockResolvedValue({ ...LIVE_SANDBOX_INVITE, expires_at: PAST });
    expect((await request(makeApp().app).get('/join-sandbox/x')).status).toBe(410);
  });
});

describe('POST /join-sandbox/:token', () => {
  const sandboxUser = { userid: 42, username: 'newclient', role: 'caseworker', organization_id: 9, is_sandbox: true };

  beforeEach(() => {
    mocks.createUser.mockResolvedValue(sandboxUser);
  });

  it('happy path: consumes, creates a fresh sandbox org + owner in the invite role, seeds, logs in', async () => {
    const { app, session } = makeApp();
    const res = await request(app).post('/join-sandbox/raw-tok').send(GOOD_BODY);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.sandbox).toEqual({ orgId: 9, clients: 6, sessions: 30 });
    expect(mocks.consumeSandboxInvite).toHaveBeenCalledWith('raw-tok');
    expect(mocks.createOrganization).toHaveBeenCalledWith({ name: "newclient's Sandbox", kind: 'sandbox' });
    expect(mocks.createUser).toHaveBeenCalledWith('newclient', 'longenough12', 'caseworker', { orgId: 9, isSandbox: true });
    // Deterministic seed: keyed off the invite's token_hash, in-request.
    expect(mocks.seedSandboxCaseload).toHaveBeenCalledWith({
      ownerId: 42, ownerUsername: 'newclient', ownerRole: 'caseworker', orgId: 9,
      tokenHash: LIVE_SANDBOX_INVITE.token_hash,
    });
    expect(mocks.markSandboxInviteUsed).toHaveBeenCalledWith(21, 42, 9);
    expect(session.userId).toBe(42);
    expect(session.userRole).toBe('caseworker');
    expect(session.orgId).toBe(9);
    expect(session.isSandbox).toBe(true);
  });

  it('410s on a dead invite without creating anything', async () => {
    mocks.consumeSandboxInvite.mockResolvedValue(null);
    const res = await request(makeApp().app).post('/join-sandbox/dead').send(GOOD_BODY);
    expect(res.status).toBe(410);
    expect(mocks.createOrganization).not.toHaveBeenCalled();
    expect(mocks.createUser).not.toHaveBeenCalled();
  });

  it('seed failure compensates: deletes the owner, deletes the org, releases the invite', async () => {
    mocks.seedSandboxCaseload.mockRejectedValue(new Error('seed blew up'));
    const res = await request(makeApp().app).post('/join-sandbox/tok').send(GOOD_BODY);
    expect(res.status).toBe(500);
    expect(mocks.deleteUser).toHaveBeenCalledWith(42);
    expect(mocks.deleteSandboxOrganization).toHaveBeenCalledWith(9);
    expect(mocks.releaseSandboxInvite).toHaveBeenCalledWith(21);
    expect(mocks.markSandboxInviteUsed).not.toHaveBeenCalled();
  });

  it('duplicate username: 409, org deleted, invite released', async () => {
    mocks.createUser.mockRejectedValue(new Error('Username already exists'));
    const res = await request(makeApp().app).post('/join-sandbox/tok').send(GOOD_BODY);
    expect(res.status).toBe(409);
    expect(mocks.deleteSandboxOrganization).toHaveBeenCalledWith(9);
    expect(mocks.releaseSandboxInvite).toHaveBeenCalledWith(21);
    expect(mocks.seedSandboxCaseload).not.toHaveBeenCalled();
  });

  it('bookkeeping failure compensates seeded users too, in FK-safe order', async () => {
    mocks.markSandboxInviteUsed.mockRejectedValue(new Error('db down'));
    const res = await request(makeApp().app).post('/join-sandbox/tok').send(GOOD_BODY);
    expect(res.status).toBe(500);
    for (const seededId of SEED_RESULT.seededUserIds) {
      expect(mocks.deleteUser).toHaveBeenCalledWith(seededId);
    }
    expect(mocks.deleteUser).toHaveBeenCalledWith(42);
    expect(mocks.deleteSandboxOrganization).toHaveBeenCalledWith(9);
    expect(mocks.releaseSandboxInvite).toHaveBeenCalledWith(21);
  });

  it('400s on a short password before consuming the invite', async () => {
    const res = await request(makeApp().app).post('/join-sandbox/tok').send({ username: 'x', password: 'short' });
    expect(res.status).toBe(400);
    expect(mocks.consumeSandboxInvite).not.toHaveBeenCalled();
  });
});
