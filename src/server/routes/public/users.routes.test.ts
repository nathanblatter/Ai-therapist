// Defense-in-depth demo guard on the REAL /api/users router (pass-5 review):
// even if the demo interceptor (demo.routes.ts) were bypassed via a path
// variant, this router must swallow every non-GET request from a 'demo'
// session before any real user mutation runs. Preference writes stay real for
// demo accounts on purpose.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

const dbMocks = vi.hoisted(() => ({
  getAllUsers: vi.fn(),
  getUserById: vi.fn(),
  updateUser: vi.fn(),
  deleteUser: vi.fn(),
  createUser: vi.fn(),
  getUserPreferences: vi.fn(),
  updateUserPreferences: vi.fn(),
  setUserPreferredTheme: vi.fn(),
  getUserMemoryEnabled: vi.fn(),
  setUserMemoryEnabled: vi.fn(),
  setUserEmail: vi.fn(),
  findUserByEmail: vi.fn(),
  listEmailsWithPrefix: vi.fn(),
  insertAccountAudit: vi.fn(),
  listAccountAudit: vi.fn(),
}));
vi.mock('../../db/index.js', () => dbMocks);
vi.mock('../../utils/sessionHelpers.js', () => ({
  getSystemConfig: vi.fn().mockResolvedValue({}),
}));

import usersRoutes from './users.routes.js';

function appAs(role: string, userId = 4242) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.session = { userId, userRole: role, username: 'someone', orgId: 1 } as unknown as typeof req.session;
    next();
  });
  app.use(usersRoutes());
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
  dbMocks.updateUser.mockResolvedValue({ userid: 4242, username: 'renamed', role: 'demo' });
  dbMocks.deleteUser.mockResolvedValue({ username: 'gone' });
  dbMocks.createUser.mockResolvedValue({ userid: 1, username: 'x', role: 'participant' });
  dbMocks.setUserPreferredTheme.mockResolvedValue(undefined);
  // The account a by-id route acts on, in the caller's organisation (1).
  dbMocks.getUserById.mockResolvedValue({ userid: 5, username: 'u5', role: 'participant', organization_id: 1 });
});

describe('demo write guard on /api/users (defense-in-depth)', () => {
  it('swallows a demo self-edit PUT without touching the db', async () => {
    const res = await request(appAs('demo')).put('/api/users/4242').send({ username: 'persisted_evil' });
    expect(res.status).toBe(200);
    expect(res.body.demo).toBe(true);
    expect(dbMocks.updateUser).not.toHaveBeenCalled();
  });

  it('swallows trailing-slash and case variants too', async () => {
    for (const path of ['/api/users/4242/', '/API/users/4242', '/api/USERS/4242/']) {
      const res = await request(appAs('demo')).put(path).send({ username: 'evil' });
      expect(res.status).toBe(200);
      expect(res.body.demo).toBe(true);
    }
    expect(dbMocks.updateUser).not.toHaveBeenCalled();
  });

  it('swallows demo DELETE and POST', async () => {
    const del = await request(appAs('demo')).delete('/api/users/7');
    expect(del.status).toBe(200);
    expect(del.body.demo).toBe(true);
    const post = await request(appAs('demo'))
      .post('/api/users')
      .send({ username: 'x', password: 'y', role: 'participant' });
    expect(post.status).toBe(200);
    expect(post.body.demo).toBe(true);
    expect(dbMocks.deleteUser).not.toHaveBeenCalled();
    expect(dbMocks.createUser).not.toHaveBeenCalled();
  });

  it('lets demo preference writes through (harmless, intentionally real)', async () => {
    const res = await request(appAs('demo')).put('/api/users/preferences/theme').send({ theme: 'dark' });
    expect(res.status).toBe(200);
    expect(dbMocks.setUserPreferredTheme).toHaveBeenCalledWith(4242, 'dark');
  });

  it('does not affect non-demo writes (researcher edit reaches the real handler)', async () => {
    const res = await request(appAs('researcher', 1)).put('/api/users/4242').send({ username: 'renamed' });
    expect(res.status).toBe(200);
    expect(dbMocks.updateUser).toHaveBeenCalledWith('4242', { username: 'renamed' });
  });
});

describe('PUT /api/users/:userid role validation', () => {
  it('rejects a role outside the assignable allowlist (same list as POST)', async () => {
    for (const bad of ['demo', 'admin', 'superuser', '']) {
      const res = await request(appAs('researcher', 1)).put('/api/users/4242').send({ role: bad });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('Invalid role');
    }
    expect(dbMocks.updateUser).not.toHaveBeenCalled();
  });

  it('accepts a valid role change from a researcher', async () => {
    dbMocks.updateUser.mockResolvedValue({ userid: 4242, username: 'u', role: 'caseworker' });
    const res = await request(appAs('researcher', 1)).put('/api/users/4242').send({ role: 'caseworker' });
    expect(res.status).toBe(200);
    expect(dbMocks.updateUser).toHaveBeenCalledWith('4242', { role: 'caseworker' });
  });
});

