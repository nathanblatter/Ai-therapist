// Linguistic working-alliance markers (ai-therapist-173): rate one finished
// session on Task, Bond and Goal from its REDACTED transcript and store the
// numbers in session_alliance_ratings (migration 134).
//
// The rubric and the model call are in allianceMarkers.ts; this file decides
// which sessions are rated, when, and what is stored.
//
// Entry points:
//   - Auto: maybeRateAllianceForSession() runs fire-and-forget at the end of
//     the redaction job (sessionRedaction.service.ts), AFTER that job's leak
//     check has finished, and maybeRateAllianceAfterLeakReview() runs when a
//     researcher corrects or approves a message in the leak-review tool. Both
//     do nothing unless system_config.alliance_markers.enabled is true. The
//     code default is OFF.
//   - CLI:  npx tsx src/database/scripts/rateAllianceMarkers.ts (list only by
//     default; --rate to call the judge).
//
// Which sessions: ended sessions of enrolled study participants (a
// participant account, not sandbox, not withdrawn; never a staff, demo,
// harness or anonymous session) whose redaction is complete
// (ALLIANCE_ELIGIBLE_SESSION_SQL in db/allianceRatings.queries.ts).
//
// Which messages: only messages.content_redacted is ever read, and a message
// whose leak check flagged it or could not run is withheld until a
// researcher has reviewed it (allianceReadableTurnSql, same file).
//
// What is stored: one row per (session, ALLIANCE_JUDGE_VERSION), with a
// fingerprint of the transcript it was computed from. A judge call that
// fails is stored as status 'errored' with no scores: unknown, never a low
// rating; it never replaces an answer already stored. The backfill picks
// errored rows up again.
//
// Stale ratings: when the readable transcript changes after a rating (a late
// message is redacted, a message is re-redacted or corrected, a leak review
// releases a message) the stored fingerprint no longer matches. The hook and
// the backfill rate such a session again and replace the row; until then the
// export and the admin read mark it stale.
//
// Overlapping runs: a rating is made under a per-session claim
// (withAllianceRatingClaim), so the hook and the backfill never both pay for
// the same session; the second one skips it.
//
// Token usage is stored on the row itself (tokens_in / tokens_out). It is not
// written to session_llm_usage, whose purpose list has no value for this job,
// so the in-app cost dashboard does not show it; OpenAI billing does.

