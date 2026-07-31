import { describe, it, expect, vi } from 'vitest';
import type { Request, Response } from 'express';
import { requireConsent } from './consent.js';
import { CURRENT_CONSENT_VERSION } from '../utils/consent.js';

function mockRes() {
  const res: Partial<Response> = {};
  res.status = vi.fn().mockReturnValue(res);
  res.json = vi.fn().mockReturnValue(res);
  return res as Response;
}

describe('requireConsent', () => {
  it('calls next() when consent was accepted at the current version', () => {
    const req = { session: { consentAccepted: true, consentVersion: CURRENT_CONSENT_VERSION } } as unknown as Request;
    const res = mockRes();
    const next = vi.fn();

    requireConsent(req, res, next);

    expect(next).toHaveBeenCalledOnce();
    expect(res.status).not.toHaveBeenCalled();
  });

  it('blocks with 412 when consent was never accepted', () => {
    const req = { session: {} } as unknown as Request;
    const res = mockRes();
    const next = vi.fn();

    requireConsent(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(412);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ error: 'consent_required', currentVersion: CURRENT_CONSENT_VERSION })
    );
  });

  it('blocks with 412 when consent was accepted at a stale version', () => {
    const req = { session: { consentAccepted: true, consentVersion: '2020-01-01.1' } } as unknown as Request;
    const res = mockRes();
    const next = vi.fn();

    requireConsent(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(412);
  });

  it('blocks when there is no session at all', () => {
    const req = {} as unknown as Request;
    const res = mockRes();
    const next = vi.fn();

    requireConsent(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(412);
  });
});
