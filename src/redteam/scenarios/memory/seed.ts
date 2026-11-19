// Rows the memory scenarios seed directly, for surfaces a conversation cannot
// reach from the participant's side: a care-team note, a practice, a safety
// plan, a prior crisis flag. Each is written the way the product writes it,
// against a session and account the harness created for this run
// (multiSession.ts), so nothing here can touch a real row.
import type { DbLike } from '../../types.js';

/** A therapist's private guidance for the participant's next session
 *  (insights.queries.ts setSessionNotesForNextSession). */
export async function seedClinicianNote(pool: DbLike, sessionId: string, note: string): Promise<void> {
  const { rows } = await pool.query(
    `UPDATE session_insights
        SET notes_for_next_session = $2, notes_author = 'redteam_fixture', notes_created_at = NOW()
      WHERE session_id = $1 RETURNING session_id`,
    [sessionId, note],
  );
  if (rows.length === 0) throw new Error(`cannot seed a clinician note: session ${sessionId} has no insights row`);
}

/** An open between-session practice, as assign_practice stores it. */
export async function seedPractice(
  pool: DbLike,
  userId: number,
  sessionId: string,
  title: string,
  description: string,
): Promise<void> {
  await pool.query(
    `INSERT INTO practice_assignments (user_id, session_id, title, description, kind, status, source)
     VALUES ($1, $2, $3, $4, 'custom', 'assigned', 'ai')`,
    [userId, sessionId, title, description],
  );
}

/** A safety plan with the given warning signs, as create_safety_plan stores it. */
export async function seedSafetyPlan(
  pool: DbLike,
  userId: number,
  sessionId: string,
  warningSigns: string[],
): Promise<void> {
  await pool.query(`INSERT INTO safety_plans (session_id, user_id, plan) VALUES ($1, $2, $3::jsonb)`, [
    sessionId,
    userId,
    JSON.stringify({ warning_signs: warningSigns, coping_strategies: ['step outside for ten minutes'] }),
  ]);
}

/** Mark an ended session as having been crisis-flagged (what the detector
 *  writes on therapy_sessions; the risk-history block reads these columns). */
export async function seedCrisisFlag(pool: DbLike, sessionId: string, severity: 'medium' | 'high'): Promise<void> {
  await pool.query(
    `UPDATE therapy_sessions
        SET crisis_flagged = TRUE, crisis_severity = $2, crisis_flagged_at = COALESCE(ended_at, NOW())
      WHERE session_id = $1`,
    [sessionId, severity],
  );
}

/** The date (UTC, YYYY-MM-DD) a session's crisis flag carries. */
export async function crisisFlagDate(pool: DbLike, sessionId: string): Promise<string | null> {
  const { rows } = await pool.query(`SELECT crisis_flagged_at FROM therapy_sessions WHERE session_id = $1`, [
    sessionId,
  ]);
  const at = rows[0]?.crisis_flagged_at;
  return at ? new Date(at as string).toISOString().slice(0, 10) : null;
}

/** A remembered fact, as remember_this stores it (tools.queries.ts
 *  insertUserMemory, without the embedding). Used to put back rows the tool
 *  stored before it screened its writes (ai-therapist-343). */
export async function seedRememberedFact(pool: DbLike, userId: number, fact: string): Promise<void> {
  await pool.query(`INSERT INTO user_memories (user_id, fact, session_id) VALUES ($1, $2, NULL)`, [userId, fact]);
}
