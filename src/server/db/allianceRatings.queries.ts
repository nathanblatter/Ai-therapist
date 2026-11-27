// Storage and eligibility for the linguistic working-alliance ratings
// (migration 134, ai-therapist-173). Rows hold numbers only: the transcript
// the judge read is never stored here, only a digest that tells whether it
// has changed since.
import { pool } from '../config/db.js';
import { leakCheckNeedsReviewSql } from './leakCheckSql.js';
import { redactableRowsSql } from './redactionScope.js';
import { notUnverifiedSpeechSql } from './unverifiedSpeech.js';
import type { AllianceSubscale, AllianceTurn, SubscaleRating } from '../services/allianceMarkers.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('allianceRatings');

export type AllianceRatingStatus = 'rated' | 'too_short' | 'errored';

export interface AllianceRatingRow {
  rating_id: string;
  session_id: string;
  judge_version: string;
  status: AllianceRatingStatus;
  task_rateable: boolean | null;
  task_p_rateable: number | null;
  task_score: number | null;
  task_level: number | null;
  task_confidence: number | null;
  task_distribution: number[] | null;
  bond_rateable: boolean | null;
  bond_p_rateable: number | null;
  bond_score: number | null;
  bond_level: number | null;
  bond_confidence: number | null;
  bond_distribution: number[] | null;
  goal_rateable: boolean | null;
  goal_p_rateable: number | null;
  goal_score: number | null;
  goal_level: number | null;
  goal_confidence: number | null;
  goal_distribution: number[] | null;
  participant_turns: number | null;
  participant_words: number | null;
  transcript_chars: number | null;
  transcript_truncated: boolean;
  /** Messages the judge was given, and the digest of their ids and text. */
  transcript_messages: number;
  transcript_fingerprint: string;
  model: string | null;
  tokens_in: number | null;
  tokens_out: number | null;
  error: string | null;
  rated_at: string;
  created_at: string;
}

/** A stored rating as a reader gets it: with whether it is stale, that is,
 *  whether the session's readable transcript has changed since it was rated. */
export type AllianceRatingRead = AllianceRatingRow & { stale: boolean };

/** What a rating stores per subscale. The judge always gives a probability
 *  that the subscale is rateable; a session under the length floor was never
 *  sent to the judge and has none (NULL, not an invented 0). */
export type StoredSubscaleRating = Omit<SubscaleRating, 'pRateable'> & { pRateable: number | null };

export interface NewAllianceRating {
  sessionId: string;
  judgeVersion: string;
  status: AllianceRatingStatus;
  /** Absent for an errored row: every rating column is stored NULL. */
  subscales?: Record<AllianceSubscale, StoredSubscaleRating>;
  participantTurns: number | null;
  participantWords: number | null;
  transcriptChars: number | null;
  transcriptTruncated: boolean;
  /** What the rating was computed from (getTranscriptForAlliance). */
  transcriptMessages: number;
  transcriptFingerprint: string;
  model: string | null;
  tokensIn: number | null;
  tokensOut: number | null;
  error?: string | null;
}

/**
 * The session-level rule every caller shares (the post-session hook, the
 * backfill and the script): which sessions the alliance judge may rate.
 * Only ended sessions of enrolled study participants:
 *
 *   - ended;
 *   - not is_demo: demo accounts, the red-team/eval harness and sandbox seeds
 *     all carry is_demo (the same exclusion the dataset export and the
 *     auto-evaluation hook use);
 *   - owned by an enrolled study participant: an account with role
 *     'participant' (so no session of a staff account: therapist, researcher,
 *     admin, demo) that is not a sandbox account and has not withdrawn
 *     (users.study_status, stamped by the withdrawal survey or by a
 *     researcher). An anonymous session (user_id NULL, which is also what an
 *     account deletion leaves behind) has no such owner and is never rated.
 *     This is the participant definition of the dataset export
 *     (ensurePseudonyms) with the withdrawal exclusion of the screener-trend
 *     analysis (workQueue.queries.ts), the strictest rule any research read
 *     applies; the export itself keeps a withdrawn participant's rows and
 *     labels them in participants.csv. A paused participant is still enrolled;
 *   - redaction complete: at least one redactable row with content, and none
 *     of them still waiting for content_redacted (the definition behind the
 *     admin "complete" label, db/adminSessions.queries.ts). A message whose
 *     redaction was rejected keeps the session ineligible: the judge never
 *     reads raw text to fill the gap.
 *
 * Which MESSAGES of an eligible session the judge reads is a separate rule:
 * allianceReadableTurnSql below.
 *
 * `ts` must alias therapy_sessions.
 */
