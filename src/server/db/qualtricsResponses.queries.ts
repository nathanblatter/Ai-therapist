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

/** Enrollment anchor for the survey schedule: when the participant's account
 *  was created from their baseline survey (earliest, if somehow several). */
export async function getEnrollmentAnchor(userId: number): Promise<Date | null> {
  const { rows } = await pool.query(
    'SELECT min(registered_at) AS anchor FROM qualtrics_signups WHERE user_id = $1',
    [userId]
  );
  return rows[0]?.anchor ?? null;
}

export interface FinishedResponse {
  surveyRole: QualtricsSurveyRole;
  recordedAt: Date | null;
}

/** Finished, linked responses for one participant (schedule + admin views). */
export async function getFinishedResponsesForUser(userId: number): Promise<FinishedResponse[]> {
  const { rows } = await pool.query(
    `SELECT survey_role AS "surveyRole", recorded_at AS "recordedAt"
     FROM qualtrics_responses WHERE user_id = $1 AND finished`,
    [userId]
  );
  return rows;
}

export interface LinkedSurveyRow {
  userId: number;
  username: string;
  surveyRole: QualtricsSurveyRole;
  responseId: string;
  recordedAt: Date | null;
  answers: Record<string, unknown>;
}

/** Every finished, participant-linked response with its payload — the input
 *  to the admin aggregation view. Participant set stays small (target ~40),
 *  so shipping answers jsonb for all rows is fine. */
export async function getLinkedSurveyRows(): Promise<LinkedSurveyRow[]> {
  const { rows } = await pool.query(
    `SELECT qr.user_id AS "userId", u.username, qr.survey_role AS "surveyRole",
            qr.response_id AS "responseId", qr.recorded_at AS "recordedAt", qr.answers
     FROM qualtrics_responses qr
     JOIN users u ON u.userid = qr.user_id
     WHERE qr.finished AND qr.user_id IS NOT NULL
     ORDER BY qr.recorded_at ASC`
  );
  return rows;
}

export interface EnrollmentRow {
  userId: number;
  username: string;
  enrolledAt: Date;
}

/** All survey-enrolled participants (account minted via /join-study). */
export async function getEnrolledParticipants(): Promise<EnrollmentRow[]> {
  const { rows } = await pool.query(
    `SELECT qs.user_id AS "userId", u.username, min(qs.registered_at) AS "enrolledAt"
     FROM qualtrics_signups qs
     JOIN users u ON u.userid = qs.user_id
     WHERE qs.user_id IS NOT NULL
     GROUP BY qs.user_id, u.username
     ORDER BY min(qs.registered_at) ASC`
  );
  return rows;
}

export interface EnrollmentFunnel {
  /** Finished baseline responses (consented or screened out at the crisis branch). */
  baselineFinished: number;
  /** Accounts actually created via /join-study. */
  accountsCreated: number;
  /** Finished non-baseline responses that resolved to no participant. */
  unlinkedFinished: number;
}

/** Recruitment drop-off between finishing the baseline and creating an account. */
export async function getEnrollmentFunnel(): Promise<EnrollmentFunnel> {
  const { rows } = await pool.query(
    `SELECT
       (SELECT count(*) FROM qualtrics_responses WHERE survey_role = 'baseline' AND finished) AS baseline,
       (SELECT count(*) FROM qualtrics_signups WHERE registered_at IS NOT NULL) AS accounts,
       (SELECT count(*) FROM qualtrics_responses
        WHERE finished AND user_id IS NULL AND survey_role <> 'baseline') AS unlinked`
  );
  return {
    baselineFinished: Number(rows[0].baseline),
    accountsCreated: Number(rows[0].accounts),
    unlinkedFinished: Number(rows[0].unlinked),
  };
}

export interface SurveyAnswersExportRow {
  participant_id: string;
  survey_role: QualtricsSurveyRole;
  recorded_at: string;
  answers: Record<string, unknown>;
}

/** Finished, linked, non-sandbox responses WITH answer payloads — input to
 *  the scored survey export (scores are computed in the export service; raw
 *  answers never leave the server). */
export async function getSurveyAnswersForExport(asOf: string): Promise<SurveyAnswersExportRow[]> {
  const { rows } = await pool.query(
    `SELECT rp.pseudonym AS participant_id,
            qr.survey_role,
            to_char(qr.recorded_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS recorded_at,
            qr.answers
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

/** Baseline fallback: the account minted from this ResponseID via /join-study. */
export async function findUserIdForBaselineResponse(responseId: string): Promise<number | null> {
  const { rows } = await pool.query(
    'SELECT user_id FROM qualtrics_signups WHERE response_id = $1 AND user_id IS NOT NULL',
    [responseId]
  );
  return rows[0]?.user_id ?? null;
}

export interface SurveyLinkageStats {
  surveyRole: QualtricsSurveyRole;
  total: number;
  finished: number;
  linked: number;
  unlinkedFinished: number;
  lastRecordedAt: string | null;
}

export interface UnlinkedResponse {
  responseId: string;
  surveyRole: QualtricsSurveyRole;
  studySid: string | null;
  recordedAt: string | null;
}

/** Per-survey linkage health for the admin status endpoint. */
export async function getQualtricsLinkageStats(): Promise<SurveyLinkageStats[]> {
  const { rows } = await pool.query(
    `SELECT survey_role,
            count(*)::int AS total,
            count(*) FILTER (WHERE finished)::int AS finished,
            count(*) FILTER (WHERE user_id IS NOT NULL)::int AS linked,
            count(*) FILTER (WHERE finished AND user_id IS NULL)::int AS unlinked_finished,
            to_char(max(recorded_at) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS last_recorded_at
     FROM qualtrics_responses
     GROUP BY survey_role
     ORDER BY survey_role`
  );
  return rows.map((r) => ({
    surveyRole: r.survey_role,
    total: r.total,
    finished: r.finished,
    linked: r.linked,
    unlinkedFinished: r.unlinked_finished,
    lastRecordedAt: r.last_recorded_at,
  }));
}

/**
 * Finished responses that could not be resolved to a participant — each one is
 * unusable for analysis until linked, so they must be visible, not silent.
 */
export async function getUnlinkedFinishedResponses(limit = 50): Promise<UnlinkedResponse[]> {
  const { rows } = await pool.query(
    `SELECT response_id, survey_role, study_sid,
            to_char(recorded_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS recorded_at
     FROM qualtrics_responses
     WHERE finished AND user_id IS NULL
     ORDER BY recorded_at DESC NULLS LAST
     LIMIT $1`,
    [limit]
  );
  return rows.map((r) => ({
    responseId: r.response_id,
    surveyRole: r.survey_role,
    studySid: r.study_sid,
    recordedAt: r.recorded_at,
  }));
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
            to_char(qr.recorded_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS recorded_at
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