import OpenAI from 'openai';
import { getOpenAIKey } from '../config/secrets.js';
import {
  getAllianceRating,
  getLeakReviewStateForMessage,
  getSessionsNeedingAllianceRating,
  getSystemConfigByKey,
  getTranscriptForAlliance,
  isSessionAllianceEligible,
  upsertAllianceRating,
  withAllianceRatingClaim,
  type AllianceRatingRow,
  type StoredSubscaleRating,
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

// A session under the length floor is never sent to the judge, so there is no
// probability to store: NULL, not an invented 0.
const NOT_RATEABLE: StoredSubscaleRating = {
  rateable: false,
  pRateable: null,
  score: null,
  level: null,
  confidence: null,
  distribution: null,
};

function allNotRateable(): Record<AllianceSubscale, StoredSubscaleRating> {
  return { task: { ...NOT_RATEABLE }, bond: { ...NOT_RATEABLE }, goal: { ...NOT_RATEABLE } };
}

/**
 * skipped reasons:
 *   not_eligible   the session may not be rated (see the eligibility rule);
 *   already_rated  an answer exists for exactly the transcript as it is now;
 *   in_progress    another run holds the claim for this session right now;
 *   kept_existing  the judge call failed and an earlier answer was left in
 *                  place rather than replaced by an errored row.
 */
export type RateOutcome =
  | { outcome: 'skipped'; reason: 'not_eligible' | 'already_rated' | 'in_progress' | 'kept_existing' }
  | { outcome: 'stored'; row: AllianceRatingRow };

export interface RateOptions {
  /** Rate again even when a current answer for this judge version exists. */
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
 * that is the caller's decision (the automatic hooks check it, the opt-in
 * script is itself the opt-in). Never throws for a failed judge call; that is
 * stored as an errored row.
 *
 * A session that already has an answer is rated again only when that answer
 * is stale (the readable transcript has changed since) or with `force`.
 */
export async function rateSessionAlliance(sessionId: string, options: RateOptions = {}): Promise<RateOutcome> {
  if (!(await isSessionAllianceEligible(sessionId))) return { outcome: 'skipped', reason: 'not_eligible' };

  // Everything from the "is there an answer already" check to the write
  // happens under the claim, so a second run that starts meanwhile neither
  // calls the judge nor writes.
  const claimed = await withAllianceRatingClaim(sessionId, ALLIANCE_JUDGE_VERSION, () =>
    rateClaimedSession(sessionId, options),
  );
  return claimed.acquired ? claimed.result : { outcome: 'skipped', reason: 'in_progress' };
}

async function rateClaimedSession(sessionId: string, options: RateOptions): Promise<RateOutcome> {
  const { turns, fingerprint } = await getTranscriptForAlliance(sessionId);

  if (!options.force) {
    const existing = await getAllianceRating(sessionId, ALLIANCE_JUDGE_VERSION);
    if (existing && existing.status !== 'errored' && existing.transcript_fingerprint === fingerprint) {
      return { outcome: 'skipped', reason: 'already_rated' };
    }
  }

  const stats = transcriptStats(turns);
  const base = {
    sessionId,
    judgeVersion: ALLIANCE_JUDGE_VERSION,
    participantTurns: stats.participantTurns,
    participantWords: stats.participantWords,
    transcriptMessages: turns.length,
    transcriptFingerprint: fingerprint,
  };
  // upsertAllianceRating returns null only when an errored result was refused
  // because an answer is already stored.
  const stored = (row: AllianceRatingRow | null): RateOutcome =>
    row ? { outcome: 'stored', row } : { outcome: 'skipped', reason: 'kept_existing' };

  // Too little participant speech to carry evidence for anything: recorded as
  // not rateable without spending a model call.
  if (belowLengthFloor(stats)) {
    return stored(
      await upsertAllianceRating({
        ...base,
        status: 'too_short',
        subscales: allNotRateable(),
        transcriptChars: null,
        transcriptTruncated: false,
        model: null,
        tokensIn: null,
        tokensOut: null,
      }),
    );
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
    return stored(row);
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
    if (!row) {
      log.warn(`alliance: kept the stored answer for ${sessionId.substring(0, 12)}... after a failed re-rating`);
    }
    return stored(row);
  }
}

// The automatic hooks rate one session at a time in this process. Each rating
// holds one pool connection for its claim while the judge answers; without
// the queue a burst of session ends (or the redaction sweep working through a
// backlog) would hold one each and starve the live app of connections.
let hookQueue: Promise<void> = Promise.resolve();

/**
 * Fire-and-forget hook for the end of the redaction job (after its leak
 * check). Safe to call unconditionally: it does nothing unless the switch is
 * on, skips a red-team harness session that did not opt in to post-session
 * work, and never throws or rejects. Rates a session that has no answer, an
 * errored one or a stale one. The returned promise settles when this
 * session's turn in the queue is done (tests await it; callers ignore it).
 */
export function maybeRateAllianceForSession(sessionId: string): Promise<void> {
  const run = async (): Promise<void> => {
    const cfg = await getAllianceMarkersConfig();
    if (!cfg.enabled) return;
    if (await shouldSkipPostSessionWork(sessionId, 'alliance')) return;
    await rateSessionAlliance(sessionId);
  };
  hookQueue = hookQueue.then(run).catch((err) => log.error({ err }, `alliance rating failed for ${sessionId}`));
  return hookQueue;
}

/**
 * Fire-and-forget hook for the leak-review tool: a researcher corrected or
 * approved a message, which changes what the judge may read (a corrected
 * text, or a withheld message released). Does nothing unless the switch is
 * on. While other messages of the session still wait for review it does
 * nothing either, so reviewing a session message by message costs one new
 * rating at the end, not one per message; meanwhile the stored rating reads
 * as stale. Never throws or rejects.
 */
export function maybeRateAllianceAfterLeakReview(messageId: string | number): Promise<void> {
  return getAllianceMarkersConfig()
    .then(async (cfg) => {
      if (!cfg.enabled) return;
      const state = await getLeakReviewStateForMessage(messageId);
      if (!state || state.awaitingReview > 0) return;
      await maybeRateAllianceForSession(state.sessionId);
    })
    .catch((err) => log.error({ err }, `alliance rating after leak review failed for message ${messageId}`));
}

export interface BackfillSummary {
  candidates: number;
  rated: number;
  tooShort: number;
  errored: number;
  skipped: number;
}

/** Rate every eligible session that has no current answer under the current
 *  judge version (never rated, errored, or stale), one at a time, oldest
 *  first. `skipped` counts sessions another run was rating at that moment and
 *  failed re-ratings that left the stored answer in place. */
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
