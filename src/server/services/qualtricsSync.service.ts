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
  insertAdverseEventDraft,
  type QualtricsSurveyRole,
} from '../db/index.js';
import { enqueueWorkItem } from './workQueue.service.js';

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

/** Pull the plausible study-ID text answer out of the values payload (the
 *  WID/XID/FID text-entry questions export as QIDx_TEXT). If MORE THAN ONE
 *  distinct numeric text answer exists the response is ambiguous — another
 *  question ("how many days...?") could be the number we grabbed — so return
 *  null rather than risk mislinking a research record; those land in the
 *  unlinked queue for human review. */
export function extractTypedStudyId(values: Record<string, unknown>): string | null {
  const candidates = new Set<string>();
  for (const [key, value] of Object.entries(values)) {
    if (!/_TEXT$/.test(key)) continue;
    if (typeof value === 'string' && /^\d{1,6}$/.test(value.trim())) candidates.add(value.trim());
  }
  return candidates.size === 1 ? [...candidates][0] : null;
}

/**
 * Adverse-experience detection (protocol: distress descriptions are reviewed
 * within 1 business day). Question keys verified against the live surveys on
 * 2026-09-03:
 *   weekly  QID10 ("did anything bother you", 2 = Yes) + QID11_TEXT describe
 *   exit    QID13_TEXT (unhelpful/upsetting moment), QID14_TEXT (crisis handling)
 *   week12  QID10 (lasting effects, 2 = mostly negative / 3 = both) + QID11_TEXT
 * Returns the triggering keys (never the text itself) or null when clean.
 */
export function detectAdverseReport(
  surveyRole: QualtricsSurveyRole,
  values: Record<string, unknown>
): string[] | null {
  const triggers: string[] = [];
  const hasText = (key: string) =>
    typeof values[key] === 'string' && (values[key] as string).trim().length > 0;
  if (surveyRole === 'weekly') {
    if (values.QID10 === 2) triggers.push('QID10');
    if (hasText('QID11_TEXT')) triggers.push('QID11_TEXT');
  } else if (surveyRole === 'exit') {
    if (hasText('QID13_TEXT')) triggers.push('QID13_TEXT');
    if (hasText('QID14_TEXT')) triggers.push('QID14_TEXT');
  } else if (surveyRole === 'week12') {
    if (values.QID10 === 2 || values.QID10 === 3) triggers.push('QID10');
    if (hasText('QID11_TEXT')) triggers.push('QID11_TEXT');
  }
  return triggers.length > 0 ? triggers : null;
}

/** Next business day after `from` — the protocol's review deadline. */
export function nextBusinessDay(from: Date): Date {
  const due = new Date(from.getTime() + 24 * 60 * 60 * 1000);
  while (due.getUTCDay() === 0 || due.getUTCDay() === 6) {
    due.setUTCDate(due.getUTCDate() + 1);
  }
  return due;
}

/**
 * File the formal IRB adverse-event draft for a flagged survey response —
 * the reviewed record behind the work-queue ping. The participant's own
 * description goes in transcript_excerpt so review happens in one place
 * (mirroring how crisis AEs carry transcript excerpts); idempotent per
 * response via the ae_auto_survey_response partial unique index.
 */
