// Data-access for escalations + escalation_events (caseworker portal,
// migration 072). State machine: open -> acknowledged -> resolved
// (open -> resolved direct allowed; resolved -> open reopen clears
// ack/resolve fields). Every transition is a guarded UPDATE ... WHERE
// status = expected, returning null on a lost race so the route can 409.
import { pool } from '../config/db.js';
import type { CareTeamRole } from '../../shared/roles.js';

export type EscalationUrgency = 'routine' | 'urgent' | 'emergency';
export type EscalationStatus = 'open' | 'acknowledged' | 'resolved';
export type EscalationEventType =
  | 'created'
  | 'acknowledged'
  | 'resolved'
  | 'reopened'
  | 'reassigned'
  | 'claimed'
  | 'comment';

export interface EscalationRow {
  escalation_id: number;
  org_id: number;
  client_id: number;
  raised_by: number | null;
  raised_by_role: CareTeamRole;
  assigned_to: number | null;
  reason: string;
  urgency: EscalationUrgency;
  crisis_event_id: number | null;
  session_id: string | null;
  note_id: number | null;
  status: EscalationStatus;
  acknowledged_by: number | null;
  acknowledged_at: string | null;
  resolved_by: number | null;
  resolved_at: string | null;
  resolution_note: string | null;
  created_at: string;
  updated_at: string;
}

const ESCALATION_COLUMNS = `escalation_id, org_id, client_id, raised_by, raised_by_role,
       assigned_to, reason, urgency, crisis_event_id, session_id, note_id, status,
       acknowledged_by, acknowledged_at::text AS acknowledged_at,
       resolved_by, resolved_at::text AS resolved_at, resolution_note,
       created_at::text AS created_at, updated_at::text AS updated_at`;

// The same columns qualified with the escalations alias for joined lists.
const PREFIXED_ESCALATION_COLUMNS = `e.escalation_id, e.org_id, e.client_id, e.raised_by, e.raised_by_role,
       e.assigned_to, e.reason, e.urgency, e.crisis_event_id, e.session_id, e.note_id, e.status,
       e.acknowledged_by, e.acknowledged_at::text AS acknowledged_at,
       e.resolved_by, e.resolved_at::text AS resolved_at, e.resolution_note,
       e.created_at::text AS created_at, e.updated_at::text AS updated_at`;

export interface CreateEscalationInput {
  orgId: number;
  clientId: number;
  raisedBy: number;
  raisedByRole: CareTeamRole;
  assignedTo?: number | null; // null = org unassigned queue
  reason: string;
  urgency: EscalationUrgency;
  crisisEventId?: number | null;
  sessionId?: string | null;
  noteId?: number | null;
}

/** Create an escalation and its 'created' event in one transaction. */
export async function createEscalation(
  input: CreateEscalationInput,
  actorUsername: string | null
): Promise<EscalationRow> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const inserted = await client.query<EscalationRow>(
      `INSERT INTO escalations
         (org_id, client_id, raised_by, raised_by_role, assigned_to, reason,
          urgency, crisis_event_id, session_id, note_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING ${ESCALATION_COLUMNS}`,
      [
        input.orgId,
        input.clientId,
        input.raisedBy,
        input.raisedByRole,
        input.assignedTo ?? null,
        input.reason,
        input.urgency,
        input.crisisEventId ?? null,
        input.sessionId ?? null,
        input.noteId ?? null,
      ]
    );
    const row = inserted.rows[0];
    await client.query(
      `INSERT INTO escalation_events (escalation_id, event_type, actor_user_id, actor_username, detail)
       VALUES ($1, 'created', $2, $3, $4)`,
      [row.escalation_id, input.raisedBy, actorUsername, JSON.stringify({ urgency: input.urgency })]
    );
    await client.query('COMMIT');
    return row;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/** One escalation by id, or null. */
export async function getEscalationById(escalationId: number): Promise<EscalationRow | null> {
  const result = await pool.query<EscalationRow>(
    `SELECT ${ESCALATION_COLUMNS} FROM escalations WHERE escalation_id = $1`,
    [escalationId]
  );
  return result.rows[0] ?? null;
}

export interface EscalationListFilters {
  orgId?: number | null;
  clientId?: number | null;
  status?: EscalationStatus | null;
  openOnly?: boolean;
  /** Visible-to-member scope: assignee, raiser, caseload client, or same-org
   *  unassigned (the section 2 therapist/caseworker read set). */
  memberId?: number | null;
  limit?: number;
}

/** Escalations newest first with client/assignee usernames joined. */
export async function listEscalations(filters: EscalationListFilters): Promise<
  Array<EscalationRow & { client_username: string | null; assigned_username: string | null }>
