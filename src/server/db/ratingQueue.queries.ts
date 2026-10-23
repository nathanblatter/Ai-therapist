// Rating-queue rows (eval program WP2, migration 114): sessions sampled for
// blind human rating on the eval rubric. Written by
// services/ratingSampler.service.ts (sampling) and routes/admin/evals.routes.ts
// (claim / skip / submit-links-to-queue); read by the Rating queue view and by
// the blind-mode gate on the session eval endpoints.
import { pool } from '../config/db.js';
import { ownerOrgScopeSql } from './organizations.queries.js';

export type RatingQueueSource = 'stratified' | 'disagreement' | 'manual';
export type RatingQueueStatus = 'queued' | 'in_progress' | 'rated' | 'skipped';

export interface RatingQueueRow {
  queue_id: number;
  session_id: string;
  stratum: string;
  source: RatingQueueSource;
  status: RatingQueueStatus;
  assigned_to: number | null;
  second_rater_id: number | null;
  needs_second_rater: boolean;
  crisis_adjacent: boolean;
  enqueued_at: Date;
  enqueued_by: number | null;
  claimed_at: Date | null;
  rated_at: Date | null;
  skipped_at: Date | null;
  skipped_by: number | null;
}

/** A queue row joined with what the list view renders. */
export interface RatingQueueListRow extends RatingQueueRow {
  session_type: string | null;
  ended_at: Date | null;
  anonymous: boolean;
  assigned_to_username: string | null;
  second_rater_username: string | null;
  /** Distinct raters with a stored rating on the session. */
  rating_count: number;
  rated_by_me: boolean;
}

/** One ended session the sampler may pick, with its risk signals. */
export interface RatingCandidateRow {
  session_id: string;
  session_type: string | null;
  ended_at: Date;
  crisis_flagged: boolean;
  /** max(therapy_sessions.crisis_risk_score, max(risk_score_history.risk_score)), 0 when unscored. */
  max_risk_score: number;
  crisis_event_count: number;
}

/**
 * Ended, non-demo, non-sandbox sessions with at least one participant turn,
 * ended on/after `since`, not already queued. Deterministic order so a seeded
 * sampler over this list is reproducible.
 */
export async function getRatingCandidates(since: Date, limit = 5000): Promise<RatingCandidateRow[]> {
  const result = await pool.query<RatingCandidateRow>(
    `SELECT ts.session_id, ts.session_type,
            COALESCE(ts.ended_at, ts.updated_at) AS ended_at,
            COALESCE(ts.crisis_flagged, FALSE) AS crisis_flagged,
            GREATEST(COALESCE(ts.crisis_risk_score, 0), COALESCE(rsh.max_risk, 0))::int AS max_risk_score,
            COALESCE(ce.n, 0)::int AS crisis_event_count
     FROM therapy_sessions ts
     LEFT JOIN users u ON u.userid = ts.user_id
     LEFT JOIN LATERAL (
       SELECT MAX(r.risk_score) AS max_risk FROM risk_score_history r WHERE r.session_id = ts.session_id
     ) rsh ON TRUE
     LEFT JOIN LATERAL (
       SELECT COUNT(*) AS n FROM crisis_events c WHERE c.session_id = ts.session_id
     ) ce ON TRUE
     WHERE ts.status = 'ended'
       AND ts.is_demo IS NOT TRUE
       AND u.is_sandbox IS NOT TRUE
       AND COALESCE(ts.ended_at, ts.updated_at) >= $1
       AND EXISTS (SELECT 1 FROM messages m WHERE m.session_id = ts.session_id AND m.role = 'user')
       AND NOT EXISTS (SELECT 1 FROM eval_rating_queue q WHERE q.session_id = ts.session_id)
     ORDER BY ts.session_id
     LIMIT $2`,
    [since, limit],
  );
  return result.rows;
}

export interface NewRatingQueueRow {
  session_id: string;
  stratum: string;
  source: RatingQueueSource;
  needs_second_rater: boolean;
  crisis_adjacent: boolean;
}

