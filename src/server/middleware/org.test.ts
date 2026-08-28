// Contract tests for orgIdFor (red-team round 3, finding 1): null ONLY for
// unauthenticated callers; legacy null-org users resolve to the irb-study
// default; a failed lookup THROWS instead of failing open to "unscoped".
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Request } from 'express';

const mocks = vi.hoisted(() => ({
  getOrganizationIdForUser: vi.fn(),
  getIrbStudyOrgId: vi.fn(),
}));

vi.mock('../db/index.js', () => ({
  getOrganizationIdForUser: mocks.getOrganizationIdForUser,
  getIrbStudyOrgId: mocks.getIrbStudyOrgId,
}));

import { orgIdFor } from './org.js';

function reqWith(session: Record<string, unknown> | undefined): Request {
  return { session } as unknown as Request;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('orgIdFor', () => {
  it('returns null only for unauthenticated sessions, without any lookup', async () => {
    await expect(orgIdFor(reqWith(undefined))).resolves.toBeNull();
    await expect(orgIdFor(reqWith({}))).resolves.toBeNull();
    expect(mocks.getOrganizationIdForUser).not.toHaveBeenCalled();
  });

  it('short-circuits on a session-stamped orgId', async () => {
    await expect(orgIdFor(reqWith({ userId: 7, orgId: 3 }))).resolves.toBe(3);
    expect(mocks.getOrganizationIdForUser).not.toHaveBeenCalled();
  });

  it('resolves and writes back the org for pre-069 sessions', async () => {
    mocks.getOrganizationIdForUser.mockResolvedValue(5);
    const session: Record<string, unknown> = { userId: 7 };
    await expect(orgIdFor(reqWith(session))).resolves.toBe(5);
    expect(session.orgId).toBe(5);
    expect(mocks.getIrbStudyOrgId).not.toHaveBeenCalled();
  });

  it('treats a legacy null org_id as the irb-study default org', async () => {
    mocks.getOrganizationIdForUser.mockResolvedValue(null);
    mocks.getIrbStudyOrgId.mockResolvedValue(1);
    const session: Record<string, unknown> = { userId: 7 };
    await expect(orgIdFor(reqWith(session))).resolves.toBe(1);
    expect(session.orgId).toBe(1);
  });

  it('THROWS when the user lookup fails (never fails open to unscoped)', async () => {
    mocks.getOrganizationIdForUser.mockRejectedValue(new Error('db down'));
    await expect(orgIdFor(reqWith({ userId: 7 }))).rejects.toThrow('db down');
  });

  it('THROWS when neither the user org nor the irb-study org resolves', async () => {
    mocks.getOrganizationIdForUser.mockResolvedValue(null);
    mocks.getIrbStudyOrgId.mockResolvedValue(null);
    await expect(orgIdFor(reqWith({ userId: 7 }))).rejects.toThrow(/Could not resolve an organization/);
  });
});
