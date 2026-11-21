import { describe, it, expect, vi } from 'vitest';
import type { Request, Response } from 'express';

// Uses the real geoip-lite data files (no mock) so a dependency bump that
// changes the lookup API, the bundled data or IPv4-mapped IPv6 handling is
// caught here rather than on stage.
import { restrictParticipantsToUs } from './ipFilter.js';

function mockReq(ip: string | undefined, opts: { path?: string; userRole?: string } = {}): Request {
  return {
    ip,
    path: opts.path ?? '/api/chat',
    socket: { remoteAddress: undefined },
    session: opts.userRole ? { userRole: opts.userRole } : {},
  } as unknown as Request;
}

function mockRes() {
  const res: Partial<Response> = {};
  res.status = vi.fn().mockReturnValue(res);
  res.json = vi.fn().mockReturnValue(res);
  return res as Response;
}

function run(req: Request) {
  const res = mockRes();
  const next = vi.fn();
  restrictParticipantsToUs(req, res, next);
  return { res, next };
}

describe('restrictParticipantsToUs', () => {
  it.each([
    ['US IPv4', '8.8.8.8'],
    ['US IPv4-mapped IPv6', '::ffff:8.8.8.8'],
    ['US IPv6', '2001:4860:4860::8888'],
    ['loopback IPv4', '127.0.0.1'],
    ['loopback IPv6', '::1'],
  ])('allows a participant from %s', (_label, ip) => {
    const { res, next } = run(mockReq(ip));
    expect(next).toHaveBeenCalledOnce();
    expect(res.status).not.toHaveBeenCalled();
  });

  it.each([
    ['GB IPv4', '81.2.69.142'],
    ['JP IPv4', '133.242.0.3'],
    ['private (unresolvable) IPv4', '10.0.0.1'],
    ['malformed address', 'not-an-ip'],
  ])('blocks a participant from %s with 403', (_label, ip) => {
    const { res, next } = run(mockReq(ip));
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ error: 'Access Restricted' }));
  });

  // ai-therapist-325: the caseworker role was missing, so a caseworker abroad
  // got 403 on /api/auth/status and the admin app never loaded.
  it.each(['therapist', 'researcher', 'caseworker'])('lets a %s through from outside the US', (userRole) => {
    for (const path of ['/api/auth/status', '/api/admin/messaging/inbox']) {
      const { res, next } = run(mockReq('81.2.69.142', { userRole, path }));
      expect(next).toHaveBeenCalledOnce();
      expect(res.status).not.toHaveBeenCalled();
    }
  });

  it.each(['participant', 'demo'])('still blocks a signed-in %s from outside the US', (userRole) => {
    const { res, next } = run(mockReq('81.2.69.142', { userRole, path: '/api/auth/status' }));
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
  });

  it('skips the check for admin, login and static asset paths', () => {
    for (const path of ['/admin/dashboard', '/api/auth/login', '/api/auth/logout', '/assets/app.js']) {
      expect(run(mockReq('81.2.69.142', { path })).next).toHaveBeenCalledOnce();
    }
  });
});