/** Insert queue rows; a session already queued is left alone (ON CONFLICT DO
 *  NOTHING). Returns the rows actually inserted. */
export async function insertRatingQueueRows(
  rows: NewRatingQueueRow[],
  enqueuedBy: number | null,
): Promise<RatingQueueRow[]> {
  if (rows.length === 0) return [];
  const result = await pool.query<RatingQueueRow>(
    `INSERT INTO eval_rating_queue (session_id, stratum, source, needs_second_rater, crisis_adjacent, enqueued_by)
     SELECT s.session_id, s.stratum, s.source, s.needs_second_rater, s.crisis_adjacent, $2
     FROM jsonb_to_recordset($1::jsonb)
       AS s(session_id text, stratum text, source text, needs_second_rater boolean, crisis_adjacent boolean)
     ON CONFLICT (session_id) DO NOTHING
     RETURNING *`,
    [JSON.stringify(rows), enqueuedBy],
  );
  return result.rows;
}

/** Sessions (by id) that are ended, non-demo and not sandbox-owned, with the
 *  signals the manual/disagreement enqueue path needs to build a stratum. */
export async function getRatingCandidatesByIds(sessionIds: string[]): Promise<RatingCandidateRow[]> {
  if (sessionIds.length === 0) return [];
  const result = await pool.query<RatingCandidateRow>(
    `SELECT ts.session_id, ts.session_type,
            COALESCE(ts.ended_at, ts.updated_at) AS ended_at,
            COALESCE(ts.crisis_flagged, FALSE) AS crisis_flagged,
            GREATEST(COALESCE(ts.crisis_risk_score, 0), COALESCE(rsh.max_risk, 0))::int AS max_risk_score,
            COALESCE(ce.n, 0)::int AS crisis_event_count
     FROM therapy_sessions ts
     LEFT JOIN users u ON u.userid = ts.user_id
     LEFT JOIN LATERAL (
       SELECT MAX(r.risk_score) AS max_risk FROM risk_score_history r WHERE r.session_id = ts.session_id
     ) rsh ON TRUE
     LEFT JOIN LATERAL (
       SELECT COUNT(*) AS n FROM crisis_events c WHERE c.session_id = ts.session_id
     ) ce ON TRUE
     WHERE ts.session_id = ANY($1::text[])
       AND ts.status = 'ended'
       AND ts.is_demo IS NOT TRUE
       AND u.is_sandbox IS NOT TRUE
     ORDER BY ts.session_id`,
    [sessionIds],
  );
  return result.rows;
}

export interface RatingQueueScope {
  /** Care-team member id: restrict to sessions owned by their caseload. */
  scopeTherapistId?: number | null;
  /** Researcher organization: restrict to sessions owned in that org (anonymous -> irb-study). */
  orgId?: number | null;
}

export interface ListRatingQueueOptions extends RatingQueueScope {
  /** The caller (for rated_by_me and scope=mine). */
  userId: number;
  mine?: boolean;
  status?: RatingQueueStatus | 'open';
  limit?: number;
}

function scopeClauses(scope: RatingQueueScope, params: unknown[], ownerExpr: string): string {
  let clause = '';
  if (scope.scopeTherapistId !== null && scope.scopeTherapistId !== undefined) {
    params.push(scope.scopeTherapistId);
    clause += `
       AND EXISTS (SELECT 1 FROM therapist_clients tc WHERE tc.therapist_id = $${params.length} AND tc.client_id = ${ownerExpr})`;
  }
  if (scope.orgId !== null && scope.orgId !== undefined) {
    params.push(scope.orgId);
    clause += `
       AND ${ownerOrgScopeSql(`$${params.length}`, ownerExpr)}`;
  }
  return clause;
}

