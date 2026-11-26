// The app's own authenticator screens under Cognito sign-in (ai-therapist-396,
// 397): nothing checks the local secret then, and confirming with the local
// password would be a second password check, so setup, disable and backup
// codes are refused and status says who holds the authenticator.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

const cognito = vi.hoisted(() => ({ enabled: vi.fn(() => true) }));
vi.mock('../../services/cognito.service.js', () => cognito);

const mfa = vi.hoisted(() => ({
  getMFAStatus: vi.fn(),
  generateMFASecret: vi.fn(),
  generateQRCode: vi.fn(),
  verifyTOTP: vi.fn(),
  generateBackupCodes: vi.fn(),
  enableMFA: vi.fn(),
  disableMFA: vi.fn(),
  updateBackupCodes: vi.fn(),
}));
vi.mock('../../services/mfa.service.js', () => mfa);

const db = vi.hoisted(() => ({ verifyCredentials: vi.fn() }));
vi.mock('../../db/index.js', () => db);

const { default: mfaRoutes } = await import('./mfa.routes.js');

function appAs(role: string) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.session = { userId: 5, userRole: role, username: 'dr_one' } as unknown as typeof req.session;
    next();
  });
  app.use(mfaRoutes());
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
  cognito.enabled.mockReturnValue(true);
});

describe('with Cognito signing people in', () => {
  it.each([
    ['/api/mfa/setup/init', {}],
    ['/api/mfa/setup/verify', { token: '123456' }],
    ['/api/mfa/disable', { password: 'whatever it is' }],
    ['/api/mfa/regenerate-backup-codes', { password: 'whatever it is' }],
  ])('refuses POST %s without touching the local secret or the local password', async (path, body) => {
    const res = await request(appAs('researcher')).post(path).send(body);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('managed_by_cognito');
    expect(db.verifyCredentials).not.toHaveBeenCalled();
    for (const fn of Object.values(mfa)) expect(fn).not.toHaveBeenCalled();
  });

  it.each([
    ['therapist', true],
    ['researcher', true],
    ['caseworker', true],
    ['participant', false],
  ])('status for %s says the sign-in service holds the authenticator (required: %s)', async (role, required) => {
    const res = await request(appAs(role)).get('/api/mfa/status');
    expect(res.status).toBe(200);
    expect(res.body.mfa).toEqual({ enabled: required, backupCodesRemaining: 0, managedBy: 'cognito' });
    expect(mfa.getMFAStatus).not.toHaveBeenCalled();
  });
});

describe('without Cognito (unchanged)', () => {
  beforeEach(() => cognito.enabled.mockReturnValue(false));

  it('status comes from the local record, without the secret', async () => {
    mfa.getMFAStatus.mockResolvedValue({ enabled: true, backupCodesRemaining: 7, secret: 'S3CRET' });
    const res = await request(appAs('researcher')).get('/api/mfa/status');
    expect(res.body.mfa).toEqual({ enabled: true, backupCodesRemaining: 7 });
  });

  it('disable still confirms with the password', async () => {
    db.verifyCredentials.mockResolvedValue(null);
    const res = await request(appAs('researcher')).post('/api/mfa/disable').send({ password: 'wrong' });
    expect(res.status).toBe(401);
    expect(mfa.disableMFA).not.toHaveBeenCalled();
  });
});