describe('staff email (ai-therapist-283 phase 1)', () => {
  beforeEach(() => {
    dbMocks.findUserByEmail.mockResolvedValue(null);
    dbMocks.listEmailsWithPrefix.mockResolvedValue([]);
    dbMocks.setUserEmail.mockImplementation(async (userid: number, email: string | null) => ({
      userid,
      username: 'ra',
      role: 'researcher',
      email,
    }));
  });

  it('a researcher can set a staff address through PUT', async () => {
    dbMocks.getUserById.mockResolvedValue({ userid: 5, username: 'ra', role: 'researcher', organization_id: 1 });
    const res = await request(appAs('researcher')).put('/api/users/5').send({ email: 'RA@byuisresearch.com' });
    expect(res.status).toBe(200);
    expect(dbMocks.setUserEmail).toHaveBeenCalledWith(5, 'ra@byuisresearch.com');
    expect(dbMocks.updateUser).not.toHaveBeenCalled();
  });

  it('a non-researcher cannot change an address, even their own', async () => {
    const res = await request(appAs('therapist', 5)).put('/api/users/5').send({ email: 'me@byuisresearch.com' });
    expect(res.status).toBe(403);
    expect(dbMocks.setUserEmail).not.toHaveBeenCalled();
  });

  it('participants never get an address', async () => {
    dbMocks.getUserById.mockResolvedValue({ userid: 8, username: 'p8', role: 'participant', organization_id: 1 });
    const res = await request(appAs('researcher')).put('/api/users/8').send({ email: 'p8@byuisresearch.com' });
    expect(res.status).toBe(403);
    const prov = await request(appAs('researcher')).post('/api/users/8/provision-email');
    expect(prov.status).toBe(403);
    expect(dbMocks.setUserEmail).not.toHaveBeenCalled();
  });

  it('a rejected email leaves the rest of the edit unapplied', async () => {
    dbMocks.getUserById.mockResolvedValue({ userid: 5, username: 'ra', role: 'researcher', organization_id: 1 });
    dbMocks.findUserByEmail.mockResolvedValue({ userid: 9, username: 'other', role: 'therapist' });
    const res = await request(appAs('researcher'))
      .put('/api/users/5')
      .send({ username: 'ra', role: 'therapist', email: 'taken@byuisresearch.com' });
    expect(res.status).toBe(409);
    expect(dbMocks.updateUser).not.toHaveBeenCalled();
    expect(dbMocks.setUserEmail).not.toHaveBeenCalled();
  });

  it('demoting a staff account to participant clears its address', async () => {
    dbMocks.getUserById.mockResolvedValue({
      userid: 5,
      username: 'cw',
      role: 'caseworker',
      email: 'cw@byuisresearch.com',
      organization_id: 1,
    });
    const res = await request(appAs('researcher')).put('/api/users/5').send({ username: 'cw', role: 'participant' });
    expect(res.status).toBe(200);
    expect(dbMocks.setUserEmail).toHaveBeenCalledWith('5', null);
  });

  it('provision-email assigns <slug>@byuisresearch.com', async () => {
    dbMocks.getUserById.mockResolvedValue({ userid: 5, username: 'Jane Doe', role: 'therapist', organization_id: 1 });
    const res = await request(appAs('researcher')).post('/api/users/5/provision-email');
    expect(res.status).toBe(200);
    expect(res.body.email).toBe('jane-doe@byuisresearch.com');
    expect(dbMocks.setUserEmail).toHaveBeenCalledWith(5, 'jane-doe@byuisresearch.com');
  });
});

