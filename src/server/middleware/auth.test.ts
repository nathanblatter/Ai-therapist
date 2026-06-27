import { describe, it, expect, vi } from 'vitest';
import type { Request, Response, NextFunction } from 'express';
import { requireAuth, requireRole } from './auth.js';

function mockRes() {
  const res: Partial<Response> & { statusCode?: number; body?: unknown } = {};
  res.status = vi.fn((code: number) => {
    res.statusCode = code;
    return res as Response;
  }) as unknown as Response['status'];
  res.json = vi.fn((payload: unknown) => {
    res.body = payload;
    return res as Response;
  }) as unknown as Response['json'];
  return res as Response & { statusCode?: number; body?: unknown };
}

describe('requireAuth', () => {
  it('rejects unauthenticated requests with 401', () => {
    const req = { session: {} } as unknown as Request;
    const res = mockRes();
    const next = vi.fn() as NextFunction;

    requireAuth(req, res, next);

    expect(res.statusCode).toBe(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('calls next when a userId is present', () => {
    const req = { session: { userId: 42 } } as unknown as Request;
    const res = mockRes();
    const next = vi.fn() as NextFunction;

    requireAuth(req, res, next);

    expect(next).toHaveBeenCalledOnce();
    expect(res.statusCode).toBeUndefined();
  });
});

describe('requireRole', () => {
  it('returns 401 when not authenticated', () => {
    const req = { session: {} } as unknown as Request;
    const res = mockRes();
    const next = vi.fn() as NextFunction;

    requireRole('researcher')(req, res, next);

    expect(res.statusCode).toBe(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('returns 403 when the role is not allowed', () => {
    const req = { session: { userId: 1, userRole: 'therapist' } } as unknown as Request;
    const res = mockRes();
    const next = vi.fn() as NextFunction;

    requireRole('researcher')(req, res, next);

    expect(res.statusCode).toBe(403);
    expect(next).not.toHaveBeenCalled();
  });

  it('calls next when the role is allowed', () => {
    const req = { session: { userId: 1, userRole: 'researcher' } } as unknown as Request;
    const res = mockRes();
    const next = vi.fn() as NextFunction;

    requireRole('therapist', 'researcher')(req, res, next);

    expect(next).toHaveBeenCalledOnce();
    expect(res.statusCode).toBeUndefined();
  });
});