export const ALLIANCE_ELIGIBLE_SESSION_SQL = `
  ts.status = 'ended'
  AND ts.is_demo IS NOT TRUE
  AND EXISTS (
    SELECT 1 FROM users u
     WHERE u.userid = ts.user_id
       AND u.role = 'participant'
       AND u.is_sandbox IS NOT TRUE
       AND COALESCE(u.study_status, 'active') <> 'withdrawn')
  AND EXISTS (
    SELECT 1 FROM messages m
     WHERE m.session_id = ts.session_id AND ${redactableRowsSql('m')} AND m.content_redacted IS NOT NULL)
  AND NOT EXISTS (
    SELECT 1 FROM messages m
     WHERE m.session_id = ts.session_id AND ${redactableRowsSql('m')}
       AND m.content IS NOT NULL AND m.content_redacted IS NULL)`;

/** Is this one session eligible right now? */
export async function isSessionAllianceEligible(sessionId: string): Promise<boolean> {
  const { rows } = await pool.query(
    `SELECT 1 FROM therapy_sessions ts WHERE ts.session_id = $1 AND ${ALLIANCE_ELIGIBLE_SESSION_SQL}`,
    [sessionId],
  );
  return rows.length > 0;
}

/**
 * The message-level rule: which rows of a session the judge reads.
 *
 *   - a participant or assistant turn with redacted text;
 *   - not a participant voice turn the vendor transcribed while the
 *     microphone was muted (metadata.unverified_speech, ai-therapist-412):
 *     nobody said it;
 *   - not waiting for leak review: a message whose redaction leak check
 *     flagged it or could not run (errored), and that no researcher has
 *     reviewed yet, is withheld from the judge exactly as it is withheld from
 *     researcher semantic search (leakCheckSql.ts; redactionCompleteSql in
 *     semanticSearch.queries.ts). A message stored as redaction_passthrough
 *     is read like any other.
 *
 * The transcript fingerprint is taken over exactly these rows, so a message
 * that enters or leaves this set makes the stored rating stale.
 */
export function allianceReadableTurnSql(alias: string): string {
  return `(${alias}.role IN ('user', 'assistant')
    AND ${alias}.content_redacted IS NOT NULL
    AND ${notUnverifiedSpeechSql(alias)}
    AND NOT ${leakCheckNeedsReviewSql(alias)})`;
}

/** Fingerprint of a session with no readable turn. */
export const EMPTY_TRANSCRIPT_FINGERPRINT = 'empty';

// MD5 over "<message id>:<md5 of the redacted text>" of every readable turn,
// in transcript order. A new turn, a removed or withheld turn, and any change
// to a turn's redacted text all change it. One definition, used both when a
// transcript is read for rating and when a stored rating is checked.
function fingerprintAggSql(alias: string): string {
  return `md5(string_agg(${alias}.message_id::text || ':' || md5(${alias}.content_redacted), ','
                         ORDER BY ${alias}.created_at ASC, ${alias}.message_id ASC))`;
}

/** SQL expression: the fingerprint of a session's readable transcript NOW. */
export function allianceTranscriptFingerprintSql(sessionIdExpr: string): string {
  return `(SELECT COALESCE(${fingerprintAggSql('fm')}, '${EMPTY_TRANSCRIPT_FINGERPRINT}')
             FROM messages fm
            WHERE fm.session_id = ${sessionIdExpr} AND ${allianceReadableTurnSql('fm')})`;
}

/**
 * SQL boolean: the rating row (alias) was computed from a transcript that is
 * not the session's readable transcript now. A stale row is rated again by
 * the hook or the backfill; until then every reader is told it is stale.
 */
export function allianceRatingStaleSql(alias: string): string {
  return `(${alias}.transcript_fingerprint IS DISTINCT FROM ${allianceTranscriptFingerprintSql(`${alias}.session_id`)})`;
}

