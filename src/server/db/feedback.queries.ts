// Post-session participant feedback survey (ai-therapist-25b): a single
// optional row per session, submitted from the main app's post-session
// screen and displayed in the admin Session Detail view.
import { pool } from '../config/db.js';

export interface SessionFeedbackInput {
  helpfulness_rating?: number | null;
  ease_rating?: number | null;
  would_return_rating?: number | null;
  comments?: string | null;
}

export interface SessionFeedbackRow extends SessionFeedbackInput {
  feedback_id: number;
  session_id: string;
  created_at: Date;
}

const RATING_FIELDS = ['helpfulness_rating', 'ease_rating', 'would_return_rating'] as const;

/** 1-5 or null/undefined; anything else is rejected. */
export function isValidRating(value: unknown): value is number | null | undefined {
  if (value === null || value === undefined) return true;
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 5;
}

/** Insert or (if the participant somehow submits twice) overwrite the one
 *  feedback row for a session. Comments are capped defensively; the caller
 *  is the public route, so nothing here trusts the input's shape. */
export async function upsertSessionFeedback(
  sessionId: string,
  input: SessionFeedbackInput
): Promise<SessionFeedbackRow> {
  for (const field of RATING_FIELDS) {
    if (!isValidRating(input[field])) {
      throw new Error(`${field} must be an integer 1-5 or null`);
    }
  }
  const comments = typeof input.comments === 'string' ? input.comments.trim().slice(0, 2000) || null : null;

  const result = await pool.query<SessionFeedbackRow>(
    `INSERT INTO session_feedback (session_id, helpfulness_rating, ease_rating, would_return_rating, comments)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (session_id) DO UPDATE SET
       helpfulness_rating = EXCLUDED.helpfulness_rating,
       ease_rating = EXCLUDED.ease_rating,
       would_return_rating = EXCLUDED.would_return_rating,
       comments = EXCLUDED.comments
     RETURNING *`,
    [sessionId, input.helpfulness_rating ?? null, input.ease_rating ?? null, input.would_return_rating ?? null, comments]
  );
  return result.rows[0];
}

export async function getSessionFeedback(sessionId: string): Promise<SessionFeedbackRow | null> {
  const result = await pool.query<SessionFeedbackRow>(
    'SELECT * FROM session_feedback WHERE session_id = $1',
    [sessionId]
  );
  return result.rows[0] ?? null;
}

export interface FeedbackAggregate {
  responses: number;
  avg_helpfulness: number | null;
  avg_ease: number | null;
  avg_would_return: number | null;
}

/** Simple averages across all submitted feedback, for the admin analytics summary. */
export async function getFeedbackAggregate(): Promise<FeedbackAggregate> {
  const result = await pool.query<{
    responses: string;
    avg_helpfulness: string | null;
    avg_ease: string | null;
    avg_would_return: string | null;
  }>(
    `SELECT COUNT(*) AS responses,
            AVG(helpfulness_rating) AS avg_helpfulness,
            AVG(ease_rating) AS avg_ease,
            AVG(would_return_rating) AS avg_would_return
     FROM session_feedback`
  );
  const row = result.rows[0];
  return {
    responses: parseInt(row?.responses ?? '0', 10),
    avg_helpfulness: row?.avg_helpfulness ? Math.round(parseFloat(row.avg_helpfulness) * 10) / 10 : null,
    avg_ease: row?.avg_ease ? Math.round(parseFloat(row.avg_ease) * 10) / 10 : null,
    avg_would_return: row?.avg_would_return ? Math.round(parseFloat(row.avg_would_return) * 10) / 10 : null,
  };
}
