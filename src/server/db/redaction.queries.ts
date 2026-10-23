// Data-access for the redaction-verification tool.
import { pool } from '../config/db.js';
import { REDACTABLE_ROWS_SQL } from './redactionScope.js';
import { IRB_STUDY_ORG_ID_SQL } from './organizations.queries.js';

/**
 * Organization scope for the review queue (ai-therapist-272): the message's
 * session owner must be in the caller's org ($N); an anonymous session
 * (`therapy_sessions.user_id IS NULL`) is IRB-study custody and matches only
 * when $N is the irb-study org. Written as EXISTS so the outer query's
 * unqualified `messages` column references stay unambiguous.
 */
function sessionOrgScopeSql(orgParam: string): string {
  return `EXISTS (
    SELECT 1 FROM therapy_sessions ts
    LEFT JOIN users u ON u.userid = ts.user_id
    WHERE ts.session_id = messages.session_id
      AND (u.organization_id = ${orgParam}
        OR (ts.user_id IS NULL AND ${orgParam} = ${IRB_STUDY_ORG_ID_SQL})))`;
}

/** Rows the leak-check flagged and no researcher has corrected or approved yet. */
const FLAGGED_UNREVIEWED_SQL = `(metadata->'redaction_check'->>'flagged') = 'true' AND COALESCE(metadata->'redaction_check'->>'reviewed', 'false') <> 'true'`;

/**
 * The review queue: leak-flagged messages first (ai-therapist-262), then a
 * random sample. Scoped with the shared redaction predicate so tool_event_%
 * rows — participant free text from thought records and fear ladders — are
 * eligible for verification too, and to the caller's organization (272).
 */
export async function getRandomRedactedMessages(orgId: number): Promise<Record<string, unknown>[]> {
  const result = await pool.query(
    `SELECT message_id, content_redacted, role, message_type, created_at,
           metadata->'redaction_check' AS redaction_check
    FROM messages
    WHERE content_redacted IS NOT NULL AND ${REDACTABLE_ROWS_SQL}
      AND ${sessionOrgScopeSql('$1')}
    ORDER BY (${FLAGGED_UNREVIEWED_SQL}) DESC, RANDOM()
    LIMIT 20`,
    [orgId],
  );
  return result.rows;
}

/** How many leak-flagged messages in the caller's org are still waiting for a researcher. */
export async function countFlaggedUnreviewed(orgId: number): Promise<number> {
  const result = await pool.query<{ n: string }>(
    `SELECT COUNT(*)::text AS n FROM messages
     WHERE ${FLAGGED_UNREVIEWED_SQL} AND ${REDACTABLE_ROWS_SQL}
       AND ${sessionOrgScopeSql('$1')}`,
    [orgId],
  );
  return Number(result.rows[0]?.n ?? 0);
}

/** Mark a message's leak-check as human-reviewed (no-op when never checked). */
const MARK_REVIEWED_SQL = `
  UPDATE messages
     SET metadata = jsonb_set(metadata, '{redaction_check,reviewed}', 'true'::jsonb)
   WHERE message_id = $1 AND metadata ? 'redaction_check'`;

/**
 * Overwrite a message's redacted content and record WHO corrected it in
 * redaction_review_log (091), in one transaction — a correction without its
 * accountability row must not exist. Returns false if no such message.
 */
export async function updateRedactedContent(
  messageId: string,
  contentRedacted: string,
  reviewedBy: number | null,
): Promise<boolean> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await client.query(
      'UPDATE messages SET content_redacted = $1 WHERE message_id = $2 RETURNING message_id',
      [contentRedacted, messageId],
    );
    if ((result.rowCount ?? 0) === 0) {
      await client.query('ROLLBACK');
      return false;
    }
    await client.query(
      `INSERT INTO redaction_review_log (message_id, reviewed_by, action)
       VALUES ($1, $2, 'corrected')`,
      [messageId, reviewedBy],
    );
    await client.query(MARK_REVIEWED_SQL, [messageId]);
    await client.query('COMMIT');
    return true;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Record a no-change sign-off from the /redact verification tool: the reviewer
 * looked at the sampled message and approved the auto-redaction as-is.
 * Returns false if the message does not exist.
 */
export async function recordRedactionApproval(messageId: string, reviewedBy: number | null): Promise<boolean> {
  const result = await pool.query(
    `INSERT INTO redaction_review_log (message_id, reviewed_by, action)
     SELECT message_id, $2, 'approved' FROM messages WHERE message_id = $1
     RETURNING review_id`,
    [messageId, reviewedBy],
  );
  if ((result.rowCount ?? 0) === 0) return false;
  await pool.query(MARK_REVIEWED_SQL, [messageId]);
  return true;
}

// ---------------------------------------------------------------------------
// Redaction review log reads (ai-therapist-197): who approved or corrected
// which sampled message. No FK to messages, so the session/participant
// context is a LEFT JOIN that goes null once the message is deleted.
// Org scoping (ai-therapist-272): when `orgId` is set, only rows whose
// message's session owner is in that org; rows with no owner — an anonymous
// session, or a message deleted since review — are IRB-study custody.
// ---------------------------------------------------------------------------

export interface RedactionReviewLogRow {
  review_id: number;
  message_id: number;
  reviewed_by: number | null;
  reviewer_username: string | null;
  action: 'approved' | 'corrected';
  session_id: string | null;
  participant_user_id: number | null;
  created_at: string;
}

export interface RedactionReviewLogFilters {
  reviewedBy?: number | null;
  action?: 'approved' | 'corrected' | null;
  limit: number;
  offset: number;
}

export async function listRedactionReviewLog(
  filters: RedactionReviewLogFilters,
  orgId: number | null = null,
): Promise<{ rows: RedactionReviewLogRow[]; total: number }> {
  const from = `
    FROM redaction_review_log rrl
    LEFT JOIN users u ON u.userid = rrl.reviewed_by
    LEFT JOIN messages m ON m.message_id = rrl.message_id
    LEFT JOIN therapy_sessions ts ON ts.session_id = m.session_id
    LEFT JOIN users pu ON pu.userid = ts.user_id`;
  const where = `
    WHERE ($1::int IS NULL OR rrl.reviewed_by = $1)
      AND ($2::text IS NULL OR rrl.action = $2)
      AND ($3::int IS NULL OR pu.organization_id = $3
        OR (ts.user_id IS NULL AND $3 = ${IRB_STUDY_ORG_ID_SQL}))`;
  const params = [filters.reviewedBy ?? null, filters.action ?? null, orgId];
  const [page, count] = await Promise.all([
    pool.query<RedactionReviewLogRow>(
      `SELECT rrl.review_id, rrl.message_id, rrl.reviewed_by, u.username AS reviewer_username,
              rrl.action, m.session_id::text AS session_id, ts.user_id AS participant_user_id,
              rrl.created_at::text AS created_at
       ${from} ${where}
       ORDER BY rrl.review_id DESC
       LIMIT $4 OFFSET $5`,
      [...params, filters.limit, filters.offset],
    ),
    pool.query<{ count: string }>(`SELECT COUNT(*) AS count ${from} ${where}`, params),
  ]);
  return { rows: page.rows, total: parseInt(count.rows[0].count, 10) };
}
