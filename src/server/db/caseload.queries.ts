// Therapist caseload assignments (ai-therapist-119, docs/caseload-rbac.md).
// Backs row-scoped therapist RBAC: which participants a therapist account is
// allowed to see. Researchers are unscoped and never consult this table.
// Table: therapist_clients (migration 064).
import { pool } from '../config/db.js';

/** Thrown by assignClient when the therapist/client ids do not have the
 *  required roles (therapist / participant respectively) or do not exist. */
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
  assigned_at: string;
}

/**
 * Assign a client to a therapist's caseload. Idempotent (ON CONFLICT DO
 * NOTHING). Validates roles with a single query first and throws
 * CaseloadRoleError if therapistId is not role=therapist or clientId is not
 * role=participant.
 */
export async function assignClient(
  therapistId: number,
  clientId: number,
  assignedBy: number | null
): Promise<void> {
  const roles = await pool.query(
    `SELECT
       (SELECT role FROM users WHERE userid = $1) AS therapist_role,
       (SELECT role FROM users WHERE userid = $2) AS client_role`,
    [therapistId, clientId]
  );
  const { therapist_role, client_role } = roles.rows[0] as {
    therapist_role: string | null;
    client_role: string | null;
  };
  if (therapist_role !== 'therapist') {
    throw new CaseloadRoleError(`User ${therapistId} is not a therapist account`);
  }
  if (client_role !== 'participant') {
    throw new CaseloadRoleError(`User ${clientId} is not a participant account`);
  }
  await pool.query(
    `INSERT INTO therapist_clients (therapist_id, client_id, assigned_by)
     VALUES ($1, $2, $3)
     ON CONFLICT DO NOTHING`,
    [therapistId, clientId, assignedBy]
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

/** All therapist ids that have this client on their caseload. */
export async function getTherapistIdsForClient(clientId: number): Promise<number[]> {
  const result = await pool.query(
    'SELECT therapist_id FROM therapist_clients WHERE client_id = $1 ORDER BY therapist_id',
    [clientId]
  );
  return result.rows.map((row: { therapist_id: number }) => row.therapist_id);
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

/** Every therapist->client assignment (researcher view), grouped by therapist. */
export async function listAllAssignments(): Promise<CaseloadAssignment[]> {
  const result = await pool.query(
    `SELECT tc.therapist_id, t.username AS therapist_username,
            tc.client_id, c.username AS client_username,
            tc.assigned_at::text AS assigned_at
     FROM therapist_clients tc
     JOIN users t ON t.userid = tc.therapist_id
     JOIN users c ON c.userid = tc.client_id
     ORDER BY t.username, c.username`
  );
  return result.rows as CaseloadAssignment[];
}