describe('POST /api/users/:userid/reset-authenticator (ai-therapist-396)', () => {
  /** A researcher in organisation `orgId`. */
  function researcherIn(orgId: number) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.session = { userId: 1, userRole: 'researcher', username: 'r1', orgId } as unknown as typeof req.session;
      next();
    });
    app.use(usersRoutes());
    return app;
  }
  const post = (app: express.Express, id = 7) =>
    request(app).post(`/api/users/${id}/reset-authenticator`).set('Content-Type', 'application/json').send({});

  beforeEach(() => {
    dbMocks.getUserById.mockResolvedValue({ userid: 7, username: 'dr_one', role: 'therapist', organization_id: 3 });
  });

  it('is researcher-only', async () => {
    for (const role of ['therapist', 'caseworker', 'participant']) {
      const res = await request(appAs(role)).post('/api/users/7/reset-authenticator').send({});
      expect(res.status).toBe(403);
    }
  });

  it('refuses a request that is not JSON (a cross-site form cannot send one)', async () => {
    const res = await request(researcherIn(3)).post('/api/users/7/reset-authenticator');
    expect(res.status).toBe(415);
    const form = await request(researcherIn(3)).post('/api/users/7/reset-authenticator').type('form').send('a=1');
    expect(form.status).toBe(415);
    expect(dbMocks.getUserById).not.toHaveBeenCalled();
  });

  it('answers 404 for an unknown account and for an account in another organisation', async () => {
    dbMocks.getUserById.mockResolvedValueOnce(null);
    expect((await post(researcherIn(3), 999)).status).toBe(404);
    // Same answer as "unknown": a researcher cannot probe another organisation's accounts.
    expect((await post(researcherIn(4))).status).toBe(404);
  });

  it('answers 502 with the reason when no sign-in service holds authenticators here', async () => {
    const res = await post(researcherIn(3));
    expect(res.status).toBe(502);
    expect(res.body.error).toMatch(/not managed by the sign-in service/);
  });
});

describe('a researcher reaches accounts in their own organisation only (ai-therapist-411)', () => {
  // appAs() puts the caller in organisation 1.
  const OTHER = { userid: 77, username: 'other_org_staff', role: 'therapist', organization_id: 2 };

  beforeEach(() => {
    dbMocks.getUserById.mockResolvedValue(OTHER);
  });

  it('cannot read an account in another organisation', async () => {
    const res = await request(appAs('researcher')).get('/api/users/77');
    expect(res.status).toBe(404);
    expect(res.body.user).toBeUndefined();
  });

  it('cannot re-password, re-role or rename one', async () => {
    for (const body of [{ password: 'a long enough passphrase' }, { role: 'participant' }, { username: 'mine_now' }]) {
      const res = await request(appAs('researcher')).put('/api/users/77').send(body);
      expect(res.status).toBe(404);
    }
    expect(dbMocks.updateUser).not.toHaveBeenCalled();
  });

  it('cannot delete one', async () => {
    const res = await request(appAs('researcher')).delete('/api/users/77');
    expect(res.status).toBe(404);
    expect(dbMocks.deleteUser).not.toHaveBeenCalled();
  });

  it('cannot give one a study address', async () => {
    const res = await request(appAs('researcher')).post('/api/users/77/provision-email').send({});
    expect(res.status).toBe(404);
    expect(dbMocks.setUserEmail).not.toHaveBeenCalled();
  });

  it('answers the same for an id that does not exist', async () => {
    dbMocks.getUserById.mockResolvedValue(null);
    expect((await request(appAs('researcher')).get('/api/users/999')).status).toBe(404);
    expect((await request(appAs('researcher')).delete('/api/users/999')).status).toBe(404);
    expect(dbMocks.deleteUser).not.toHaveBeenCalled();
  });

  it('still reaches an account in its own organisation', async () => {
    dbMocks.getUserById.mockResolvedValue({ ...OTHER, organization_id: 1 });
    expect((await request(appAs('researcher')).get('/api/users/77')).status).toBe(200);
    const del = await request(appAs('researcher')).delete('/api/users/77');
    expect(del.status).toBe(200);
    expect(dbMocks.deleteUser).toHaveBeenCalled();
  });

  it('anyone can still read and edit their own account, whatever organisation the row says', async () => {
    dbMocks.getUserById.mockResolvedValue({
      userid: 4242,
      username: 'someone',
      role: 'participant',
      organization_id: 9,
    });
    dbMocks.updateUser.mockResolvedValue({ userid: 4242, username: 'someone', role: 'participant' });
    expect((await request(appAs('participant')).get('/api/users/4242')).status).toBe(200);
    const put = await request(appAs('participant'))
      .put('/api/users/4242')
      .send({ password: 'a long enough passphrase' });
    expect(put.status).toBe(200);
  });
});

