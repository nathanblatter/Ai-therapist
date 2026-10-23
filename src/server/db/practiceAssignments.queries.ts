// Between-session practice assignments (ai-therapist-123, clinician half
// ai-therapist-200). Written by the assign_practice tool during a session
// (source='ai') and by therapists/researchers from the participant profile
// (source='therapist', migration 109); read by the participant "Your
// practice" card (/api/me/assignments), the returning-participant prompt
// block, and the clinician prep digest. Completion is ALWAYS scoped by
// user_id so a participant can only ever complete their own assignments,
// and every clinician write is scoped by (id, user_id) so a caseload client's
// URL can never reach another client's row.
import { pool } from '../config/db.js';
import type { PracticeKind } from '../../shared/practice.js';

export type PracticeAssignmentKind = PracticeKind;
export type PracticeAssignmentStatus = 'assigned' | 'completed' | 'skipped' | 'cancelled';
export type PracticeAssignmentSource = 'ai' | 'therapist';

export interface PracticeAssignment {
  id: number;
  user_id: number;
  session_id: string | null;
  title: string;
  description: string;
  kind: PracticeAssignmentKind;
  suggested_frequency: string | null;
  status: PracticeAssignmentStatus;
  assigned_at: Date;
  completed_at: Date | null;
  completion_note: string | null;
  source: PracticeAssignmentSource;
  authored_by: number | null;
  cancelled_at: Date | null;
  cancelled_by: number | null;
  cancel_reason: string | null;
  reissued_from: number | null;
}

/** Clinician list row: the assignment plus who authored/cancelled it. */
export interface PracticeAssignmentListRow extends PracticeAssignment {
  authored_by_username: string | null;
  cancelled_by_username: string | null;
}

export interface NewPracticeAssignment {
  userId: number;
  sessionId?: string | null;
  title: string;
  description: string;
  kind?: PracticeAssignmentKind;
  suggestedFrequency?: string | null;
}

/** Store a practice the participant agreed to during a session (AI-authored). */
export async function insertPracticeAssignment(input: NewPracticeAssignment): Promise<PracticeAssignment> {
  const result = await pool.query<PracticeAssignment>(
    `INSERT INTO practice_assignments (user_id, session_id, title, description, kind, suggested_frequency)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING *`,
    [
      input.userId,
      input.sessionId ?? null,
      input.title,
      input.description,
      input.kind ?? 'custom',
      input.suggestedFrequency ?? null,
    ],
  );
  return result.rows[0];
}

/**
 * A user's assignments as the PARTICIPANT sees them, newest first,
 * optionally filtered by status. Cancelled rows are never returned here:
 * cancellation is a clinician-side act with a clinician-facing reason.
 */
export async function listUserAssignments(
  userId: number,
  opts: { status?: Exclude<PracticeAssignmentStatus, 'cancelled'>; limit?: number } = {},
): Promise<PracticeAssignment[]> {
  const limit = opts.limit ?? 50;
  const result = await pool.query<PracticeAssignment>(
    `SELECT * FROM practice_assignments
     WHERE user_id = $1
       AND status <> 'cancelled'
       AND ($2::text IS NULL OR status = $2)
     ORDER BY assigned_at DESC
     LIMIT $3`,
    [userId, opts.status ?? null, limit],
  );
  return result.rows;
}

/**
 * Mark an assignment done. Scoped by BOTH id and user_id — a user can only
 * ever complete their own — and only from 'assigned' (idempotence: completing
 * twice, or someone else's id, returns null instead of overwriting).
 */
export async function completeAssignment(
  id: number,
  userId: number,
  note?: string | null,
): Promise<PracticeAssignment | null> {
  const result = await pool.query<PracticeAssignment>(
    `UPDATE practice_assignments
     SET status = 'completed',
         completed_at = NOW(),
         completion_note = $3
     WHERE id = $1 AND user_id = $2 AND status = 'assigned'
     RETURNING *`,
    [id, userId, note ?? null],
  );
  return result.rows[0] ?? null;
}

// ---------- clinician half (ai-therapist-200) ----------

export interface ClinicianAssignmentInput {
  userId: number;
  authoredBy: number;
  title: string;
  description: string;
  kind: PracticeAssignmentKind;
  suggestedFrequency: string | null;
}

