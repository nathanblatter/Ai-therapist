// Care-team caseload assignments (ai-therapist-119, docs/caseload-rbac.md;
// generalized for the caseworker portal, docs/caseworker-portal.md C1).
// Backs row-scoped care-team RBAC: which participants a therapist or
// caseworker account is allowed to see. Researchers are caseload-unscoped and
// never consult this table. Table: therapist_clients (migrations 064 + 070) —
// the therapist_id column historically holds ANY care-team member's userid;
// member_role selects the data tier.
import { pool } from '../config/db.js';
import type { CareTeamRole, CareTeamMember } from '../../shared/roles.js';

/** Thrown by assignClient when the member/client ids do not have the required
 *  roles, do not exist, or belong to different organizations. */
export class CaseloadRoleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CaseloadRoleError';
  }
}

export interface CaseloadClient {
  userid: number;
  username: string;
  created_at: string;
  assigned_at: string;
}

export interface CaseloadAssignment {
  therapist_id: number;
  therapist_username: string;
  client_id: number;
  client_username: string;
  member_role?: CareTeamRole;
  assigned_at: string;
}

/**
 * Assign a client to a care-team member's caseload. Idempotent (ON CONFLICT
 * DO NOTHING). Validates with a single query first and throws
 * CaseloadRoleError if memberId's account role does not match memberRole
 * (default 'therapist'), clientId is not role=participant, or — same-org
 * integrity, enforced at write time per C1 — the two accounts belong to
 * different organizations.
 */
export async function assignClient(
  memberId: number,
  clientId: number,
  assignedBy: number | null,
  memberRole: CareTeamRole = 'therapist'
): Promise<void> {
  const roles = await pool.query(
    `SELECT
       (SELECT role FROM users WHERE userid = $1) AS therapist_role,
       (SELECT role FROM users WHERE userid = $2) AS client_role,
       (SELECT organization_id FROM users WHERE userid = $1) AS member_org,
       (SELECT organization_id FROM users WHERE userid = $2) AS client_org`,
    [memberId, clientId]
  );
  const { therapist_role, client_role, member_org, client_org } = roles.rows[0] as {
    therapist_role: string | null;
    client_role: string | null;
    member_org?: number | null;
    client_org?: number | null;
  };
  if (therapist_role !== memberRole) {
    throw new CaseloadRoleError(`User ${memberId} is not a ${memberRole} account`);
  }
  if (client_role !== 'participant') {
    throw new CaseloadRoleError(`User ${clientId} is not a participant account`);
  }
  if (member_org !== client_org) {
    throw new CaseloadRoleError(
      `User ${memberId} and user ${clientId} belong to different organizations`
    );
  }
  if (memberRole === 'therapist') {
    // member_role defaults to 'therapist' in the DB; keeping the historical
    // 3-parameter insert preserves byte-identical behavior for every
    // pre-caseworker call site.
    await pool.query(
      `INSERT INTO therapist_clients (therapist_id, client_id, assigned_by)
       VALUES ($1, $2, $3)
       ON CONFLICT DO NOTHING`,
      [memberId, clientId, assignedBy]
    );
    return;
  }
  await pool.query(
    `INSERT INTO therapist_clients (therapist_id, client_id, assigned_by, member_role)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT DO NOTHING`,
    [memberId, clientId, assignedBy, memberRole]
  );
}

/** Remove a client from a therapist's caseload. Returns true if a row was deleted. */
export async function unassignClient(therapistId: number, clientId: number): Promise<boolean> {
  const result = await pool.query(
    'DELETE FROM therapist_clients WHERE therapist_id = $1 AND client_id = $2',
    [therapistId, clientId]
  );
  return (result.rowCount ?? 0) > 0;
}

/** Is this client on this therapist's caseload? */
export async function isAssigned(therapistId: number, clientId: number): Promise<boolean> {
  const result = await pool.query(
    'SELECT 1 FROM therapist_clients WHERE therapist_id = $1 AND client_id = $2',
    [therapistId, clientId]
  );
  return (result.rowCount ?? 0) > 0;
}

/** All client ids on a therapist's caseload. */
export async function getCaseloadClientIds(therapistId: number): Promise<number[]> {
  const result = await pool.query(
    'SELECT client_id FROM therapist_clients WHERE therapist_id = $1 ORDER BY client_id',
    [therapistId]
  );
  return result.rows.map((row: { client_id: number }) => row.client_id);
}

/** Care-team member ids for a client, optionally restricted to one
 *  member_role. Shared implementation behind the three role-specific exports
 *  below (kept as distinct names because the tiers they back differ). */
async function getCareTeamMemberIds(
  clientId: number,
  role?: 'therapist' | 'caseworker'
): Promise<number[]> {
  const result = await pool.query(
    `SELECT therapist_id FROM therapist_clients
     WHERE client_id = $1 AND ($2::text IS NULL OR member_role = $2)
     ORDER BY therapist_id`,
    [clientId, role ?? null]
  );
  return result.rows.map((row: { therapist_id: number }) => row.therapist_id);
}

