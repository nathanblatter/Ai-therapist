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

  it('lets therapists and researchers through from outside the US', () => {
    expect(run(mockReq('81.2.69.142', { userRole: 'therapist' })).next).toHaveBeenCalledOnce();
    expect(run(mockReq('81.2.69.142', { userRole: 'researcher' })).next).toHaveBeenCalledOnce();
  });

  it('skips the check for admin, login and static asset paths', () => {
    for (const path of ['/admin/dashboard', '/api/auth/login', '/api/auth/logout', '/assets/app.js']) {
      expect(run(mockReq('81.2.69.142', { path })).next).toHaveBeenCalledOnce();
    }
  });
});
