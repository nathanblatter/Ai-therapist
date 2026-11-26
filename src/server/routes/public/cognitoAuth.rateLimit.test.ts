// Rate limits on the Cognito sign-in routes (ai-therapist-411): each start
// writes a session row and each enrolment call reaches the pool, so one
// address cannot call them without bound.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import session from 'express-session';
import request from 'supertest';

vi.stubEnv('COGNITO_USER_POOL_ID', 'us-west-1_TestPool1');
vi.stubEnv('COGNITO_CLIENT_ID', 'client123');
vi.stubEnv('COGNITO_DOMAIN', 'https://study-test.auth.us-west-1.amazoncognito.com');
vi.stubEnv('APP_URL', 'https://app.test');

vi.mock('../../db/index.js', () => ({}));
const adminMocks = vi.hoisted(() => ({ getTotpEnabled: vi.fn(), beginTotpEnrolment: vi.fn() }));
vi.mock('../../services/cognitoAdmin.service.js', () => adminMocks);
vi.mock('../../services/mfa.service.js', () => ({ generateQRCode: vi.fn() }));
vi.mock('../../services/researcherEmail.service.js', () => ({ clearEmailIfIneligible: vi.fn() }));

const { default: cognitoAuthRoutes, SIGN_IN_LIMIT, ENROL_LIMIT } = await import('./cognitoAuth.routes.js');

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use(session({ secret: 'test', resave: false, saveUninitialized: false }));
  // A fresh router has fresh counters.
  app.use(cognitoAuthRoutes());
  return app;
}

beforeEach(() => vi.clearAllMocks());

describe('Cognito sign-in rate limits', () => {
  it('lets a campus-sized burst of sign-in starts through, then sends the browser back with a reason', async () => {
    const app = makeApp();
    let last = await request(app).get('/api/auth/cognito/start');
    for (let i = 1; i < SIGN_IN_LIMIT; i++) last = await request(app).get('/api/auth/cognito/start');
    expect(new URL(last.headers.location).pathname).toBe('/oauth2/authorize');
    const over = await request(app).get('/api/auth/cognito/start');
    expect(over.status).toBe(302);
    expect(over.headers.location).toBe('/login?error=too_many_attempts');
  });

  it('answers the enrolment calls with 429 once one address has made too many', async () => {
    const app = makeApp();
    for (let i = 0; i < ENROL_LIMIT; i++) {
      // No held sign-in: each of these is the ordinary 401.
      expect((await request(app).post('/api/auth/cognito/totp/verify').send({ code: '123456' })).status).toBe(401);
    }
    const over = await request(app).post('/api/auth/cognito/totp/verify').send({ code: '123456' });
    expect(over.status).toBe(429);
    expect(over.body.code).toBe('too_many_attempts');
    expect((await request(app).post('/api/auth/cognito/totp/begin')).status).toBe(429);
  });

  it('keeps the limits generous enough for a shared address', () => {
    expect(SIGN_IN_LIMIT).toBeGreaterThanOrEqual(200);
    expect(ENROL_LIMIT).toBeGreaterThanOrEqual(8 * 4);
  });
});