/** All therapist ids (member_role='therapist' — the full data tier) that have
 *  this client on their caseload. Backs full-tier admin event fan-out; must
 *  never include caseworker member ids. */
export function getTherapistIdsForClient(clientId: number): Promise<number[]> {
  return getCareTeamMemberIds(clientId, 'therapist');
}

/** All caseworker member ids for a client (summary-tier fan-out). */
export function getCaseworkerIdsForClient(clientId: number): Promise<number[]> {
  return getCareTeamMemberIds(clientId, 'caseworker');
}

/** Every care-team member id for a client, regardless of role. */
export function getCareTeamMemberIdsForClient(clientId: number): Promise<number[]> {
  return getCareTeamMemberIds(clientId);
}

/** A client's care team with member usernames and roles. */
export async function getCareTeam(clientId: number): Promise<CareTeamMember[]> {
  const result = await pool.query<CareTeamMember>(
    `SELECT tc.therapist_id AS member_id, u.username, tc.member_role,
            tc.assigned_at::text AS assigned_at
     FROM therapist_clients tc
     JOIN users u ON u.userid = tc.therapist_id
     WHERE tc.client_id = $1
     ORDER BY tc.member_role, u.username`,
    [clientId]
  );
  return result.rows;
}

/** A therapist's caseload with client account details, newest assignment first. */
export async function listCaseload(therapistId: number): Promise<CaseloadClient[]> {
  const result = await pool.query(
    `SELECT u.userid, u.username, u.created_at::text AS created_at,
            tc.assigned_at::text AS assigned_at
     FROM therapist_clients tc
     JOIN users u ON u.userid = tc.client_id
     WHERE tc.therapist_id = $1
     ORDER BY tc.assigned_at DESC, u.userid`,
    [therapistId]
  );
  return result.rows as CaseloadClient[];
}

/** Every therapist->client assignment (researcher view), grouped by therapist.
 *  orgId (caseworker portal C13): when set, restrict to assignments whose
 *  care-team member belongs to that organization (assignments are same-org by
 *  the assignClient write-time invariant); null/undefined = unscoped. */
export async function listAllAssignments(orgId?: number | null): Promise<CaseloadAssignment[]> {
  const result = await pool.query(
    `SELECT tc.therapist_id, t.username AS therapist_username,
            tc.client_id, c.username AS client_username,
            tc.member_role,
            tc.assigned_at::text AS assigned_at
     FROM therapist_clients tc
     JOIN users t ON t.userid = tc.therapist_id
     JOIN users c ON c.userid = tc.client_id
     WHERE ($1::int IS NULL OR t.organization_id = $1)
     ORDER BY t.username, c.username`,
    [orgId ?? null]
  );
  return result.rows as CaseloadAssignment[];
}


export type CaseloadAuditAction =
  | 'assign'
  | 'unassign'
  | 'invite_created'
  | 'invite_consumed'
  | 'work_item_ack'
  | 'work_item_resolve'
  | 'adverse_event_filed';

export interface CaseloadAuditInput {
  action: CaseloadAuditAction;
  therapistId: number | null;
  clientId: number | null;
  actorUserId: number | null;
  actorUsername: string | null;
  detail?: unknown;
}

/**
 * Append one caseload audit row (assignment/invite events). Never throws:
 * an audit failure must not abort the operation it records, but it is
 * loudly logged for the ops dashboard.
 */
export async function insertCaseloadAudit(input: CaseloadAuditInput): Promise<void> {
  try {
    await pool.query(
      `INSERT INTO caseload_audit_log
         (action, therapist_id, client_id, actor_user_id, actor_username, detail)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        input.action,
        input.therapistId,
        input.clientId,
        input.actorUserId,
        input.actorUsername,
        input.detail === undefined ? null : JSON.stringify(input.detail),
      ]
    );
  } catch (err) {
    console.error('[caseload-audit] failed to record audit row:', err);
  }
}

export interface CaseloadAuditRow {
  audit_id: number;
  action: CaseloadAuditAction;
  therapist_id: number | null;
  client_id: number | null;
  actor_user_id: number | null;
  actor_username: string | null;
  detail: unknown;
  created_at: string;
}

/** Newest-first audit rows (researcher review surface).
 *  orgId (caseworker portal C13): when set, keep only rows referencing at
 *  least one account (member/client/actor) in that organization — other
 *  orgs' invite/assignment history (incl. sandbox signups) stays invisible. */
export async function listCaseloadAudit(limit = 200, orgId?: number | null): Promise<CaseloadAuditRow[]> {
  const result = await pool.query(
    `SELECT audit_id, action, therapist_id, client_id, actor_user_id,
            actor_username, detail, created_at::text AS created_at
     FROM caseload_audit_log cal
     WHERE ($2::int IS NULL OR EXISTS (
       SELECT 1 FROM users u
       WHERE u.userid IN (cal.therapist_id, cal.client_id, cal.actor_user_id)
         AND u.organization_id = $2))
     ORDER BY audit_id DESC
     LIMIT $1`,
    [limit, orgId ?? null]
  );
  return result.rows as CaseloadAuditRow[];
}
