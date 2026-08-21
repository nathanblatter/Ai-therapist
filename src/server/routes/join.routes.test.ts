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
  assignClient: vi.fn(),
}));

vi.mock('../db/index.js', () => ({
  findInviteByToken: mocks.findInviteByToken,
  consumeInvite: mocks.consumeInvite,
  releaseInvite: mocks.releaseInvite,
  markInviteUsedBy: mocks.markInviteUsedBy,
  createUser: mocks.createUser,
  assignClient: mocks.assignClient,
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
const GOOD_BODY = { username: 'newclient', password: 'longenough1' };

beforeEach(() => {
  mocks.findInviteByToken.mockReset().mockResolvedValue(LIVE_INVITE);
  mocks.consumeInvite.mockReset().mockResolvedValue({ ...LIVE_INVITE, used_at: FUTURE });
  mocks.releaseInvite.mockReset().mockResolvedValue(undefined);
  mocks.markInviteUsedBy.mockReset().mockResolvedValue(undefined);
  mocks.createUser.mockReset().mockResolvedValue({ userid: 42, username: 'newclient', role: 'participant' });
  mocks.assignClient.mockReset().mockResolvedValue(undefined);
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
    expect(mocks.createUser).toHaveBeenCalledWith('newclient', 'longenough1', 'participant');
    expect(mocks.assignClient).toHaveBeenCalledWith(3, 42, 3);
    expect(mocks.markInviteUsedBy).toHaveBeenCalledWith(7, 42);
    // Session established like login.
    expect(session.userId).toBe(42);
    expect(session.username).toBe('newclient');
    expect(session.userRole).toBe('participant');
    expect(session.mfaVerified).toBe(true);
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
    expect((await request(app).post('/join/tok').send({ username: 'other', password: 'longenough1' })).status).toBe(410);
    expect(mocks.createUser).toHaveBeenCalledTimes(1);
  });

  it('400s on missing username/password or a too-short password, leaving the invite untouched', async () => {
    const { app } = makeApp();
    expect((await request(app).post('/join/tok').send({ username: 'x' })).status).toBe(400);
    expect((await request(app).post('/join/tok').send({ password: 'longenough1' })).status).toBe(400);
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