/** Create a therapist-authored assignment (source='therapist'). */
export async function createAssignment(input: ClinicianAssignmentInput): Promise<PracticeAssignment> {
  const result = await pool.query<PracticeAssignment>(
    `INSERT INTO practice_assignments
       (user_id, title, description, kind, suggested_frequency, source, authored_by)
     VALUES ($1, $2, $3, $4, $5, 'therapist', $6)
     RETURNING *`,
    [input.userId, input.title, input.description, input.kind, input.suggestedFrequency, input.authoredBy],
  );
  return result.rows[0];
}

export interface UpdateAssignmentFields {
  title?: string;
  description?: string;
  kind?: PracticeAssignmentKind;
  suggestedFrequency?: string | null;
}

/**
 * Edit an OPEN assignment's content. Scoped by (id, user_id); only
 * status='assigned' rows are editable (a completed/cancelled one is a
 * record of what the participant was actually asked to do). Returns null
 * when nothing matched so the route can distinguish 404 from 409.
 */
export async function updateAssignment(
  id: number,
  userId: number,
  fields: UpdateAssignmentFields,
): Promise<PracticeAssignment | null> {
  const result = await pool.query<PracticeAssignment>(
    `UPDATE practice_assignments
     SET title = COALESCE($3, title),
         description = COALESCE($4, description),
         kind = COALESCE($5, kind),
         suggested_frequency = CASE WHEN $6::boolean THEN $7 ELSE suggested_frequency END
     WHERE id = $1 AND user_id = $2 AND status = 'assigned'
     RETURNING *`,
    [
      id,
      userId,
      fields.title ?? null,
      fields.description ?? null,
      fields.kind ?? null,
      fields.suggestedFrequency !== undefined,
      fields.suggestedFrequency ?? null,
    ],
  );
  return result.rows[0] ?? null;
}

/** Cancel an OPEN assignment with a clinician-facing reason. Never deletes. */
export async function cancelAssignment(
  id: number,
  userId: number,
  cancelledBy: number,
  reason: string,
): Promise<PracticeAssignment | null> {
  const result = await pool.query<PracticeAssignment>(
    `UPDATE practice_assignments
     SET status = 'cancelled',
         cancelled_at = NOW(),
         cancelled_by = $3,
         cancel_reason = $4
     WHERE id = $1 AND user_id = $2 AND status = 'assigned'
     RETURNING *`,
    [id, userId, cancelledBy, reason],
  );
  return result.rows[0] ?? null;
}

/**
 * Re-issue a CLOSED assignment (completed/skipped/cancelled) as a fresh open
 * row with the same content, linked back through reissued_from. An
 * assignment that is still open cannot be re-issued (it would duplicate);
 * null means no closed row matched (id, user_id).
 */
export async function reissueAssignment(
  id: number,
  userId: number,
  authoredBy: number,
): Promise<PracticeAssignment | null> {
  const result = await pool.query<PracticeAssignment>(
    `INSERT INTO practice_assignments
       (user_id, title, description, kind, suggested_frequency, source, authored_by, reissued_from)
     SELECT user_id, title, description, kind, suggested_frequency, 'therapist', $3, id
       FROM practice_assignments
      WHERE id = $1 AND user_id = $2 AND status <> 'assigned'
     RETURNING *`,
    [id, userId, authoredBy],
  );
  return result.rows[0] ?? null;
}

/** Every assignment for a client (all statuses, incl. cancelled), newest first,
 *  with the authoring/cancelling clinician's username for the panel. */
export async function listAssignmentsForClient(userId: number, limit = 100): Promise<PracticeAssignmentListRow[]> {
  const result = await pool.query<PracticeAssignmentListRow>(
    `SELECT pa.*,
            au.username AS authored_by_username,
            cu.username AS cancelled_by_username
       FROM practice_assignments pa
       LEFT JOIN users au ON au.userid = pa.authored_by
       LEFT JOIN users cu ON cu.userid = pa.cancelled_by
      WHERE pa.user_id = $1
      ORDER BY pa.assigned_at DESC, pa.id DESC
      LIMIT $2`,
    [userId, limit],
  );
  return result.rows;
}
