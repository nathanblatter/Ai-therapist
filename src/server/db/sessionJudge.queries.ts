// What every per-session Decisions judge shares (the working-alliance ratings
// of migration 134 and the session features of migration 135): which sessions
// a judge may read, which messages of them, the fingerprint that tells
// whether a stored answer still describes the transcript, and the claim that
// stops two runs paying for the same session.
//
// These rules came out of the review of the alliance feature
// (docs/alliance-markers-2026-11-26.md). They live here once so a second
// judge cannot drift from them: db/allianceRatings.queries.ts re-exports them
// under its original names, db/sessionFeatures.queries.ts uses them directly.
// A judge keeps its own table, its own upsert and its own lock namespace.
import { pool } from '../config/db.js';
import { leakCheckNeedsReviewSql } from './leakCheckSql.js';
import { redactableRowsSql } from './redactionScope.js';
import { notUnverifiedSpeechSql } from './unverifiedSpeech.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('sessionJudge');

/** One turn of the conversation as a judge sees it. */
export interface JudgeTurn {
  role: 'participant' | 'assistant';
  text: string;
}

/**
 * The session-level rule every caller shares (the post-session hooks, the
 * backfills and the scripts): which sessions a judge may read. Only ended
 * sessions of enrolled study participants:
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
 *     account deletion leaves behind) has no such owner and is never read.
 *     This is the participant definition of the dataset export
 *     (ensurePseudonyms) with the withdrawal exclusion of the screener-trend
 *     analysis (workQueue.queries.ts), the strictest rule any research read
 *     applies; the export itself keeps a withdrawn participant's rows and
 *     labels them in participants.csv. A paused participant is still enrolled;
 *   - redaction complete: at least one redactable row with content, and none
 *     of them still waiting for content_redacted (the definition behind the
 *     admin "complete" label, db/adminSessions.queries.ts). A message whose
 *     redaction was rejected keeps the session ineligible: a judge never
 *     reads raw text to fill the gap.
 *
 * Which MESSAGES of an eligible session a judge reads is a separate rule:
 * judgeReadableTurnSql below.
 *
 * `ts` must alias therapy_sessions.
 */
export const JUDGE_ELIGIBLE_SESSION_SQL = `
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
export async function isSessionJudgeEligible(sessionId: string): Promise<boolean> {
  const { rows } = await pool.query(
    `SELECT 1 FROM therapy_sessions ts WHERE ts.session_id = $1 AND ${JUDGE_ELIGIBLE_SESSION_SQL}`,
    [sessionId],
  );
  return rows.length > 0;
}

/**
 * The message-level rule: which rows of a session a judge reads.
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
 * that enters or leaves this set makes a stored answer stale.
 */
export function judgeReadableTurnSql(alias: string): string {
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
// transcript is read for a judge and when a stored answer is checked.
function fingerprintAggSql(alias: string): string {
  return `md5(string_agg(${alias}.message_id::text || ':' || md5(${alias}.content_redacted), ','
                         ORDER BY ${alias}.created_at ASC, ${alias}.message_id ASC))`;
}

/** SQL expression: the fingerprint of a session's readable transcript NOW. */
export function judgeTranscriptFingerprintSql(sessionIdExpr: string): string {
  return `(SELECT COALESCE(${fingerprintAggSql('fm')}, '${EMPTY_TRANSCRIPT_FINGERPRINT}')
             FROM messages fm
            WHERE fm.session_id = ${sessionIdExpr} AND ${judgeReadableTurnSql('fm')})`;
}

/**
 * SQL boolean: the stored row (alias, with session_id and
 * transcript_fingerprint columns) was computed from a transcript that is not
 * the session's readable transcript now.
 */
export function judgeRowStaleSql(alias: string): string {
  return `(${alias}.transcript_fingerprint IS DISTINCT FROM ${judgeTranscriptFingerprintSql(`${alias}.session_id`)})`;
}

export interface JudgeTranscript {
  turns: JudgeTurn[];
  /** Identifies exactly these turns; stored with the answer. */
  fingerprint: string;
}

/**
 * The conversation as a judge reads it (judgeReadableTurnSql): participant
 * and assistant turns only, REDACTED text only, with the fingerprint of
 * exactly the rows returned (one statement, one snapshot). This query never
 * selects messages.content, so raw text cannot reach a judge through it.
 */
export async function getTranscriptForJudge(sessionId: string): Promise<JudgeTranscript> {
  const { rows } = await pool.query<{ role: string; content_redacted: string; fingerprint: string }>(
    `WITH t AS (
       SELECT m.message_id, m.role, m.content_redacted, m.created_at
         FROM messages m
        WHERE m.session_id = $1 AND ${judgeReadableTurnSql('m')})
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
 * For the leak-review hooks: the session a message belongs to and how many of
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
 * Run `fn` while holding the claim for (namespace, session, version), so two
 * runs that overlap (a post-session hook and a backfill, or two backfills) do
 * not both pay for the same session. `namespace` is the judge's table name:
 * the two judges never block each other. A session-level advisory lock on a
 * connection held for the duration: it is released when `fn` settles, and by
 * Postgres itself if the process or the connection dies, so there is no claim
 * row to expire. Returns { acquired: false } without running `fn` when
 * another run holds the claim.
 */
export async function withSessionJudgeClaim<T>(
  namespace: string,
  sessionId: string,
  version: string,
  fn: () => Promise<T>,
): Promise<{ acquired: true; result: T } | { acquired: false }> {
  const key = `${sessionId}|${version}`;
  const client = await pool.connect();
  let broken = false;
  try {
    const { rows } = await client.query<{ locked: boolean }>(
      `SELECT pg_try_advisory_lock(hashtext($1), hashtext($2)) AS locked`,
      [namespace, key],
    );
    if (!rows[0]?.locked) return { acquired: false };
    try {
      return { acquired: true, result: await fn() };
    } finally {
      try {
        await client.query(`SELECT pg_advisory_unlock(hashtext($1), hashtext($2))`, [namespace, key]);
      } catch (err) {
        // The lock dies with the connection: do not hand it back to the pool.
        broken = true;
        log.warn({ err }, `could not release the ${namespace} claim; closing its connection`);
      }
    }
  } finally {
    client.release(broken);
  }
}
