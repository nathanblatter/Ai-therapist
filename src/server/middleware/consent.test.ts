import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Request, Response } from 'express';

const { getActiveConsentMock } = vi.hoisted(() => ({ getActiveConsentMock: vi.fn() }));
vi.mock('../utils/consent.js', () => ({
  getActiveConsent: getActiveConsentMock,
}));

import { requireConsent } from './consent.js';

const ACTIVE = { version: '2026-07-30.1', body: 'copy', bodyHash: 'abc' };

function mockRes() {
  const res: Partial<Response> = {};
  res.status = vi.fn().mockReturnValue(res);
  res.json = vi.fn().mockReturnValue(res);
  return res as Response;
}

beforeEach(() => {
  getActiveConsentMock.mockReset();
  getActiveConsentMock.mockResolvedValue(ACTIVE);
});

describe('requireConsent (async, DB-backed active version)', () => {
  it('calls next() when consent was accepted at the current active version', async () => {
    const req = { session: { consentAccepted: true, consentVersion: ACTIVE.version } } as unknown as Request;
    const res = mockRes();
    const next = vi.fn();

    await requireConsent(req, res, next);

    expect(next).toHaveBeenCalledOnce();
    expect(res.status).not.toHaveBeenCalled();
  });

  it('blocks with 412 when consent was never accepted', async () => {
    const req = { session: {} } as unknown as Request;
    const res = mockRes();
    const next = vi.fn();

    await requireConsent(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(412);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ error: 'consent_required', currentVersion: ACTIVE.version, reconsent: false })
    );
  });

  it('blocks with 412 and reconsent:true when a stale (older) version was accepted', async () => {
    const req = { session: { consentAccepted: true, consentVersion: '2020-01-01.1' } } as unknown as Request;
    const res = mockRes();
    const next = vi.fn();

    await requireConsent(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(412);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ reconsent: true }));
  });

  it('blocks when there is no session at all', async () => {
    const req = {} as unknown as Request;
    const res = mockRes();
    const next = vi.fn();

    await requireConsent(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(412);
  });
});
