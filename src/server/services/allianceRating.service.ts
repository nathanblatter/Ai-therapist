// Linguistic working-alliance markers (ai-therapist-173): rate one finished
// session on Task, Bond and Goal from its REDACTED transcript and store the
// numbers in session_alliance_ratings (migration 134).
//
// The rubric and the model call are in allianceMarkers.ts; this file decides
// which sessions are rated, when, and what is stored.
//
// Entry points:
//   - Auto: maybeRateAllianceForSession() runs fire-and-forget at the end of
//     the redaction job (sessionRedaction.service.ts), the one place every
//     session-end path and the 15-minute redaction sweep come through. It
//     does nothing unless system_config.alliance_markers.enabled is true.
//     The code default is OFF.
//   - CLI:  npx tsx src/database/scripts/rateAllianceMarkers.ts (list only by
//     default; --rate to call the judge).
//
// Which sessions: ended, not demo/harness/sandbox, redaction complete
// (ALLIANCE_ELIGIBLE_SESSION_SQL in db/allianceRatings.queries.ts). Only
// messages.content_redacted is ever read.
//
// What is stored: one row per (session, ALLIANCE_JUDGE_VERSION). A judge call
// that fails is stored as status 'errored' with no scores: unknown, never a
// low rating. The backfill picks errored rows up again.
//
// Token usage is stored on the row itself (tokens_in / tokens_out). It is not
// written to session_llm_usage, whose purpose list has no value for this job,
// so the in-app cost dashboard does not show it; OpenAI billing does.

import OpenAI from 'openai';
import { getOpenAIKey } from '../config/secrets.js';
import {
  getAllianceRating,
  getRedactedTurnsForAlliance,
  getSessionsNeedingAllianceRating,
  getSystemConfigByKey,
  isSessionAllianceEligible,
  upsertAllianceRating,
  type AllianceRatingRow,
} from '../db/index.js';
import { createLogger } from '../utils/logger.js';
import { shouldSkipPostSessionWork } from './harnessPostSession.service.js';
import {
  ALLIANCE_JUDGE_VERSION,
  ALLIANCE_MODEL,
  ALLIANCE_SUBSCALES,
  askAllianceJudge,
  belowLengthFloor,
  renderTranscript,
  transcriptStats,
  type AllianceDecisionsClient,
  type AllianceSubscale,
  type SubscaleRating,
} from './allianceMarkers.js';

const log = createLogger('allianceRating');

export interface AllianceMarkersConfig {
  enabled: boolean;
}

/** Code default: OFF. Only an explicit `enabled: true` turns the job on. */
export const DEFAULT_ALLIANCE_MARKERS_CONFIG: AllianceMarkersConfig = { enabled: false };

/** system_config.alliance_markers. Any doubt (no row, a malformed value, a
 *  failed read) means off. */
export async function getAllianceMarkersConfig(): Promise<AllianceMarkersConfig> {
  try {
    const row = await getSystemConfigByKey('alliance_markers');
    const value = (row?.config_value ?? {}) as { enabled?: unknown };
    return { enabled: value.enabled === true };
  } catch (err) {
    log.warn({ err }, 'could not read alliance_markers config; treating it as off');
    return { ...DEFAULT_ALLIANCE_MARKERS_CONFIG };
  }
}

const NOT_RATEABLE: SubscaleRating = {
  rateable: false,
  pRateable: 0,
  score: null,
  level: null,
  confidence: null,
  distribution: null,
};

function allNotRateable(): Record<AllianceSubscale, SubscaleRating> {
  return { task: { ...NOT_RATEABLE }, bond: { ...NOT_RATEABLE }, goal: { ...NOT_RATEABLE } };
}

export type RateOutcome =
  | { outcome: 'skipped'; reason: 'not_eligible' | 'already_rated' }
  | { outcome: 'stored'; row: AllianceRatingRow };

export interface RateOptions {
  /** Rate again even when an answer for the current judge version exists. */
  force?: boolean;
  /** Test seam. */
  client?: AllianceDecisionsClient;
}

let sharedClient: OpenAI | null = null;
async function getClient(): Promise<AllianceDecisionsClient> {
  if (!sharedClient) sharedClient = new OpenAI({ apiKey: await getOpenAIKey(), timeout: 120_000 });
  return sharedClient;
}