/** Queue rows visible to the caller, newest first. */
export async function listRatingQueue(opts: ListRatingQueueOptions): Promise<RatingQueueListRow[]> {
  const params: unknown[] = [opts.userId];
  let where = `WHERE ts.is_demo IS NOT TRUE`;
  where += scopeClauses(opts, params, 'ts.user_id');
  if (opts.mine) {
    where += `
       AND (q.assigned_to = $1 OR q.second_rater_id = $1)`;
  }
  if (opts.status === 'open') {
    where += `
       AND q.status IN ('queued', 'in_progress')`;
  } else if (opts.status) {
    params.push(opts.status);
    where += `
       AND q.status = $${params.length}`;
  }
  params.push(opts.limit ?? 200);
  const result = await pool.query<RatingQueueListRow>(
    `SELECT q.*, ts.session_type, ts.ended_at, (ts.user_id IS NULL) AS anonymous,
            a.username AS assigned_to_username, b.username AS second_rater_username,
            (SELECT COUNT(DISTINCT hr.rater_user_id) FROM session_human_ratings hr WHERE hr.session_id = q.session_id)::int AS rating_count,
            EXISTS (SELECT 1 FROM session_human_ratings hr WHERE hr.session_id = q.session_id AND hr.rater_user_id = $1) AS rated_by_me
     FROM eval_rating_queue q
     JOIN therapy_sessions ts ON ts.session_id = q.session_id
     LEFT JOIN users a ON a.userid = q.assigned_to
     LEFT JOIN users b ON b.userid = q.second_rater_id
     ${where}
     ORDER BY (q.status IN ('queued', 'in_progress')) DESC, q.crisis_adjacent DESC, q.enqueued_at DESC, q.queue_id DESC
     LIMIT $${params.length}`,
    params,
  );
  return result.rows;
}

export interface RatingQueueCounts {
  queued: number;
  in_progress: number;
  rated: number;
  skipped: number;
  /** Sessions marked for two raters that have fewer than two distinct ratings. */
  awaiting_second_rater: number;
  /** Sessions with two or more distinct ratings (feeds human-human kappa). */
  double_rated: number;
}

/** Status counts over the caller-visible queue. */
export async function getRatingQueueCounts(scope: RatingQueueScope): Promise<RatingQueueCounts> {
  const params: unknown[] = [];
  const where = `WHERE ts.is_demo IS NOT TRUE${scopeClauses(scope, params, 'ts.user_id')}`;
  const result = await pool.query<RatingQueueCounts>(
    `WITH rows AS (
       SELECT q.status, q.needs_second_rater,
              (SELECT COUNT(DISTINCT hr.rater_user_id) FROM session_human_ratings hr WHERE hr.session_id = q.session_id) AS n_raters
       FROM eval_rating_queue q
       JOIN therapy_sessions ts ON ts.session_id = q.session_id
       ${where}
     )
     SELECT COUNT(*) FILTER (WHERE status = 'queued')::int AS queued,
            COUNT(*) FILTER (WHERE status = 'in_progress')::int AS in_progress,
            COUNT(*) FILTER (WHERE status = 'rated')::int AS rated,
            COUNT(*) FILTER (WHERE status = 'skipped')::int AS skipped,
            COUNT(*) FILTER (WHERE needs_second_rater AND n_raters < 2 AND status <> 'skipped')::int AS awaiting_second_rater,
            COUNT(*) FILTER (WHERE n_raters >= 2)::int AS double_rated
     FROM rows`,
    params,
  );
  return result.rows[0];
}

export async function getRatingQueueRow(queueId: number): Promise<RatingQueueRow | null> {
  const result = await pool.query<RatingQueueRow>('SELECT * FROM eval_rating_queue WHERE queue_id = $1', [queueId]);
  return result.rows[0] ?? null;
}

export async function getRatingQueueRowForSession(sessionId: string): Promise<RatingQueueRow | null> {
  const result = await pool.query<RatingQueueRow>('SELECT * FROM eval_rating_queue WHERE session_id = $1', [sessionId]);
  return result.rows[0] ?? null;
}

