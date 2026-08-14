// Between-session practice assignments (ai-therapist-123). Written by the
// assign_practice tool during a session; read by the participant "Your
// practice" card (/api/me/assignments), the returning-participant prompt
// block, and the clinician prep digest. Completion is ALWAYS scoped by
// user_id so a participant can only ever complete their own assignments.
import { pool } from '../config/db.js';

export type PracticeAssignmentKind = 'worksheet' | 'exercise' | 'observation' | 'custom';
export type PracticeAssignmentStatus = 'assigned' | 'completed' | 'skipped';

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
}

export interface NewPracticeAssignment {
  userId: number;
  sessionId?: string | null;
  title: string;
  description: string;
  kind?: PracticeAssignmentKind;
  suggestedFrequency?: string | null;
}

/** Store a practice the participant agreed to during a session. */
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
    ]
  );
  return result.rows[0];
}

/** A user's assignments, newest first, optionally filtered by status. */
export async function listUserAssignments(
  userId: number,
  opts: { status?: PracticeAssignmentStatus; limit?: number } = {}
): Promise<PracticeAssignment[]> {
  const limit = opts.limit ?? 50;
  const result = await pool.query<PracticeAssignment>(
    `SELECT * FROM practice_assignments
     WHERE user_id = $1
       AND ($2::text IS NULL OR status = $2)
     ORDER BY assigned_at DESC
     LIMIT $3`,
    [userId, opts.status ?? null, limit]
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
  note?: string | null
): Promise<PracticeAssignment | null> {
  const result = await pool.query<PracticeAssignment>(
    `UPDATE practice_assignments
     SET status = 'completed',
         completed_at = NOW(),
         completion_note = $3
     WHERE id = $1 AND user_id = $2 AND status = 'assigned'
     RETURNING *`,
    [id, userId, note ?? null]
  );
  return result.rows[0] ?? null;
}

/** How many assignments are still open for this user. */
export async function countOpenAssignments(userId: number): Promise<number> {
  const result = await pool.query<{ count: string }>(
    `SELECT COUNT(*) AS count FROM practice_assignments
     WHERE user_id = $1 AND status = 'assigned'`,
    [userId]
  );
  return parseInt(result.rows[0]?.count ?? '0', 10);
}