describe('account changes are written to the audit trail (ai-therapist-411)', () => {
  // appAs('researcher') is user 4242 "someone" in organisation 1.
  const audited = () => dbMocks.insertAccountAudit.mock.calls.map((c) => c[0]);
  const TARGET = { userid: 5, username: 'u5', role: 'participant', organization_id: 1 };

  beforeEach(() => {
    dbMocks.getUserById.mockResolvedValue(TARGET);
    dbMocks.updateUser.mockResolvedValue({ ...TARGET });
  });

  it('a save that changes nothing but the password records the password change only', async () => {
    // The form sends the same username and role with every save.
    const res = await request(appAs('researcher'))
      .put('/api/users/5')
      .send({ username: 'u5', role: 'participant', password: 'a long enough passphrase' });
    expect(res.status).toBe(200);
    expect(audited()).toEqual([
      expect.objectContaining({
        action: 'password_changed',
        targetUserId: 5,
        targetUsername: 'u5',
        organizationId: 1,
        actorUserId: 4242,
        actorUsername: 'someone',
      }),
    ]);
    // Never the password itself.
    expect(JSON.stringify(audited())).not.toContain('a long enough passphrase');
  });

  it('a role change records the role before and after', async () => {
    dbMocks.updateUser.mockResolvedValue({ ...TARGET, role: 'therapist' });
    await request(appAs('researcher')).put('/api/users/5').send({ username: 'u5', role: 'therapist' });
    expect(audited()).toEqual([
      expect.objectContaining({ action: 'role_changed', detail: { from: 'participant', to: 'therapist' } }),
    ]);
  });

  it("a rename records both names, and a self password change is marked as the person's own", async () => {
    dbMocks.updateUser.mockResolvedValue({ ...TARGET, username: 'u5b' });
    await request(appAs('researcher')).put('/api/users/5').send({ username: 'u5b' });
    expect(audited()[0]).toMatchObject({ action: 'username_changed', detail: { from: 'u5', to: 'u5b' } });

    dbMocks.insertAccountAudit.mockClear();
    dbMocks.getUserById.mockResolvedValue({
      userid: 4242,
      username: 'someone',
      role: 'participant',
      organization_id: 1,
    });
    dbMocks.updateUser.mockResolvedValue({ userid: 4242, username: 'someone', role: 'participant' });
    await request(appAs('participant')).put('/api/users/4242').send({ password: 'a long enough passphrase' });
    expect(audited()).toEqual([
      expect.objectContaining({
        action: 'password_changed',
        actorUserId: 4242,
        targetUserId: 4242,
        detail: { self: true },
      }),
    ]);
  });

  it('an email change records that an address was set or cleared, not the address', async () => {
    dbMocks.getUserById.mockResolvedValue({ userid: 5, username: 'ra', role: 'researcher', organization_id: 1 });
    dbMocks.findUserByEmail.mockResolvedValue(null);
    dbMocks.setUserEmail.mockResolvedValue({
      userid: 5,
      username: 'ra',
      role: 'researcher',
      email: 'ra@byuisresearch.com',
    });
    await request(appAs('researcher')).put('/api/users/5').send({ email: 'ra@byuisresearch.com' });
    const rows = audited().filter((r) => r.action === 'email_changed');
    expect(rows).toEqual([expect.objectContaining({ detail: { set: true } })]);
    expect(JSON.stringify(audited())).not.toContain('byuisresearch.com');
  });

  it('a creation and a deletion are recorded with the role', async () => {
    dbMocks.createUser.mockResolvedValue({ userid: 9, username: 'new_p', role: 'participant', organization_id: 1 });
    await request(appAs('researcher'))
      .post('/api/users')
      .send({ username: 'new_p', password: 'a long enough passphrase', role: 'participant' });
    expect(audited()[0]).toMatchObject({
      action: 'account_created',
      targetUserId: 9,
      detail: { role: 'participant', via: 'user_management' },
    });

    dbMocks.insertAccountAudit.mockClear();
    dbMocks.deleteUser.mockResolvedValue({ userid: 5, username: 'u5' });
    await request(appAs('researcher')).delete('/api/users/5');
    expect(audited()).toEqual([
      expect.objectContaining({
        action: 'account_deleted',
        targetUserId: 5,
        targetUsername: 'u5',
        detail: { role: 'participant' },
      }),
    ]);
  });

  it('nothing is recorded for a refused change', async () => {
    dbMocks.getUserById.mockResolvedValue({ ...TARGET, organization_id: 2 });
    await request(appAs('researcher')).put('/api/users/5').send({ role: 'therapist' });
    await request(appAs('researcher')).delete('/api/users/5');
    await request(appAs('therapist')).put('/api/users/5').send({ password: 'a long enough passphrase' });
    expect(dbMocks.insertAccountAudit).not.toHaveBeenCalled();
  });
});

describe('GET /api/users/audit', () => {
  it('is researcher-only and returns the caller\'s own organisation, not an account called "audit"', async () => {
    dbMocks.listAccountAudit.mockResolvedValue([{ audit_id: 1, action: 'role_changed' }]);
    for (const role of ['therapist', 'caseworker', 'participant']) {
      expect((await request(appAs(role)).get('/api/users/audit')).status).toBe(403);
    }
    const res = await request(appAs('researcher')).get('/api/users/audit?limit=25');
    expect(res.status).toBe(200);
    expect(res.body.audit).toEqual([{ audit_id: 1, action: 'role_changed' }]);
    expect(dbMocks.listAccountAudit).toHaveBeenCalledWith(1, 25);
    expect(dbMocks.getUserById).not.toHaveBeenCalled();
  });
});