export interface AllianceTranscript {
  turns: AllianceTurn[];
  /** Identifies exactly these turns; stored with the rating. */
  fingerprint: string;
}

/**
 * The conversation as the judge reads it (allianceReadableTurnSql):
 * participant and assistant turns only, REDACTED text only, with the
 * fingerprint of exactly the rows returned (one statement, one snapshot).
 * This query never selects messages.content, so raw text cannot reach the
 * judge through it.
 */
export async function getTranscriptForAlliance(sessionId: string): Promise<AllianceTranscript> {
  const { rows } = await pool.query<{ role: string; content_redacted: string; fingerprint: string }>(
    `WITH t AS (
       SELECT m.message_id, m.role, m.content_redacted, m.created_at
         FROM messages m
        WHERE m.session_id = $1 AND ${allianceReadableTurnSql('m')})
     SELECT t.role, t.content_redacted, (SELECT ${fingerprintAggSql('x')} FROM t x) AS fingerprint
       FROM t
      ORDER BY t.created_at ASC, t.message_id ASC`,
    [sessionId],
  );
  return {
    turns: rows.map((r) => ({
      role: r.role === 'user' ? ('participant' as const) : ('assistant' as const),
      text: r.content_redacted,
    })),
    fingerprint: rows[0]?.fingerprint ?? EMPTY_TRANSCRIPT_FINGERPRINT,
  };
}

/**
 * For the leak-review hook: the session a message belongs to and how many of
 * that session's messages are still waiting for leak review. Null when the
 * message does not exist.
 */
export async function getLeakReviewStateForMessage(
  messageId: string | number,
): Promise<{ sessionId: string; awaitingReview: number } | null> {
  const { rows } = await pool.query<{ session_id: string; awaiting: string }>(
    `SELECT msg.session_id,
            (SELECT COUNT(*) FROM messages m
              WHERE m.session_id = msg.session_id AND ${leakCheckNeedsReviewSql('m')}) AS awaiting
       FROM messages msg
      WHERE msg.message_id = $1`,
    [messageId],
  );
  if (!rows[0]?.session_id) return null;
  return { sessionId: rows[0].session_id, awaitingReview: Number(rows[0].awaiting) };
}

/**
 * Run `fn` while holding the rating claim for (session, judge version), so
 * two runs that overlap (the post-session hook and the backfill, or two
 * backfills) do not both pay for the same session. A session-level advisory
 * lock on a connection held for the duration: it is released when `fn`
 * settles, and by Postgres itself if the process or the connection dies, so
 * there is no claim row to expire. Returns { acquired: false } without
 * running `fn` when another run holds the claim.
 */
export async function withAllianceRatingClaim<T>(
  sessionId: string,
  judgeVersion: string,
  fn: () => Promise<T>,
): Promise<{ acquired: true; result: T } | { acquired: false }> {
  const key = `${sessionId}|${judgeVersion}`;
  const client = await pool.connect();
  let broken = false;
  try {
    const { rows } = await client.query<{ locked: boolean }>(
      `SELECT pg_try_advisory_lock(hashtext('session_alliance_ratings'), hashtext($1)) AS locked`,
      [key],
    );
    if (!rows[0]?.locked) return { acquired: false };
    try {
      return { acquired: true, result: await fn() };
    } finally {
      try {
        await client.query(`SELECT pg_advisory_unlock(hashtext('session_alliance_ratings'), hashtext($1))`, [key]);
      } catch (err) {
        // The lock dies with the connection: do not hand it back to the pool.
        broken = true;
        log.warn({ err }, 'could not release the alliance rating claim; closing its connection');
      }
    }
  } finally {
    client.release(broken);
  }
}

const SUBSCALE_COLUMNS = ['rateable', 'p_rateable', 'score', 'level', 'confidence', 'distribution'] as const;

/**
 * Insert or replace the rating for (session, judge version).
 *
 * One rule is enforced here, in the statement itself, whatever the caller
 * checked: a failed attempt ('errored') never replaces an answer. When the
 * row already holds 'rated' or 'too_short', an errored result leaves it
 * exactly as it was and this returns null. (If that answer is stale it stays
 * stale, flagged as such to every reader and listed again for the backfill:
 * a real rating of an older transcript is not traded for no rating.)
 */
