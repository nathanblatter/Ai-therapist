import { describe, it, expect, vi, beforeEach } from 'vitest';

const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn() }));
vi.mock('../config/db.js', () => ({
  pool: { query: queryMock, connect: vi.fn(), on: vi.fn() },
}));

import {
  createOrganization,
  getOrganizationById,
  getOrganizationBySlug,
  getIrbStudyOrgId,
  getOrganizationIdForUser,
  deleteSandboxOrganization,
  _clearIrbStudyOrgIdCache,
} from './organizations.queries.js';

beforeEach(() => {
  queryMock.mockReset();
  _clearIrbStudyOrgIdCache();
});

describe('createOrganization', () => {
  it('inserts with an explicit slug when given', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ org_id: 2, slug: 's', name: 'n', kind: 'sandbox' }] });
    const org = await createOrganization({ name: 'n', kind: 'sandbox', slug: 's' });
    expect(org.org_id).toBe(2);
    expect(queryMock.mock.calls[0][1]).toEqual(['s', 'n', 'sandbox']);
  });

  it('derives a unique-ish slug from the name when none is given', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ org_id: 3 }] });
    await createOrganization({ name: "Nathan's Sandbox", kind: 'sandbox' });
    const slug = queryMock.mock.calls[0][1][0] as string;
    expect(slug).toMatch(/^nathan-s-sandbox-[a-z0-9]+$/);
  });
});

describe('lookups', () => {
  it('getOrganizationById returns null on a miss', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] });
    await expect(getOrganizationById(9)).resolves.toBeNull();
    expect(queryMock.mock.calls[0][1]).toEqual([9]);
  });

  it('getOrganizationBySlug queries by slug', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ org_id: 1, slug: 'irb-study' }] });
    const org = await getOrganizationBySlug('irb-study');
    expect(org?.org_id).toBe(1);
    expect(queryMock.mock.calls[0][1]).toEqual(['irb-study']);
  });

  it('getOrganizationIdForUser returns the org id, null when the user is missing', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ organization_id: 5 }] });
    await expect(getOrganizationIdForUser(7)).resolves.toBe(5);
    queryMock.mockResolvedValueOnce({ rows: [] });
    await expect(getOrganizationIdForUser(8)).resolves.toBeNull();
  });
});

describe('getIrbStudyOrgId', () => {
  it('caches the resolved id across calls', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ org_id: 1, slug: 'irb-study' }] });
    await expect(getIrbStudyOrgId()).resolves.toBe(1);
    await expect(getIrbStudyOrgId()).resolves.toBe(1);
    expect(queryMock).toHaveBeenCalledTimes(1);
  });

  it('does not cache a miss (pre-069 database)', async () => {
    queryMock.mockResolvedValue({ rows: [] });
    await expect(getIrbStudyOrgId()).resolves.toBeNull();
    await expect(getIrbStudyOrgId()).resolves.toBeNull();
    expect(queryMock).toHaveBeenCalledTimes(2);
  });
});

describe('deleteSandboxOrganization', () => {
  it("only deletes kind='sandbox' rows", async () => {
    queryMock.mockResolvedValueOnce({ rowCount: 1, rows: [] });
    await expect(deleteSandboxOrganization(4)).resolves.toBe(true);
    expect(String(queryMock.mock.calls[0][0])).toContain("kind = 'sandbox'");
  });

  it('returns false when nothing matched', async () => {
    queryMock.mockResolvedValueOnce({ rowCount: 0, rows: [] });
    await expect(deleteSandboxOrganization(1)).resolves.toBe(false);
  });
});
