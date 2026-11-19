// "Forget that" records (ai-therapist-341, migration 128) and the
// safety-continuity read (ai-therapist-344).
//
// memory_suppressions controls what is carried into session memory; it never
// deletes or edits a study record. Every read here treats a missing table
// (migration 128 not applied yet: migrations are manual in every environment)
// as "no suppressions", so memory keeps working; the write reports failure so
// the assistant does not promise something the system cannot do.
import { pool } from '../config/db.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('memorySuppressions');

export interface MemorySuppression {
  suppression_id: number;
  user_id: number;
  session_id: string | null;
  topic: string;
  source: 'tool' | 'summary';
  suppressed_memory_ids: number[];
  created_at: Date;
  applied_at: Date | null;
}

/** undefined_table: the migration has not been applied in this environment. */
const isMissingTable = (err: unknown): boolean => (err as { code?: string } | null)?.code === '42P01';

let warnedMissing = false;
function warnMissing(): void {
  if (warnedMissing) return;
  warnedMissing = true;
  log.warn('memory_suppressions does not exist (migration 128 not applied): forget requests are not recorded');
}

const MAX_TOPIC_CHARS = 200;

/** Record one request. Returns false when it could not be stored. */
export async function insertMemorySuppression(
  userId: number,
  sessionId: string | null,
  topic: string,
  source: 'tool' | 'summary',
): Promise<boolean> {
  try {
    await pool.query(`INSERT INTO memory_suppressions (user_id, session_id, topic, source) VALUES ($1, $2, $3, $4)`, [
      userId,
      sessionId,
      topic.trim().slice(0, MAX_TOPIC_CHARS),
      source,
    ]);
    return true;
  } catch (err) {
    if (isMissingTable(err)) warnMissing();
    else log.error({ err }, `Failed to record a forget request for user ${userId}`);
    return false;
  }
}

/** A participant's requests, newest first. Empty when the table is missing. */
export async function getUserMemorySuppressions(userId: number, limit = 20): Promise<MemorySuppression[]> {
  try {
    const result = await pool.query<MemorySuppression>(
      `SELECT suppression_id::int AS suppression_id, user_id, session_id, topic, source, suppressed_memory_ids,
              created_at, applied_at
         FROM memory_suppressions
        WHERE user_id = $1
        ORDER BY created_at DESC
        LIMIT $2`,
      [userId, limit],
    );
    return result.rows;
  } catch (err) {
    if (isMissingTable(err)) {
      warnMissing();
      return [];
    }
    throw err;
  }
}

/**
 * The post-session job has checked everything older than these requests:
 * record which remembered facts it found (on the newest request, so one row
 * carries them) and mark all of them applied.
 */
export async function markMemorySuppressionsApplied(
  userId: number,
  suppressionIds: number[],
  suppressedMemoryIds: number[],
): Promise<void> {
  if (suppressionIds.length === 0) return;
  const carrier = Math.max(...suppressionIds);
  await pool.query(
    `UPDATE memory_suppressions
        SET applied_at = CURRENT_TIMESTAMP,
            suppressed_memory_ids = CASE WHEN suppression_id = $3
                                         THEN (SELECT ARRAY(SELECT DISTINCT unnest(suppressed_memory_ids || $4::int[])))
                                         ELSE suppressed_memory_ids END
      WHERE user_id = $1 AND suppression_id = ANY($2::bigint[])`,
    [userId, suppressionIds, carrier, suppressedMemoryIds],
  );
}

/** Mark stored summaries as not to be read into memory. The summary text
 *  itself (what staff read) is left as it is. */
export async function excludeSummariesFromMemory(userId: number, sessionIds: string[]): Promise<void> {
  if (sessionIds.length === 0) return;
  await pool.query(
    `UPDATE session_insights
        SET summary = jsonb_set(summary::jsonb, '{memory_excluded}', 'true'::jsonb)
      WHERE user_id = $1 AND session_id = ANY($2::text[]) AND summary IS NOT NULL`,
    [userId, sessionIds],
  );
}

// ---------------------------------------------------------------------------
// Safety continuity (ai-therapist-344)
// ---------------------------------------------------------------------------

export interface LastSessionSafetySignal {
  session_id: string;
  severity: string | null;
  /** When the session ended (or started, if it never recorded an end). */
  at: Date;
}

/**
 * Was the participant's most recent conversation crisis-flagged?
 *
 * "Most recent conversation" is the newest other session in which the
 * participant said anything: a session opened and closed without a word is
 * not one a check-in could have happened in. Returns the signal only when
 * that session carries a crisis flag that staff have not cleared and it ended
 * within `windowDays`. Reads the session row alone: the system's own safety
 * record, no conversation content, no summary.
 */
export async function getLastSessionSafetySignal(
  userId: number,
  excludeSessionId: string | null,
  windowDays: number,
): Promise<LastSessionSafetySignal | null> {
  const result = await pool.query<{
    session_id: string;
    crisis_severity: string | null;
    crisis_flagged_at: Date | null;
    crisis_unflagged_at: Date | null;
    at: Date;
    recent: boolean;
  }>(
    `SELECT ts.session_id, ts.crisis_severity, ts.crisis_flagged_at, ts.crisis_unflagged_at,
            COALESCE(ts.ended_at, ts.created_at) AS at,
            COALESCE(ts.ended_at, ts.created_at) >= CURRENT_TIMESTAMP - make_interval(days => $3::int) AS recent
       FROM therapy_sessions ts
      WHERE ts.user_id = $1
        AND ($2::text IS NULL OR ts.session_id <> $2)
        AND EXISTS (SELECT 1 FROM messages m WHERE m.session_id = ts.session_id AND m.role = 'user')
      ORDER BY ts.created_at DESC
      LIMIT 1`,
    [userId, excludeSessionId, windowDays],
  );
  const row = result.rows[0];
  if (!row || !row.crisis_flagged_at || !row.recent) return null;
  // A staff unflag after the flag is a human judgement that it was not, or is
  // no longer, a concern (crisisDetection.service respects it the same way).
  if (row.crisis_unflagged_at && row.crisis_unflagged_at >= row.crisis_flagged_at) return null;
  return { session_id: row.session_id, severity: row.crisis_severity, at: row.at };
}