async function draftAdverseEventFromSurvey(
  surveyRole: QualtricsSurveyRole,
  responseId: string,
  userId: number | null,
  triggers: string[],
  values: Record<string, unknown>
): Promise<number | null> {
  const recordedAt =
    typeof values.recordedDate === 'string' ? new Date(values.recordedDate) : new Date();
  const excerpt = triggers
    .filter((k) => k.endsWith('_TEXT'))
    .map((k) => (typeof values[k] === 'string' ? (values[k] as string).trim() : ''))
    .filter(Boolean)
    .join('\n\n');
  return insertAdverseEventDraft({
    sessionId: null,
    crisisEventId: null,
    userId,
    sessionRef: `qualtrics:${responseId}`,
    participantRef: null,
    occurredAt: recordedAt,
    severity: 'medium',
    triggerSource: 'auto_survey',
    category: 'survey_report',
    summary: `Participant reported an adverse experience in the ${surveyRole} survey (${triggers.join(', ')}).`,
    timeline: [
      { at: recordedAt.toISOString(), kind: 'survey_response', detail: `${surveyRole} survey response ${responseId} recorded` },
      { at: new Date().toISOString(), kind: 'auto_flag', detail: `Flagged by sync (triggers: ${triggers.join(', ')})` },
    ],
    transcriptExcerpt: excerpt || null,
    actionsTaken: [],
    dueAt: nextBusinessDay(new Date()),
    createdBy: 'qualtrics-sync',
  });
}

export interface SurveySyncResult {
  surveyRole: QualtricsSurveyRole;
  surveyId: string;
  fetched: number;
  upserted: number;
  linked: number;
  error?: string;
}

/**
 * Upsert + link + adverse-triage one exported response — the shared path for
 * the bulk sync and the real-time completion webhook. Returns whether the
 * response resolved to a participant.
 */
export async function processExportedResponse(
  surveyRole: QualtricsSurveyRole,
  surveyId: string,
  response: QualtricsExportedResponse
): Promise<{ linked: boolean }> {
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

  // Adverse-experience triage (1-business-day review promise): finished,
  // non-preview responses with a distress report land in the work queue.
  // enqueueWorkItem is idempotent on (item_type, source_table, source_id),
  // so re-syncs and webhook+sync overlap never duplicate; the title/detail
  // carry pointers only — the text itself stays in qualtrics_responses.
  if (finished && values.distributionChannel !== 'preview') {
    const triggers = detectAdverseReport(surveyRole, values);
    if (triggers) {
      // Formal record first, then the ping: the work item is the triage
      // surface, the AE draft is what actually gets reviewed and filed.
      let reportId: number | null = null;
      try {
        reportId = await draftAdverseEventFromSurvey(
          surveyRole, response.responseId, userId, triggers, values
        );
      } catch (err) {
        console.error('[QualtricsSync] AE draft from survey failed:', err);
      }
      await enqueueWorkItem({
        itemType: 'adverse_event',
        severity: 'warning',
        title: `Survey adverse-experience report (${surveyRole})`,
        detail: { surveyRole, responseId: response.responseId, triggers, reportId },
        sourceTable: 'qualtrics_responses',
        sourceId: response.responseId,
        clientId: userId,
      });
    }
  }

  return { linked: userId !== null };
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
    const { linked } = await processExportedResponse(surveyRole, surveyId, response);
    if (linked) result.linked++;
    result.upserted++;
  }
  return result;
}

/**
 * Real-time webhook path: fetch ONE response by id and run it through the
 * shared processing. Returns a status the route maps to an HTTP code. The
 * single-response GET can 404 briefly right after submission (Qualtrics
 * indexes asynchronously) — 'not-found' is retryable, and the scheduled bulk
 * sync remains the catch-all backstop either way.
 */
export async function handleResponseWebhook(
  surveyId: string,
  responseId: string
): Promise<'ok' | 'disabled' | 'unknown-survey' | 'not-found'> {
  const config = getQualtricsSyncConfig();
  if (!config) return 'disabled';
  const surveyRole = (Object.entries(config.surveys) as Array<[QualtricsSurveyRole, string]>).find(
    ([, id]) => id === surveyId
  )?.[0];
  if (!surveyRole) return 'unknown-survey';

  const res = await api(config, 'GET', `/surveys/${surveyId}/responses/${responseId}`);
  if (res.status === 404) return 'not-found';
  if (!res.ok) throw new Error(`single-response fetch HTTP ${res.status}`);
  const body = (await res.json()) as {
    result?: { responseId?: string; values?: Record<string, unknown> };
  };
  if (!body.result?.responseId) return 'not-found';
  await processExportedResponse(surveyRole, surveyId, {
    responseId: body.result.responseId,
    values: body.result.values ?? {},
  });
  return 'ok';
}

