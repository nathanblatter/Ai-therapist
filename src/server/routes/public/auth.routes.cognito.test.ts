// With Cognito configured (ai-therapist-387) the legacy password login must
// refuse before it looks at the local hash: the password of record lives in
// the study's user pool, and a stale local copy must never sign anyone in.
import { describe, it, expect, vi } from 'vitest';
import express from 'express';
import session from 'express-session';
import request from 'supertest';

vi.stubEnv('COGNITO_USER_POOL_ID', 'us-west-1_TestPool1');
vi.stubEnv('COGNITO_CLIENT_ID', 'client123');
vi.stubEnv('COGNITO_DOMAIN', 'https://study-test.auth.us-west-1.amazoncognito.com');
vi.stubEnv('APP_URL', 'https://app.test');

const dbMocks = vi.hoisted(() => ({
  verifyCredentials: vi.fn(),
  createUser: vi.fn(),
}));
vi.mock('../../db/index.js', () => dbMocks);

const { default: authRoutes } = await import('./auth.routes.js');

describe('POST /api/auth/login with Cognito configured', () => {
  it('answers 410 without checking the local password', async () => {
    dbMocks.verifyCredentials.mockResolvedValue({ userid: 1, username: 'nathan', role: 'researcher' });
    const app = express();
    app.use(express.json());
    app.use(session({ secret: 'test', resave: false, saveUninitialized: true }));
    app.use(authRoutes());
    const res = await request(app).post('/api/auth/login').send({ username: 'nathan', password: 'correct-horse' });
    expect(res.status).toBe(410);
    expect(res.body.code).toBe('use_cognito');
    expect(dbMocks.verifyCredentials).not.toHaveBeenCalled();
  });
});