/**
 * Claim a queue row for `userId`: first claimant becomes assigned_to; a
 * different user may take the second-rater slot when the sampler asked for
 * one. Idempotent for a user who already holds a slot. Returns null when the
 * row is not claimable (unknown, rated/skipped, or both slots taken by
 * others) so the route can answer 409.
 */
export async function claimRatingQueueRow(queueId: number, userId: number): Promise<RatingQueueRow | null> {
  const result = await pool.query<RatingQueueRow>(
    `UPDATE eval_rating_queue
       SET assigned_to = CASE WHEN assigned_to IS NULL THEN $2 ELSE assigned_to END,
           second_rater_id = CASE
             WHEN assigned_to IS NOT NULL AND assigned_to <> $2 AND needs_second_rater AND second_rater_id IS NULL THEN $2
             ELSE second_rater_id END,
           status = CASE WHEN status = 'queued' THEN 'in_progress' ELSE status END,
           claimed_at = COALESCE(claimed_at, CURRENT_TIMESTAMP)
     WHERE queue_id = $1
       AND status IN ('queued', 'in_progress')
       AND (assigned_to IS NULL OR assigned_to = $2 OR second_rater_id = $2
            OR (needs_second_rater AND second_rater_id IS NULL AND assigned_to <> $2))
     RETURNING *`,
    [queueId, userId],
  );
  return result.rows[0] ?? null;
}

/** Skip an open row. Returns null when the row is not open. */
export async function skipRatingQueueRow(queueId: number, userId: number): Promise<RatingQueueRow | null> {
  const result = await pool.query<RatingQueueRow>(
    `UPDATE eval_rating_queue
       SET status = 'skipped', skipped_at = CURRENT_TIMESTAMP, skipped_by = $2
     WHERE queue_id = $1 AND status IN ('queued', 'in_progress')
     RETURNING *`,
    [queueId, userId],
  );
  return result.rows[0] ?? null;
}

/**
 * Link a freshly saved human rating to the session's queue row: the rater
 * takes a free slot if they had none, and the row becomes `rated` once every
 * required rater (1, or 2 when needs_second_rater) has a stored rating.
 * No-op (null) when the session is not queued or the row was skipped.
 */
export async function linkRatingToQueue(sessionId: string, raterUserId: number): Promise<RatingQueueRow | null> {
  const result = await pool.query<RatingQueueRow>(
    `WITH n AS (
       SELECT COUNT(DISTINCT rater_user_id)::int AS raters
       FROM session_human_ratings WHERE session_id = $1
     )
     UPDATE eval_rating_queue q
       SET assigned_to = COALESCE(q.assigned_to, $2),
           second_rater_id = CASE
             WHEN q.assigned_to IS NOT NULL AND q.assigned_to <> $2 AND q.second_rater_id IS NULL THEN $2
             ELSE q.second_rater_id END,
           claimed_at = COALESCE(q.claimed_at, CURRENT_TIMESTAMP),
           status = CASE WHEN n.raters >= (CASE WHEN q.needs_second_rater THEN 2 ELSE 1 END) THEN 'rated' ELSE 'in_progress' END,
           rated_at = CASE WHEN n.raters >= (CASE WHEN q.needs_second_rater THEN 2 ELSE 1 END) THEN COALESCE(q.rated_at, CURRENT_TIMESTAMP) ELSE q.rated_at END
     FROM n
     WHERE q.session_id = $1 AND q.status <> 'skipped'
     RETURNING q.*`,
    [sessionId, raterUserId],
  );
  return result.rows[0] ?? null;
}

/** Has this user stored a rating for the session? (blind-mode gate) */
export async function hasHumanRating(sessionId: string, raterUserId: number): Promise<boolean> {
  const result = await pool.query('SELECT 1 FROM session_human_ratings WHERE session_id = $1 AND rater_user_id = $2', [
    sessionId,
    raterUserId,
  ]);
  return result.rows.length > 0;
}
