// Invite links on a Cognito deployment (review C1, ai-therapist-396): a staff
// account gets an app session only from a verified sign-in that used an
// authenticator code. An invite route that stamped the session itself would
// hand out a staff session on a password alone, so for staff roles it
// creates the account and sends the person to sign in.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

const mocks = vi.hoisted(() => ({
  findInviteByToken: vi.fn(),
  consumeInvite: vi.fn(),
  releaseInvite: vi.fn(),
  completeInviteGrant: vi.fn(),
  getUserById: vi.fn(),
  findSandboxInviteByToken: vi.fn(),
  consumeSandboxInvite: vi.fn(),
  releaseSandboxInvite: vi.fn(),
  markSandboxInviteUsedAudited: vi.fn(),
  createOrganization: vi.fn(),
  deleteSandboxOrganization: vi.fn(),
  seedSandboxCaseload: vi.fn(),
  registerAccount: vi.fn(),
  removeAccount: vi.fn(),
  cognitoEnabled: vi.fn(() => true),
}));

vi.mock('../db/index.js', () => ({
  findInviteByToken: mocks.findInviteByToken,
  consumeInvite: mocks.consumeInvite,
  releaseInvite: mocks.releaseInvite,
  completeInviteGrant: mocks.completeInviteGrant,
  getUserById: mocks.getUserById,
  findSandboxInviteByToken: mocks.findSandboxInviteByToken,
  consumeSandboxInvite: mocks.consumeSandboxInvite,
  releaseSandboxInvite: mocks.releaseSandboxInvite,
  markSandboxInviteUsedAudited: mocks.markSandboxInviteUsedAudited,
  createOrganization: mocks.createOrganization,
  deleteSandboxOrganization: mocks.deleteSandboxOrganization,
}));
vi.mock('../services/sandboxSeed.js', () => ({ seedSandboxCaseload: mocks.seedSandboxCaseload }));
vi.mock('../services/accounts.service.js', () => ({
  registerAccount: mocks.registerAccount,
  removeAccount: mocks.removeAccount,
}));
vi.mock('../services/cognito.service.js', () => ({ enabled: mocks.cognitoEnabled }));

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
const INVITE = {
  invite_id: 7,
  token_hash: 'deadbeef',
  therapist_id: 3,
  label: 'JB',
  created_at: PAST,
  expires_at: FUTURE,
  used_at: null,
  used_by: null,
};
const SANDBOX_INVITE = {
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
const BODY = { username: 'newclient', password: 'longenough12' };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.cognitoEnabled.mockReturnValue(true);
  mocks.findInviteByToken.mockResolvedValue(INVITE);
  mocks.consumeInvite.mockResolvedValue({ ...INVITE, used_at: FUTURE });
  mocks.completeInviteGrant.mockResolvedValue(undefined);
  mocks.getUserById.mockResolvedValue({ userid: 3, username: 'dr_t', role: 'therapist', organization_id: 1 });
  mocks.findSandboxInviteByToken.mockResolvedValue(SANDBOX_INVITE);
  mocks.consumeSandboxInvite.mockResolvedValue({ ...SANDBOX_INVITE, used_at: FUTURE });
  mocks.markSandboxInviteUsedAudited.mockResolvedValue(undefined);
  mocks.createOrganization.mockResolvedValue({ org_id: 9, slug: 's', name: "newclient's Sandbox", kind: 'sandbox' });
  mocks.seedSandboxCaseload.mockResolvedValue({
    clientIds: [101],
    counterpartId: 110,
    seededUserIds: [101, 110],
    sessionCount: 5,
    rowCount: 40,
    escalationId: 5,
  });
});

describe('POST /join-sandbox/:token with Cognito signing people in', () => {
  const owner = { userid: 42, username: 'newclient', role: 'caseworker', organization_id: 9, is_sandbox: true };

  it('creates the staff account but no session, and says to sign in', async () => {
    mocks.registerAccount.mockResolvedValue(owner);
    const { app, session } = makeApp();
    const res = await request(app).post('/join-sandbox/raw-tok').send(BODY);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ success: true, signInRequired: true, user: { userid: 42, role: 'caseworker' } });
    expect(mocks.registerAccount).toHaveBeenCalled();
    expect(session.userId).toBeUndefined();
    expect(session.userRole).toBeUndefined();
    expect(session.mfaVerified).toBeUndefined();
  });

  it('still signs the account in when Cognito is off', async () => {
    mocks.cognitoEnabled.mockReturnValue(false);
    mocks.registerAccount.mockResolvedValue(owner);
    const { app, session } = makeApp();
    const res = await request(app).post('/join-sandbox/raw-tok').send(BODY);
    expect(res.body.signInRequired).toBeUndefined();
    expect(session.userId).toBe(42);
    expect(session.userRole).toBe('caseworker');
  });
});

describe('POST /join/:token with Cognito signing people in', () => {
  it('a participant invite still signs the new participant in (no second factor required)', async () => {
    mocks.registerAccount.mockResolvedValue({
      userid: 42,
      username: 'newclient',
      role: 'participant',
      organization_id: 1,
    });
    const { app, session } = makeApp();
    const res = await request(app).post('/join/raw-tok').send(BODY);
    expect(res.status).toBe(200);
    expect(res.body.signInRequired).toBeUndefined();
    expect(session.userId).toBe(42);
    expect(session.userRole).toBe('participant');
  });
});

describe('the join page script', () => {
  it('goes to the sign-in page when the server says a sign-in is required', async () => {
    const res = await request(makeApp().app).get('/join-sandbox/raw-tok');
    expect(res.status).toBe(200);
    expect(res.text).toContain("data.signInRequired ? '/login'");
  });
});
