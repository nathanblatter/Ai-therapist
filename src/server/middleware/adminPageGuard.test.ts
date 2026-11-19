// GET /admin for a signed-out browser: a crisis page SMS link tapped while
// signed out used to show `{"error":"Authentication required"}`. index.ts
// mounts `app.get('/admin', ...adminPageGuard, <serve admin.html>)` in both
// prod and dev; this mirrors that wiring next to a gated API route, with the
// session faked from a header (no session store, no database).
import { describe, it, expect, vi } from 'vitest';
import express, { type NextFunction, type Request, type Response } from 'express';
import request from 'supertest';
import { adminPageGuard, requireRole, signedOutPageToLogin } from './auth.js';

const ADMIN_HTML = '<!doctype html><title>admin shell</title>';
// What a browser sends for a top-level navigation (Chrome / Safari).
const BROWSER_ACCEPT = 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8';

function makeApp() {
  const app = express();
  app.use((req, _res, next) => {
    const raw = req.get('x-test-session');
    (req as unknown as { session: object }).session = raw ? JSON.parse(raw) : {};
    next();
  });
  const served = vi.fn();
  app.get('/admin', ...adminPageGuard, (_req, res) => {
    served();
    res.status(200).type('html').send(ADMIN_HTML);
  });
  app.get('/admin/api/sessions', requireRole('therapist', 'researcher'), (_req, res) => res.json({ sessions: [] }));
  return { app, served };
}

const staff = (role: string) => JSON.stringify({ userId: 5, userRole: role });

describe('GET /admin, signed out', () => {
  it('a browser page load is redirected to the sign-in page', async () => {
    const { app, served } = makeApp();
    const res = await request(app).get('/admin').set('Accept', BROWSER_ACCEPT);
    expect(res.status).toBe(302);
    // No fragment in Location, so the browser keeps the link's own hash.
    expect(res.headers.location).toBe('/login');
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.text).not.toContain('admin shell');
    expect(served).not.toHaveBeenCalled();
  });

  it('a HEAD page load is redirected too', async () => {
    const { app } = makeApp();
    const res = await request(app).head('/admin').set('Accept', 'text/html');
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/login');
  });

  it.each([
    ['application/json', 'application/json'],
    ['*/* (fetch default)', '*/*'],
    ['JSON preferred over HTML', 'application/json, text/html;q=0.5'],
  ])('Accept %s keeps the 401 JSON', async (_label, accept) => {
    const { app, served } = makeApp();
    const res = await request(app).get('/admin').set('Accept', accept);
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: 'Authentication required' });
    expect(res.headers.location).toBeUndefined();
    expect(served).not.toHaveBeenCalled();
  });

  it('no Accept header keeps the 401 JSON', async () => {
    const { app } = makeApp();
    const res = await request(app).get('/admin').unset('Accept');
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: 'Authentication required' });
  });

  it('an API route asked for HTML still answers 401 JSON', async () => {
    const { app } = makeApp();
    const res = await request(app).get('/admin/api/sessions').set('Accept', BROWSER_ACCEPT);
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: 'Authentication required' });
    expect(res.headers.location).toBeUndefined();
  });
});

describe('GET /admin, signed in', () => {
  it.each(['participant', 'unknown-role'])('a %s is refused with the 403 JSON, not redirected', async (role) => {
    const { app, served } = makeApp();
    const res = await request(app).get('/admin').set('Accept', BROWSER_ACCEPT).set('x-test-session', staff(role));
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: 'Insufficient permissions' });
    expect(res.headers.location).toBeUndefined();
    expect(served).not.toHaveBeenCalled();
  });

  it.each(['therapist', 'caseworker', 'researcher', 'demo'])(
    'a %s is served the admin page as before',
    async (role) => {
      const { app, served } = makeApp();
      const res = await request(app).get('/admin').set('Accept', BROWSER_ACCEPT).set('x-test-session', staff(role));
      expect(res.status).toBe(200);
      expect(res.text).toBe(ADMIN_HTML);
      expect(served).toHaveBeenCalledOnce();
    },
  );
});

describe('signedOutPageToLogin', () => {
  const run = (req: Partial<Request>) => {
    const redirect = vi.fn();
    const res = { set: vi.fn(), redirect } as unknown as Response;
    const next = vi.fn() as NextFunction;
    const accepts = vi.fn(() => 'html');
    signedOutPageToLogin({ accepts, ...req } as unknown as Request, res, next);
    return { redirect, next };
  };

  it('passes a POST through to the role check', () => {
    const { redirect, next } = run({ method: 'POST', session: {} as Request['session'] });
    expect(redirect).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledOnce();
  });

  it('passes a signed-in page load through to the role check', () => {
    const { redirect, next } = run({ method: 'GET', session: { userId: 1 } as unknown as Request['session'] });
    expect(redirect).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledOnce();
  });
});