/**
 * Rate one session and store the result. Does not look at the on/off switch:
 * that is the caller's decision (the automatic hook checks it, the opt-in
 * script is itself the opt-in). Never throws for a failed judge call; that is
 * stored as an errored row.
 */
export async function rateSessionAlliance(sessionId: string, options: RateOptions = {}): Promise<RateOutcome> {
  if (!(await isSessionAllianceEligible(sessionId))) return { outcome: 'skipped', reason: 'not_eligible' };

  if (!options.force) {
    const existing = await getAllianceRating(sessionId, ALLIANCE_JUDGE_VERSION);
    if (existing && existing.status !== 'errored') return { outcome: 'skipped', reason: 'already_rated' };
  }

  const turns = await getRedactedTurnsForAlliance(sessionId);
  const stats = transcriptStats(turns);
  const base = {
    sessionId,
    judgeVersion: ALLIANCE_JUDGE_VERSION,
    participantTurns: stats.participantTurns,
    participantWords: stats.participantWords,
  };

  // Too little participant speech to carry evidence for anything: recorded as
  // not rateable without spending a model call.
  if (belowLengthFloor(stats)) {
    const row = await upsertAllianceRating({
      ...base,
      status: 'too_short',
      subscales: allNotRateable(),
      transcriptChars: null,
      transcriptTruncated: false,
      model: null,
      tokensIn: null,
      tokensOut: null,
    });
    return { outcome: 'stored', row };
  }

  const { text, truncated } = renderTranscript(turns);
  try {
    const answer = await askAllianceJudge(options.client ?? (await getClient()), text);
    const row = await upsertAllianceRating({
      ...base,
      status: 'rated',
      subscales: answer.subscales,
      transcriptChars: text.length,
      transcriptTruncated: truncated,
      model: answer.model,
      tokensIn: answer.tokensIn,
      tokensOut: answer.tokensOut,
    });
    const summary = ALLIANCE_SUBSCALES.map((s) => {
      const r = answer.subscales[s];
      return `${s}=${r.rateable ? r.level : 'n/r'}`;
    }).join(' ');
    log.info(`alliance rating stored for ${sessionId.substring(0, 12)}... [${ALLIANCE_JUDGE_VERSION}]: ${summary}`);
    return { outcome: 'stored', row };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error(`alliance judge failed for ${sessionId.substring(0, 12)}...: ${message}`);
    const row = await upsertAllianceRating({
      ...base,
      status: 'errored',
      transcriptChars: text.length,
      transcriptTruncated: truncated,
      model: ALLIANCE_MODEL,
      tokensIn: null,
      tokensOut: null,
      error: message || 'unknown error',
    });
    return { outcome: 'stored', row };
  }
}

/**
 * Fire-and-forget hook for the end of the redaction job. Safe to call
 * unconditionally: it does nothing unless the switch is on, skips a red-team
 * harness session that did not opt in to post-session work, and never throws.
 */
export function maybeRateAllianceForSession(sessionId: string): void {
  getAllianceMarkersConfig()
    .then(async (cfg) => {
      if (!cfg.enabled) return;
      if (await shouldSkipPostSessionWork(sessionId, 'alliance')) return;
      await rateSessionAlliance(sessionId);
    })
    .catch((err) => log.error({ err }, `alliance rating failed for ${sessionId}`));
}

export interface BackfillSummary {
  candidates: number;
  rated: number;
  tooShort: number;
  errored: number;
  skipped: number;
}

/** Rate every eligible session that has no answer under the current judge
 *  version, one at a time, oldest first. */
export async function backfillAllianceRatings(
  opts: { limit?: number | null; client?: AllianceDecisionsClient } = {},
): Promise<BackfillSummary> {
  const sessionIds = await getSessionsNeedingAllianceRating(ALLIANCE_JUDGE_VERSION, { limit: opts.limit ?? null });
  const summary: BackfillSummary = { candidates: sessionIds.length, rated: 0, tooShort: 0, errored: 0, skipped: 0 };
  for (const sessionId of sessionIds) {
    const result = await rateSessionAlliance(sessionId, { client: opts.client });
    if (result.outcome === 'skipped') summary.skipped++;
    else if (result.row.status === 'rated') summary.rated++;
    else if (result.row.status === 'too_short') summary.tooShort++;
    else summary.errored++;
  }
  return summary;
}
