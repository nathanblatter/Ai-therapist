// Storage and eligibility for the linguistic working-alliance ratings
// (migration 134, ai-therapist-173). Rows hold numbers only: the transcript
// the judge read is never stored here, only a digest that tells whether it
// has changed since.
import { pool } from '../config/db.js';
import {
  JUDGE_ELIGIBLE_SESSION_SQL,
  getTranscriptForJudge,
  isSessionJudgeEligible,
  judgeReadableTurnSql,
  judgeRowStaleSql,
  judgeTranscriptFingerprintSql,
  withSessionJudgeClaim,
  type JudgeTranscript,
} from './sessionJudge.queries.js';
import type { AllianceSubscale, SubscaleRating } from '../services/allianceMarkers.js';

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

// Which sessions the judge may rate, which messages it reads, the transcript
// fingerprint behind "stale" and the per-session claim are shared with the
// session-features judge (migration 135) and defined once, with their full
// rationale, in sessionJudge.queries.ts. The names below are the ones this
// feature has always exported; they are the same rules, not copies.

/** Which sessions the alliance judge may rate (JUDGE_ELIGIBLE_SESSION_SQL).
 *  `ts` must alias therapy_sessions. */
export const ALLIANCE_ELIGIBLE_SESSION_SQL = JUDGE_ELIGIBLE_SESSION_SQL;

/** Is this one session eligible right now? */
export const isSessionAllianceEligible = isSessionJudgeEligible;

/** Which rows of a session the judge reads (judgeReadableTurnSql). */
export const allianceReadableTurnSql = judgeReadableTurnSql;

/** SQL expression: the fingerprint of a session's readable transcript NOW. */
export const allianceTranscriptFingerprintSql = judgeTranscriptFingerprintSql;

/**
 * SQL boolean: the rating row (alias) was computed from a transcript that is
 * not the session's readable transcript now. A stale row is rated again by
 * the hook or the backfill; until then every reader is told it is stale.
 */
export const allianceRatingStaleSql = judgeRowStaleSql;

export type AllianceTranscript = JudgeTranscript;

/** The conversation as the judge reads it: redacted text only. */
export const getTranscriptForAlliance = getTranscriptForJudge;

export { EMPTY_TRANSCRIPT_FINGERPRINT, getLeakReviewStateForMessage } from './sessionJudge.queries.js';

/**
 * Run `fn` while holding the rating claim for (session, judge version), so
 * two runs that overlap (the post-session hook and the backfill, or two
 * backfills) do not both pay for the same session (withSessionJudgeClaim).
 */
export function withAllianceRatingClaim<T>(
  sessionId: string,
  judgeVersion: string,
  fn: () => Promise<T>,
): Promise<{ acquired: true; result: T } | { acquired: false }> {
  return withSessionJudgeClaim('session_alliance_ratings', sessionId, judgeVersion, fn);
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
