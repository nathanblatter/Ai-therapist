// Storage for the structured per-session features (migration 135,
// ai-therapist-172). Rows hold probabilities, booleans and codebook option
// names only: the transcript the judge read is never stored here, only a
// digest that tells whether it has changed since.
//
// Which sessions may be coded, which messages are read, the fingerprint and
// the claim are the shared judge rules of sessionJudge.queries.ts, the same
// ones the alliance ratings use.
import { pool } from '../config/db.js';
import { JUDGE_ELIGIBLE_SESSION_SQL, judgeRowStaleSql, withSessionJudgeClaim } from './sessionJudge.queries.js';
import type { SessionFeatureValues } from '../services/sessionFeatures.js';

export type SessionFeaturesStatus = 'extracted' | 'too_short' | 'errored';

export interface SessionFeaturesRow {
  feature_row_id: string;
  session_id: string;
  feature_set_version: string;
  status: SessionFeaturesStatus;
  /** Variable name -> answer; null unless status is 'extracted'. */
  features: SessionFeatureValues | null;
  unknown_count: number | null;
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
  extracted_at: string;
  created_at: string;
}

/** A stored row as a reader gets it: with whether it is stale, that is,
 *  whether the session's readable transcript has changed since. */
export type SessionFeaturesRead = SessionFeaturesRow & { stale: boolean };

export interface NewSessionFeatures {
  sessionId: string;
  featureSetVersion: string;
  status: SessionFeaturesStatus;
  /** Present for 'extracted' only. */
  features?: SessionFeatureValues | null;
  unknownCount?: number | null;
  participantTurns: number | null;
  participantWords: number | null;
  transcriptChars: number | null;
  transcriptTruncated: boolean;
  /** What the row was computed from (getTranscriptForJudge). */
  transcriptMessages: number;
  transcriptFingerprint: string;
  model: string | null;
  tokensIn: number | null;
  tokensOut: number | null;
  error?: string | null;
}

/** SQL boolean: the features row (alias) was computed from a transcript that
 *  is not the session's readable transcript now. */
export const sessionFeaturesStaleSql = judgeRowStaleSql;

/** The claim for (session, feature-set version): see withSessionJudgeClaim.
 *  Its own namespace, so it never blocks an alliance rating. */
export function withSessionFeaturesClaim<T>(
  sessionId: string,
  featureSetVersion: string,
  fn: () => Promise<T>,
): Promise<{ acquired: true; result: T } | { acquired: false }> {
  return withSessionJudgeClaim('session_features', sessionId, featureSetVersion, fn);
}

/**
 * Insert or replace the row for (session, feature-set version).
 *
 * One rule is enforced here, in the statement itself, whatever the caller
 * checked: a failed attempt ('errored') never replaces an answer. When the
 * row already holds 'extracted' or 'too_short', an errored result leaves it
 * exactly as it was and this returns null. (If that answer is stale it stays
 * stale, flagged as such to every reader and listed again for the backfill:
 * a real answer about an older transcript is not traded for no answer.)
 */
export async function upsertSessionFeatures(row: NewSessionFeatures): Promise<SessionFeaturesRow | null> {
  const { rows } = await pool.query<SessionFeaturesRow>(
    `INSERT INTO session_features
       (session_id, feature_set_version, status, features, unknown_count,
        participant_turns, participant_words, transcript_chars, transcript_truncated,
        transcript_messages, transcript_fingerprint, model, tokens_in, tokens_out, error)
     VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
     ON CONFLICT (session_id, feature_set_version) DO UPDATE SET
       status = EXCLUDED.status,
       features = EXCLUDED.features,
       unknown_count = EXCLUDED.unknown_count,
       participant_turns = EXCLUDED.participant_turns,
       participant_words = EXCLUDED.participant_words,
       transcript_chars = EXCLUDED.transcript_chars,
       transcript_truncated = EXCLUDED.transcript_truncated,
       transcript_messages = EXCLUDED.transcript_messages,
       transcript_fingerprint = EXCLUDED.transcript_fingerprint,
       model = EXCLUDED.model,
       tokens_in = EXCLUDED.tokens_in,
       tokens_out = EXCLUDED.tokens_out,
       error = EXCLUDED.error,
       extracted_at = CURRENT_TIMESTAMP
       WHERE NOT (EXCLUDED.status = 'errored' AND session_features.status <> 'errored')
     RETURNING *`,
    [
      row.sessionId,
      row.featureSetVersion,
      row.status,
      row.features ? JSON.stringify(row.features) : null,
      row.unknownCount ?? null,
      row.participantTurns,
      row.participantWords,
      row.transcriptChars,
      row.transcriptTruncated,
      row.transcriptMessages,
      row.transcriptFingerprint,
      row.model,
      row.tokensIn,
      row.tokensOut,
      row.error ? row.error.slice(0, 300) : null,
    ],
  );
  return rows[0] ?? null;
}

/** The row for one session under one feature-set version, or null. */
export async function getSessionFeatures(
  sessionId: string,
  featureSetVersion: string,
): Promise<SessionFeaturesRow | null> {
  const { rows } = await pool.query<SessionFeaturesRow>(
    `SELECT * FROM session_features WHERE session_id = $1 AND feature_set_version = $2`,
    [sessionId, featureSetVersion],
  );
  return rows[0] ?? null;
}

/** The most recent row for a session under any feature-set version, with
 *  whether it is stale, or null. */
export async function getLatestSessionFeatures(sessionId: string): Promise<SessionFeaturesRead | null> {
  const { rows } = await pool.query<SessionFeaturesRead>(
    `SELECT sf.*, ${sessionFeaturesStaleSql('sf')} AS stale
       FROM session_features sf
      WHERE sf.session_id = $1
      ORDER BY sf.extracted_at DESC, sf.feature_row_id DESC
      LIMIT 1`,
    [sessionId],
  );
  return rows[0] ?? null;
}

/**
 * Eligible sessions with no current answer under this feature-set version,
 * oldest first: never coded, coded from a transcript that has since changed
 * (stale), or, unless `includeErrored` is false, a failed attempt.
 */
export async function getSessionsNeedingFeatures(
  featureSetVersion: string,
  opts: { limit?: number | null; includeErrored?: boolean } = {},
): Promise<string[]> {
  const includeErrored = opts.includeErrored !== false;
  const { rows } = await pool.query<{ session_id: string }>(
    `SELECT ts.session_id
       FROM therapy_sessions ts
       LEFT JOIN session_features sf
         ON sf.session_id = ts.session_id AND sf.feature_set_version = $1
      WHERE ${JUDGE_ELIGIBLE_SESSION_SQL}
        AND (sf.feature_row_id IS NULL
             OR ($2::boolean AND sf.status = 'errored')
             OR (sf.status <> 'errored' AND ${sessionFeaturesStaleSql('sf')}))
      ORDER BY ts.created_at ASC, ts.session_id ASC
      LIMIT $3`,
    [featureSetVersion, includeErrored, opts.limit ?? null],
  );
  return rows.map((r) => r.session_id);
}
