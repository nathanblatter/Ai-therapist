// Data-access for organizations (caseworker portal foundation, migration 069).
// kind=research is the IRB study; kind=practice is a therapist practice;
// kind=sandbox orgs are demo-seeded, excluded from research/crisis pipelines,
// and cascade-deleted at batch teardown.
import { pool } from '../config/db.js';

export type OrganizationKind = 'research' | 'practice' | 'sandbox';

export interface OrganizationRow {
  org_id: number;
  slug: string;
  name: string;
  kind: OrganizationKind;
  created_at: string;
}

const ORG_COLUMNS = 'org_id, slug, name, kind, created_at::text AS created_at';

/** Slug for the backfill org every pre-069 user belongs to. */
export const IRB_STUDY_SLUG = 'irb-study';

function slugify(name: string): string {
  const base = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return base || 'org';
}

/**
 * Create an organization. When no slug is given one is derived from the name
 * with a random suffix (sandbox orgs are minted per consumed invite, so slug
 * uniqueness must never make signup fail).
 */
export async function createOrganization(input: {
  name: string;
  kind: OrganizationKind;
  slug?: string | null;
}): Promise<OrganizationRow> {
  const slug =
    input.slug ?? `${slugify(input.name)}-${Math.random().toString(36).slice(2, 8)}`;
  const result = await pool.query<OrganizationRow>(
    `INSERT INTO organizations (slug, name, kind)
     VALUES ($1, $2, $3)
     RETURNING ${ORG_COLUMNS}`,
    [slug, input.name, input.kind]
  );
  return result.rows[0];
}

/** One organization by id, or null. */
export async function getOrganizationById(orgId: number): Promise<OrganizationRow | null> {
  const result = await pool.query<OrganizationRow>(
    `SELECT ${ORG_COLUMNS} FROM organizations WHERE org_id = $1`,
    [orgId]
  );
  return result.rows[0] ?? null;
}

/** One organization by slug, or null. */
export async function getOrganizationBySlug(slug: string): Promise<OrganizationRow | null> {
  const result = await pool.query<OrganizationRow>(
    `SELECT ${ORG_COLUMNS} FROM organizations WHERE slug = $1`,
    [slug]
  );
  return result.rows[0] ?? null;
}

// The irb-study org id never changes once seeded (069), so cache it for the
// process lifetime. Cleared by the test hook below.
let irbStudyOrgIdCache: number | null = null;

/** Test hook: reset the cached irb-study org id. */
export function _clearIrbStudyOrgIdCache(): void {
  irbStudyOrgIdCache = null;
}

/** The org_id of the irb-study backfill org (cached), or null pre-069. */
export async function getIrbStudyOrgId(): Promise<number | null> {
  if (irbStudyOrgIdCache !== null) return irbStudyOrgIdCache;
  const org = await getOrganizationBySlug(IRB_STUDY_SLUG);
  if (org) irbStudyOrgIdCache = org.org_id;
  return org?.org_id ?? null;
}

/** A user's organization id, or null when the user does not exist. */
export async function getOrganizationIdForUser(userId: number): Promise<number | null> {
  const result = await pool.query<{ organization_id: number | null }>(
    'SELECT organization_id FROM users WHERE userid = $1',
    [userId]
  );
  if (result.rows.length === 0) return null;
  return result.rows[0].organization_id ?? null;
}

/** All organizations, newest first (researcher admin surface). */
export async function listOrganizations(): Promise<OrganizationRow[]> {
  const result = await pool.query<OrganizationRow>(
    `SELECT ${ORG_COLUMNS} FROM organizations ORDER BY created_at DESC, org_id DESC`
  );
  return result.rows;
}

/**
 * Delete an organization (sandbox batch teardown). Refuses non-sandbox orgs
 * as a guard rail — users FK-restrict deletion anyway, but sandbox users are
 * deleted first by the teardown flow and this keeps a bug from ever pointing
 * at the study org. Returns true when a row was deleted.
 */
export async function deleteSandboxOrganization(orgId: number): Promise<boolean> {
  const result = await pool.query(
    `DELETE FROM organizations WHERE org_id = $1 AND kind = 'sandbox'`,
    [orgId]
  );
  return (result.rowCount ?? 0) > 0;
}
