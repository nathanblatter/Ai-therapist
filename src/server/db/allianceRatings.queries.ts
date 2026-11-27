// Storage and eligibility for the linguistic working-alliance ratings
// (migration 134, ai-therapist-173). Rows hold numbers only: the transcript
// the judge read is never stored here.
import { pool } from '../config/db.js';
import { redactableRowsSql } from './redactionScope.js';
import type { AllianceSubscale, AllianceTurn, SubscaleRating } from '../services/allianceMarkers.js';

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
  model: string | null;
  tokens_in: number | null;
  tokens_out: number | null;
  error: string | null;
  rated_at: string;
  created_at: string;
}

export interface NewAllianceRating {
  sessionId: string;
  judgeVersion: string;
  status: AllianceRatingStatus;
  /** Absent for an errored row: every rating column is stored NULL. */
  subscales?: Record<AllianceSubscale, SubscaleRating>;
  participantTurns: number | null;
  participantWords: number | null;
  transcriptChars: number | null;
  transcriptTruncated: boolean;
  model: string | null;
  tokensIn: number | null;
  tokensOut: number | null;
  error?: string | null;
}

/**
 * The session-level rule every caller shares (the post-session hook, the
 * backfill and the export): which sessions the alliance judge may rate.
 *
 *   - ended;
 *   - not is_demo: demo accounts, the red-team/eval harness and sandbox seeds
 *     all carry is_demo (the same exclusion the dataset export and the
 *     auto-evaluation hook use);
 *   - not owned by a sandbox account (canned fixture transcripts; the same
 *     rule sessionEval.service.ts applies even under force);
 *   - redaction complete: at least one redactable row with content, and none
 *     of them still waiting for content_redacted (the definition behind the
 *     admin "complete" label, db/adminSessions.queries.ts). A message whose
 *     redaction was rejected keeps the session ineligible: the judge never
 *     reads raw text to fill the gap.
 *
 * `ts` must alias therapy_sessions.
 */
export const ALLIANCE_ELIGIBLE_SESSION_SQL = `
  ts.status = 'ended'
  AND ts.is_demo IS NOT TRUE
  AND NOT EXISTS (SELECT 1 FROM users u WHERE u.userid = ts.user_id AND u.is_sandbox IS TRUE)
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
 * The conversation as the judge reads it: participant and assistant turns
 * only, REDACTED text only. This query never selects messages.content, so raw
 * text cannot reach the judge through it. A participant voice turn the vendor
 * transcribed while the microphone was muted (metadata.unverified_speech,
 * ai-therapist-412) is left out: nobody said it.
 */
export async function getRedactedTurnsForAlliance(sessionId: string): Promise<AllianceTurn[]> {
  const { rows } = await pool.query<{ role: string; content_redacted: string }>(
    `SELECT role, content_redacted
       FROM messages
      WHERE session_id = $1
        AND role IN ('user', 'assistant')
        AND content_redacted IS NOT NULL
        AND COALESCE(metadata->>'unverified_speech', 'false') <> 'true'
      ORDER BY created_at ASC, message_id ASC`,
    [sessionId],
  );
  return rows.map((r) => ({
    role: r.role === 'user' ? ('participant' as const) : ('assistant' as const),
    text: r.content_redacted,
  }));
}

const SUBSCALE_COLUMNS = ['rateable', 'p_rateable', 'score', 'level', 'confidence', 'distribution'] as const;

/** Insert or replace the rating for (session, judge version). */
export async function upsertAllianceRating(rating: NewAllianceRating): Promise<AllianceRatingRow> {
  const columns = [
    'session_id',
    'judge_version',
    'status',
    'participant_turns',
    'participant_words',
    'transcript_chars',
    'transcript_truncated',
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
     RETURNING *`,
    values,
  );
  return rows[0];
}

/** The rating for one session under one judge version, or null. */
export async function getAllianceRating(sessionId: string, judgeVersion: string): Promise<AllianceRatingRow | null> {
  const { rows } = await pool.query<AllianceRatingRow>(
    `SELECT * FROM session_alliance_ratings WHERE session_id = $1 AND judge_version = $2`,
    [sessionId, judgeVersion],
  );
  return rows[0] ?? null;
}

/** The most recent rating for a session under any judge version, or null. */
export async function getLatestAllianceRating(sessionId: string): Promise<AllianceRatingRow | null> {
  const { rows } = await pool.query<AllianceRatingRow>(
    `SELECT * FROM session_alliance_ratings WHERE session_id = $1 ORDER BY rated_at DESC, rating_id DESC LIMIT 1`,
    [sessionId],
  );
  return rows[0] ?? null;
}

/**
 * Eligible sessions with no answer under this judge version, oldest first.
 * A session whose only row is 'errored' has no answer and is listed again
 * unless `includeErrored` is false.
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
        AND (ar.rating_id IS NULL OR ($2::boolean AND ar.status = 'errored'))
      ORDER BY ts.created_at ASC, ts.session_id ASC
      LIMIT $3`,
    [judgeVersion, includeErrored, opts.limit ?? null],
  );
  return rows.map((r) => r.session_id);
}