export interface SyncRunStatus {
  lastRunAt: string | null;
  lastRunTrigger: 'manual' | 'scheduled' | null;
  lastResults: SurveySyncResult[] | null;
  lastError: string | null;
  schedulerActive: boolean;
  intervalMinutes: number | null;
}

let syncTimer: ReturnType<typeof setInterval> | null = null;
let running = false;
const runStatus: SyncRunStatus = {
  lastRunAt: null,
  lastRunTrigger: null,
  lastResults: null,
  lastError: null,
  schedulerActive: false,
  intervalMinutes: null,
};

export function getSyncRunStatus(): SyncRunStatus {
  return { ...runStatus, lastResults: runStatus.lastResults ? [...runStatus.lastResults] : null };
}

/**
 * Run one sync and record the outcome for the status endpoint. Concurrent
 * calls (manual click during a scheduled run) return 'busy' so callers can
 * say "a sync is already running" instead of passing off the PREVIOUS run's
 * results as fresh. Returns null when the integration is unconfigured.
 */
export async function runSync(
  trigger: 'manual' | 'scheduled'
): Promise<SurveySyncResult[] | null | 'busy'> {
  const config = getQualtricsSyncConfig();
  if (!config) return null;
  if (running) return 'busy';
  running = true;
  try {
    const results = await syncAllSurveys(config);
    runStatus.lastRunAt = new Date().toISOString();
    runStatus.lastRunTrigger = trigger;
    runStatus.lastResults = results;
    runStatus.lastError = results.every((r) => r.error)
      ? 'all surveys failed'
      : null;
    const unlinked = results.reduce((n, r) => n + (r.fetched - r.linked), 0);
    if (unlinked > 0) {
      console.warn(`[QualtricsSync] ${trigger} run: ${unlinked} response(s) not linked to a participant`);
    }
    return results;
  } catch (error) {
    runStatus.lastRunAt = new Date().toISOString();
    runStatus.lastRunTrigger = trigger;
    runStatus.lastError = error instanceof Error ? error.message : 'sync failed';
    throw error;
  } finally {
    running = false;
  }
}

/**
 * Env-gated background sync (QUALTRICS_SYNC_INTERVAL_MINUTES, min 5): run once
 * at boot, then on the interval. Off when unset/0 or when the integration
 * itself is unconfigured — the manual admin endpoint still works either way.
 */
export function startQualtricsSyncScheduler(): void {
  if (syncTimer) return; // idempotent — a second call must not orphan a timer
  const raw = Number(process.env.QUALTRICS_SYNC_INTERVAL_MINUTES || 0);
  if (!Number.isFinite(raw) || raw <= 0) return;
  if (!getQualtricsSyncConfig()) return;
  const minutes = Math.max(5, Math.floor(raw));
  runStatus.schedulerActive = true;
  runStatus.intervalMinutes = minutes;
  const tick = () => {
    runSync('scheduled').catch((err) => console.error('[QualtricsSync] scheduled run failed:', err));
    // Daily survey-definition drift check rides the same cadence; the claim
    // in system_config makes it once-per-day across ticks and containers.
    // Dynamic import avoids a static cycle (drift guard imports our config).
    import('./qualtricsDriftGuard.service.js')
      .then((m) => m.claimAndRunDailyDriftCheck())
      .catch((err) => console.error('[QualtricsDrift] daily check failed:', err));
  };
  tick();
  syncTimer = setInterval(tick, minutes * 60_000);
  syncTimer.unref?.();
}

export function stopQualtricsSyncScheduler(): void {
  if (syncTimer) {
    clearInterval(syncTimer);
    syncTimer = null;
  }
  runStatus.schedulerActive = false;
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