> {
  const where: string[] = [];
  const params: unknown[] = [];
  const add = (clause: (n: number) => string, value: unknown): void => {
    params.push(value);
    where.push(clause(params.length));
  };

  if (filters.orgId !== null && filters.orgId !== undefined) {
    add((n) => `e.org_id = $${n}`, filters.orgId);
  }
  if (filters.clientId !== null && filters.clientId !== undefined) {
    add((n) => `e.client_id = $${n}`, filters.clientId);
  }
  if (filters.status) {
    add((n) => `e.status = $${n}`, filters.status);
  }
  if (filters.openOnly) {
    where.push(`e.status <> 'resolved'`);
  }
  if (filters.memberId !== null && filters.memberId !== undefined) {
    add(
      (n) => `(
        e.assigned_to = $${n}
        OR e.raised_by = $${n}
        OR EXISTS (SELECT 1 FROM therapist_clients tc WHERE tc.therapist_id = $${n} AND tc.client_id = e.client_id)
        OR (e.assigned_to IS NULL AND e.org_id = (SELECT organization_id FROM users mu WHERE mu.userid = $${n}))
      )`,
      filters.memberId
    );
  }

  params.push(filters.limit ?? 200);
  const result = await pool.query(
    `SELECT ${PREFIXED_ESCALATION_COLUMNS},
            c.username AS client_username, a.username AS assigned_username
     FROM escalations e
     LEFT JOIN users c ON c.userid = e.client_id
     LEFT JOIN users a ON a.userid = e.assigned_to
     ${where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''}
     ORDER BY e.created_at DESC, e.escalation_id DESC
     LIMIT $${params.length}`,
    params
  );
  return result.rows;
}

/** Open (not-resolved) escalation count visible to a member (nav badge). */
export async function countOpenEscalationsForMember(memberId: number): Promise<number> {
  const result = await pool.query<{ total: string }>(
    `SELECT COUNT(*) AS total FROM escalations e
     WHERE e.status <> 'resolved'
       AND (
         e.assigned_to = $1
         OR e.raised_by = $1
         OR EXISTS (SELECT 1 FROM therapist_clients tc WHERE tc.therapist_id = $1 AND tc.client_id = e.client_id)
         OR (e.assigned_to IS NULL AND e.org_id = (SELECT organization_id FROM users mu WHERE mu.userid = $1))
       )`,
    [memberId]
  );
  return parseInt(result.rows[0]?.total ?? '0', 10);
}

/** open -> acknowledged. Null on a lost race (caller 409s). */
export async function acknowledgeEscalation(
  escalationId: number,
  userId: number
): Promise<EscalationRow | null> {
  const result = await pool.query<EscalationRow>(
    `UPDATE escalations
     SET status = 'acknowledged', acknowledged_by = $2, acknowledged_at = now(), updated_at = now()
     WHERE escalation_id = $1 AND status = 'open'
     RETURNING ${ESCALATION_COLUMNS}`,
    [escalationId, userId]
  );
  return result.rows[0] ?? null;
}

/** open|acknowledged -> resolved. Null on a lost race (caller 409s). */
export async function resolveEscalation(
  escalationId: number,
  userId: number,
  resolutionNote: string | null
): Promise<EscalationRow | null> {
  const result = await pool.query<EscalationRow>(
    `UPDATE escalations
     SET status = 'resolved', resolved_by = $2, resolved_at = now(),
         resolution_note = $3, updated_at = now()
     WHERE escalation_id = $1 AND status IN ('open', 'acknowledged')
     RETURNING ${ESCALATION_COLUMNS}`,
    [escalationId, userId, resolutionNote]
  );
  return result.rows[0] ?? null;
}

/** resolved -> open (reopen): clears ack/resolve fields. Null on a lost race. */
export async function reopenEscalation(escalationId: number): Promise<EscalationRow | null> {
  const result = await pool.query<EscalationRow>(
    `UPDATE escalations
     SET status = 'open', acknowledged_by = NULL, acknowledged_at = NULL,
         resolved_by = NULL, resolved_at = NULL, resolution_note = NULL, updated_at = now()
     WHERE escalation_id = $1 AND status = 'resolved'
     RETURNING ${ESCALATION_COLUMNS}`,
    [escalationId]
  );
  return result.rows[0] ?? null;
}

/** Atomic claim of an unassigned, unresolved escalation. Null when someone
 *  else won the race or it is assigned/resolved (caller 409s). */
export async function claimEscalation(
  escalationId: number,
  therapistId: number
): Promise<EscalationRow | null> {
  const result = await pool.query<EscalationRow>(
    `UPDATE escalations
     SET assigned_to = $2, updated_at = now()
     WHERE escalation_id = $1 AND assigned_to IS NULL AND status <> 'resolved'
     RETURNING ${ESCALATION_COLUMNS}`,
    [escalationId, therapistId]
  );
  return result.rows[0] ?? null;
}

export interface EscalationEventRow {
  event_id: number;
  escalation_id: number;
  event_type: EscalationEventType;
  actor_user_id: number | null;
  actor_username: string | null;
  detail: unknown;
  created_at: string;
}

/** Append one lifecycle/comment event. */
export async function insertEscalationEvent(input: {
  escalationId: number;
  eventType: EscalationEventType;
  actorUserId: number | null;
  actorUsername: string | null;
  detail?: unknown;
}): Promise<EscalationEventRow> {
  const result = await pool.query<EscalationEventRow>(
    `INSERT INTO escalation_events (escalation_id, event_type, actor_user_id, actor_username, detail)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING event_id, escalation_id, event_type, actor_user_id, actor_username, detail,
               created_at::text AS created_at`,
    [
      input.escalationId,
      input.eventType,
      input.actorUserId,
      input.actorUsername,
      input.detail === undefined ? null : JSON.stringify(input.detail),
    ]
  );
  return result.rows[0];
}

/** An escalation's events, chronological. */
export async function listEscalationEvents(escalationId: number): Promise<EscalationEventRow[]> {
  const result = await pool.query<EscalationEventRow>(
    `SELECT event_id, escalation_id, event_type, actor_user_id, actor_username, detail,
            created_at::text AS created_at
     FROM escalation_events
     WHERE escalation_id = $1
     ORDER BY created_at ASC, event_id ASC`,
    [escalationId]
  );
  return result.rows;
}
