// Qualtrics response sync (ai-therapist-149) — the analysis-side half of the
// integration. Pulls every response for the study's four surveys through the
// official response-export API (create export -> poll -> download JSON) and
// upserts them into qualtrics_responses, resolving each response to a
// participant account so the dataset export can join survey data with in-app
// metrics on the research pseudonym.
//
// Linkage per response, in order of trust:
//   1. `sid` embedded data (stamped by the app's personalized survey links)
//   2. the typed study-ID answer (WID/XID/FID text entry)
//   3. for baseline responses, qualtrics_signups (ResponseID -> account
//      created via /join-study)
//
// Configuration (plain env, all-off when unset):
//   QUALTRICS_API_TOKEN, QUALTRICS_DATACENTER (defaults byu.pdx1)
//   QUALTRICS_BASELINE_SURVEY_ID / QUALTRICS_WEEKLY_SURVEY_ID /
//   QUALTRICS_EXIT_SURVEY_ID / QUALTRICS_WEEK12_SURVEY_ID
import {
  upsertQualtricsResponse,
  resolveStudySidToUserId,
  findUserIdForBaselineResponse,
  type QualtricsSurveyRole,
} from '../db/index.js';

export interface QualtricsSyncConfig {
  apiToken: string;
  datacenter: string;
  surveys: Partial<Record<QualtricsSurveyRole, string>>;
}

export function getQualtricsSyncConfig(): QualtricsSyncConfig | null {
  const apiToken = process.env.QUALTRICS_API_TOKEN;
  if (!apiToken) return null;
  const surveys: Partial<Record<QualtricsSurveyRole, string>> = {};
  if (process.env.QUALTRICS_BASELINE_SURVEY_ID) surveys.baseline = process.env.QUALTRICS_BASELINE_SURVEY_ID;
  if (process.env.QUALTRICS_WEEKLY_SURVEY_ID) surveys.weekly = process.env.QUALTRICS_WEEKLY_SURVEY_ID;
  if (process.env.QUALTRICS_EXIT_SURVEY_ID) surveys.exit = process.env.QUALTRICS_EXIT_SURVEY_ID;
  if (process.env.QUALTRICS_WEEK12_SURVEY_ID) surveys.week12 = process.env.QUALTRICS_WEEK12_SURVEY_ID;
  if (Object.keys(surveys).length === 0) return null;
  return { apiToken, datacenter: process.env.QUALTRICS_DATACENTER || 'byu.pdx1', surveys };
}

interface QualtricsExportedResponse {
  responseId: string;
  values: Record<string, unknown>;
  labels?: Record<string, unknown>;
}

const POLL_INTERVAL_MS = 1500;
const POLL_LIMIT = 40; // ~60s per survey worst case

async function api(
  config: QualtricsSyncConfig,
  method: 'GET' | 'POST',
  path: string,
  body?: unknown
): Promise<Response> {
  return fetch(`https://${config.datacenter}.qualtrics.com/API/v3${path}`, {
    method,
    headers: {
      'X-API-TOKEN': config.apiToken,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
}

/** Run the create-poll-download export flow for one survey; returns responses. */
export async function fetchAllResponses(
  config: QualtricsSyncConfig,
  surveyId: string
): Promise<QualtricsExportedResponse[]> {
  const start = await api(config, 'POST', `/surveys/${surveyId}/export-responses`, {
    format: 'json',
    compress: false,
  });
  if (!start.ok) throw new Error(`export start HTTP ${start.status}`);
  const startBody = (await start.json()) as { result?: { progressId?: string } };
  const progressId = startBody.result?.progressId;
  if (!progressId) throw new Error('export start: no progressId');

  let fileId: string | undefined;
  for (let i = 0; i < POLL_LIMIT; i++) {
    const poll = await api(config, 'GET', `/surveys/${surveyId}/export-responses/${progressId}`);
    if (!poll.ok) throw new Error(`export poll HTTP ${poll.status}`);
    const pollBody = (await poll.json()) as {
      result?: { status?: string; fileId?: string };
    };
    const status = pollBody.result?.status;
    if (status === 'complete') {
      fileId = pollBody.result?.fileId;
      break;
    }
    if (status === 'failed') throw new Error('export failed on Qualtrics side');
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
  if (!fileId) throw new Error('export did not complete in time');

  const download = await api(config, 'GET', `/surveys/${surveyId}/export-responses/${fileId}/file`);
  if (!download.ok) throw new Error(`export download HTTP ${download.status}`);
  const file = (await download.json()) as { responses?: QualtricsExportedResponse[] };
  return file.responses ?? [];
}

/** Pull the first plausible study-ID-looking text answer out of the values
 *  payload (the WID/XID/FID text-entry questions export as QIDx_TEXT). */
export function extractTypedStudyId(values: Record<string, unknown>): string | null {
  for (const [key, value] of Object.entries(values)) {
    if (!/_TEXT$/.test(key)) continue;
    if (typeof value === 'string' && /^\d{1,6}$/.test(value.trim())) return value.trim();
  }
  return null;
}

export interface SurveySyncResult {
  surveyRole: QualtricsSurveyRole;
  surveyId: string;
  fetched: number;
  upserted: number;
  linked: number;
  error?: string;
}

async function syncSurvey(
  config: QualtricsSyncConfig,
  surveyRole: QualtricsSurveyRole,
  surveyId: string
): Promise<SurveySyncResult> {
  const result: SurveySyncResult = { surveyRole, surveyId, fetched: 0, upserted: 0, linked: 0 };
  const responses = await fetchAllResponses(config, surveyId);
  result.fetched = responses.length;

  for (const response of responses) {
    const values = response.values ?? {};
    const finishedRaw = values.finished;
    const finished = finishedRaw === 1 || finishedRaw === true;
    const recordedAt = typeof values.recordedDate === 'string' ? values.recordedDate : null;

    const sidRaw = typeof values.sid === 'string' ? values.sid.trim() : '';
    const studySid = sidRaw || extractTypedStudyId(values);

    let userId: number | null = null;
    if (studySid) userId = await resolveStudySidToUserId(studySid);
    if (userId === null && surveyRole === 'baseline') {
      userId = await findUserIdForBaselineResponse(response.responseId);
    }
    if (userId !== null) result.linked++;

    await upsertQualtricsResponse({
      responseId: response.responseId,
      surveyId,
      surveyRole,
      userId,
      studySid: studySid ?? null,
      finished,
      recordedAt,
      answers: values,
    });
    result.upserted++;
  }
  return result;
}

/** Sync every configured survey; per-survey failures don't abort the rest. */
export async function syncAllSurveys(config: QualtricsSyncConfig): Promise<SurveySyncResult[]> {
  const results: SurveySyncResult[] = [];
  for (const [surveyRole, surveyId] of Object.entries(config.surveys) as [QualtricsSurveyRole, string][]) {
    try {
      results.push(await syncSurvey(config, surveyRole, surveyId));
    } catch (error) {
      console.error(`[QualtricsSync] ${surveyRole} (${surveyId}) failed:`, error);
      results.push({
        surveyRole,
        surveyId,
        fetched: 0,
        upserted: 0,
        linked: 0,
        error: error instanceof Error ? error.message : 'sync failed',
      });
    }
  }
  return results;
}
