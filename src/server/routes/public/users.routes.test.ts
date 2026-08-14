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
    req.session = { userId, userRole: role, username: 'someone' } as unknown as typeof req.session;
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
});

describe('demo write guard on /api/users (defense-in-depth)', () => {
  it('swallows a demo self-edit PUT without touching the db', async () => {
    const res = await request(appAs('demo'))
      .put('/api/users/4242')
      .send({ username: 'persisted_evil' });
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
    const res = await request(appAs('demo'))
      .put('/api/users/preferences/theme')
      .send({ theme: 'dark' });
    expect(res.status).toBe(200);
    expect(dbMocks.setUserPreferredTheme).toHaveBeenCalledWith(4242, 'dark');
  });

  it('does not affect non-demo writes (researcher edit reaches the real handler)', async () => {
    const res = await request(appAs('researcher', 1))
      .put('/api/users/4242')
      .send({ username: 'renamed' });
    expect(res.status).toBe(200);
    expect(dbMocks.updateUser).toHaveBeenCalledWith('4242', { username: 'renamed' });
  });
});
