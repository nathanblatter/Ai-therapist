// Withdrawal deletion requests (Qualtrics ops): the withdrawal survey's D4
// asks "what should happen to the information collected about you so far?";
// choosing deletion files a participant_withdrawal work item with
// requestsDeletion=true. A RESEARCHER then confirms via the admin endpoint,
// which calls this service — deletion is deliberate and human-confirmed,
// never automatic on survey ingest.
//
// What deletion means here (survey data only — session/transcript deletion
// stays under the existing contentWipe/dataRetention machinery):
//   1. Remote: each of the participant's Qualtrics responses is deleted via
//      the delete-response API (decrementQuotas=false — a withdrawn
//      participant still consumed an enrollment slot).
//   2. Local: answers are blanked. Non-withdrawal rows keep only a skeleton
//      (role/recorded_at/finished survive for enrollment/completion counts).
//      The withdrawal response keeps its structured choices (reason, scope,
//      data-use preference — the regulatory record of the request itself)
//      but drops free text.
//   3. One data_deletion_log row per artifact, reason 'participant_request'.
import { pool } from '../config/db.js';
import { insertDeletionLog } from '../db/dataRetention.queries.js';
import { getQualtricsSyncConfig } from './qualtricsSync.service.js';
import { WITHDRAWAL_KEYS } from './qualtricsSync.service.js';
import { randomUUID } from 'node:crypto';

interface ResponseRow {
  response_id: string;
  survey_id: string;
  survey_role: string;
  answers: Record<string, unknown>;
}

export interface SurveyDeletionResult {
  runId: string;
  responses: number;
  remoteDeleted: number;
  remoteFailed: number;
  localBlanked: number;
}

async function deleteRemoteResponse(surveyId: string, responseId: string): Promise<boolean> {
  const config = getQualtricsSyncConfig();
  if (!config) return false;
  const res = await fetch(
    `https://${config.datacenter}.qualtrics.com/API/v3/surveys/${surveyId}/responses/${responseId}?decrementQuotas=false`,
    {
      method: 'DELETE',
      headers: { 'X-API-TOKEN': config.apiToken, Accept: 'application/json' },
      signal: AbortSignal.timeout(30_000),
    }
  );
  // 404 = already gone remotely; that satisfies the request.
  return res.ok || res.status === 404;
}

/**
 * Execute a participant's survey-data deletion request. Idempotent: already
 * blanked rows blank to the same skeleton, already-deleted remote responses
 * count as deleted.
 */
export async function deleteParticipantSurveyData(
  userId: number,
  actor: string
): Promise<SurveyDeletionResult> {
  const runId = randomUUID();
  const { rows } = await pool.query<ResponseRow>(
    `SELECT response_id, survey_id, survey_role, answers
       FROM qualtrics_responses WHERE user_id = $1`,
    [userId]
  );

  const result: SurveyDeletionResult = {
    runId,
    responses: rows.length,
    remoteDeleted: 0,
    remoteFailed: 0,
    localBlanked: 0,
  };

  for (const row of rows) {
    let remoteOk = false;
    let errorMessage: string | null = null;
    try {
      remoteOk = await deleteRemoteResponse(row.survey_id, row.response_id);
    } catch (err) {
      errorMessage = err instanceof Error ? err.message : String(err);
    }
    if (remoteOk) result.remoteDeleted++;
    else result.remoteFailed++;

    // Local blanking happens regardless of remote outcome — the participant's
    // request governs our copy either way; a remote failure is retried by
    // re-running the endpoint (idempotent) and is visible in the audit log.
    const keep: Record<string, unknown> = {};
    if (row.survey_role === 'withdrawal') {
      for (const key of [WITHDRAWAL_KEYS.reason, WITHDRAWAL_KEYS.scope, WITHDRAWAL_KEYS.dataUse]) {
        if (row.answers[key] !== undefined) keep[key] = row.answers[key];
      }
    }
    await pool.query(
      `UPDATE qualtrics_responses SET answers = $2, study_sid = NULL WHERE response_id = $1`,
      [row.response_id, JSON.stringify(keep)]
    );
    result.localBlanked++;

    await insertDeletionLog({
      runId,
      artifactType: 'survey_response',
      artifactRef: `${row.survey_role}:${row.response_id}`,
      sessionId: null,
      userId,
      reason: 'participant_request',
      policySnapshot: { source: 'withdrawal_survey_d4', remoteDeleted: remoteOk },
      triggeredBy: 'manual',
      triggeredByUser: actor,
      success: remoteOk,
      errorMessage,
    }).catch((err) => console.error('[QualtricsDeletion] audit row failed:', err));
  }

  console.log(
    `[QualtricsDeletion] user ${userId}: ${result.remoteDeleted}/${result.responses} remote deleted, ` +
      `${result.localBlanked} local blanked (run ${runId}, by ${actor})`
  );
  return result;
}