export async function upsertAllianceRating(rating: NewAllianceRating): Promise<AllianceRatingRow | null> {
  const columns = [
    'session_id',
    'judge_version',
    'status',
    'participant_turns',
    'participant_words',
    'transcript_chars',
    'transcript_truncated',
    'transcript_messages',
    'transcript_fingerprint',
    'model',
    'tokens_in',
    'tokens_out',
    'error',
  ];
  const values: unknown[] = [
    rating.sessionId,
    rating.judgeVersion,
    rating.status,
    rating.participantTurns,
    rating.participantWords,
    rating.transcriptChars,
    rating.transcriptTruncated,
    rating.transcriptMessages,
    rating.transcriptFingerprint,
    rating.model,
    rating.tokensIn,
    rating.tokensOut,
    rating.error ? rating.error.slice(0, 300) : null,
  ];
  for (const subscale of ['task', 'bond', 'goal'] as const) {
    const s = rating.subscales?.[subscale];
    for (const col of SUBSCALE_COLUMNS) columns.push(`${subscale}_${col}`);
    values.push(
      s ? s.rateable : null,
      s ? s.pRateable : null,
      s ? s.score : null,
      s ? s.level : null,
      s ? s.confidence : null,
      s?.distribution ? JSON.stringify(s.distribution) : null,
    );
  }
  const placeholders = columns.map((_, i) => `$${i + 1}`);
  const updates = columns
    .filter((c) => c !== 'session_id' && c !== 'judge_version')
    .map((c) => `${c} = EXCLUDED.${c}`)
    .concat('rated_at = CURRENT_TIMESTAMP');
  const { rows } = await pool.query<AllianceRatingRow>(
    `INSERT INTO session_alliance_ratings (${columns.join(', ')})
     VALUES (${placeholders.join(', ')})
     ON CONFLICT (session_id, judge_version) DO UPDATE SET ${updates.join(', ')}
       WHERE NOT (EXCLUDED.status = 'errored' AND session_alliance_ratings.status <> 'errored')
     RETURNING *`,
    values,
  );
  return rows[0] ?? null;
}

/** The rating for one session under one judge version, or null. */
export async function getAllianceRating(sessionId: string, judgeVersion: string): Promise<AllianceRatingRow | null> {
  const { rows } = await pool.query<AllianceRatingRow>(
    `SELECT * FROM session_alliance_ratings WHERE session_id = $1 AND judge_version = $2`,
    [sessionId, judgeVersion],
  );
  return rows[0] ?? null;
}

/** The most recent rating for a session under any judge version, with
 *  whether it is stale, or null. */
export async function getLatestAllianceRating(sessionId: string): Promise<AllianceRatingRead | null> {
  const { rows } = await pool.query<AllianceRatingRead>(
    `SELECT ar.*, ${allianceRatingStaleSql('ar')} AS stale
       FROM session_alliance_ratings ar
      WHERE ar.session_id = $1
      ORDER BY ar.rated_at DESC, ar.rating_id DESC
      LIMIT 1`,
    [sessionId],
  );
  return rows[0] ?? null;
}

/**
 * Eligible sessions with no current answer under this judge version, oldest
 * first: never rated, rated from a transcript that has since changed
 * (stale), or, unless `includeErrored` is false, a failed attempt.
 */
export async function getSessionsNeedingAllianceRating(
  judgeVersion: string,
  opts: { limit?: number | null; includeErrored?: boolean } = {},
): Promise<string[]> {
  const includeErrored = opts.includeErrored !== false;
  const { rows } = await pool.query<{ session_id: string }>(
    `SELECT ts.session_id
       FROM therapy_sessions ts
       LEFT JOIN session_alliance_ratings ar
         ON ar.session_id = ts.session_id AND ar.judge_version = $1
      WHERE ${ALLIANCE_ELIGIBLE_SESSION_SQL}
        AND (ar.rating_id IS NULL
             OR ($2::boolean AND ar.status = 'errored')
             OR (ar.status <> 'errored' AND ${allianceRatingStaleSql('ar')}))
      ORDER BY ts.created_at ASC, ts.session_id ASC
      LIMIT $3`,
    [judgeVersion, includeErrored, opts.limit ?? null],
  );
  return rows.map((r) => r.session_id);
}
