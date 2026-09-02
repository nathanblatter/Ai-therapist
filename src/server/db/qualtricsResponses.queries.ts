// Data-access for synced Qualtrics survey responses (ai-therapist-149).
// Rows are written exclusively by qualtricsSync.service.ts; the dataset export
// reads them joined through research_pseudonyms like every other artifact.
import { pool } from '../config/db.js';

export type QualtricsSurveyRole = 'baseline' | 'weekly' | 'exit' | 'week12';

export interface QualtricsResponseUpsert {
  responseId: string;
  surveyId: string;
  surveyRole: QualtricsSurveyRole;
  userId: number | null;
  studySid: string | null;
  finished: boolean;
  recordedAt: string | null;
  answers: Record<string, unknown>;
}

/** Idempotent upsert keyed by ResponseID; re-syncs refresh linkage + answers. */
export async function upsertQualtricsResponse(r: QualtricsResponseUpsert): Promise<void> {
  await pool.query(
    `INSERT INTO qualtrics_responses
       (response_id, survey_id, survey_role, user_id, study_sid, finished, recorded_at, answers, synced_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now())
     ON CONFLICT (response_id) DO UPDATE SET
       user_id = EXCLUDED.user_id,
       study_sid = EXCLUDED.study_sid,
       finished = EXCLUDED.finished,
       recorded_at = EXCLUDED.recorded_at,
       answers = EXCLUDED.answers,
       synced_at = now()`,
    [r.responseId, r.surveyId, r.surveyRole, r.userId, r.studySid, r.finished, r.recordedAt, JSON.stringify(r.answers)]
  );
}

/** Resolve a typed/embedded study id to a participant userid, or null. */
export async function resolveStudySidToUserId(studySid: string): Promise<number | null> {
  if (!/^\d{1,9}$/.test(studySid)) return null;
  const { rows } = await pool.query(
    `SELECT userid FROM users
     WHERE userid = $1 AND role = 'participant' AND is_sandbox IS NOT TRUE`,
    [Number(studySid)]
  );
  return rows[0]?.userid ?? null;
}

/** Baseline fallback: the account minted from this ResponseID via /join-study. */
export async function findUserIdForBaselineResponse(responseId: string): Promise<number | null> {
  const { rows } = await pool.query(
    'SELECT user_id FROM qualtrics_signups WHERE response_id = $1 AND user_id IS NOT NULL',
    [responseId]
  );
  return rows[0]?.user_id ?? null;
}

export interface SurveyExportRow {
  [key: string]: unknown;
}

/**
 * De-identified survey rows for the dataset export: one row per finished,
 * participant-linked response, keyed by research pseudonym. Free-text answers
 * stay out of the default bundle (answers JSONB is not selected) — only
 * linkage, timing, and completeness leave the system here; scored values can
 * be added column-by-column as the analysis plan firms up.
 */
export async function getSurveyResponsesExport(asOf: string): Promise<SurveyExportRow[]> {
  const { rows } = await pool.query(
    `SELECT rp.pseudonym AS participant_id,
            qr.survey_role,
            qr.finished,
            to_char(qr.recorded_at, 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS recorded_at
     FROM qualtrics_responses qr
     JOIN research_pseudonyms rp
       ON rp.entity_type = 'participant' AND rp.entity_key = qr.user_id::text
     JOIN users u ON u.userid = qr.user_id
     WHERE qr.finished
       AND qr.recorded_at <= $1::timestamptz
       AND u.is_sandbox IS NOT TRUE
     ORDER BY rp.pseudonym, qr.recorded_at`,
    [asOf]
  );
  return rows;
}
