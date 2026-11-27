// Structured per-session features (ai-therapist-172): code one finished
// session on the session-features codebook from its REDACTED transcript and
// store the answers in session_features (migration 135).
//
// The codebook and the model call are in sessionFeatures.ts; this file
// decides which sessions are coded, when, and what is stored. It follows the
// alliance-rating job (allianceRating.service.ts) rule for rule and shares
// its session and message rules, fingerprint, claim and hook queue
// (db/sessionJudge.queries.ts, sessionJudgeQueue.ts).
//
// Entry points:
//   - Auto: maybeExtractFeaturesForSession() runs fire-and-forget at the end
//     of the redaction job (sessionRedaction.service.ts), AFTER that job's
//     leak check has finished, and maybeExtractFeaturesAfterLeakReview() runs
//     when a researcher corrects or approves a message in the leak-review
//     tool. Both do nothing unless system_config.session_features.enabled is
//     true. The code default is OFF.
//   - CLI:  npx tsx src/database/scripts/extractSessionFeatures.ts (list only
//     by default; --extract to call the judge).
//
// Which sessions: ended sessions of enrolled study participants (a
// participant account, not sandbox, not withdrawn; never a staff, demo,
// harness or anonymous session) whose redaction is complete
// (JUDGE_ELIGIBLE_SESSION_SQL).
//
// Which messages: only messages.content_redacted is ever read, and a message
// whose leak check flagged it or could not run is withheld until a
// researcher has reviewed it (judgeReadableTurnSql).
//
// What is stored: one row per (session, SESSION_FEATURE_SET_VERSION), with a
// fingerprint of the transcript it was computed from. A session under the
// length floor is 'too_short' with no values at all. A judge call that fails
// is 'errored' with no values: unknown, never "absent"; it never replaces an
// answer already stored. A single variable the model refused or answered
// unusably is stored as unknown inside an otherwise extracted row.
//
// Stale rows: when the readable transcript changes afterwards (a late message
// is redacted, a message is re-redacted or corrected, a leak review releases
// a message) the stored fingerprint no longer matches. The hook and the
// backfill code such a session again and replace the row; until then the
// export marks it stale.
//
// Token usage is stored on the row itself (tokens_in / tokens_out). It is not
// written to session_llm_usage, whose purpose list has no value for this job,
// so the in-app cost dashboard does not show it; OpenAI billing does.

import OpenAI from 'openai';
import { getOpenAIKey } from '../config/secrets.js';
import {
  getLeakReviewStateForMessage,
  getSessionFeatures,
  getSessionsNeedingFeatures,
  getSystemConfigByKey,
  upsertSessionFeatures,
  withSessionFeaturesClaim,
  type SessionFeaturesRow,
} from '../db/index.js';
import { getTranscriptForJudge, isSessionJudgeEligible } from '../db/sessionJudge.queries.js';
import { createLogger } from '../utils/logger.js';
// The transcript as a judge reads it, and the length floor, are the alliance
// judge's: one rendering and one floor for both. Changing the floor, the
// character budget or the rendering in allianceMarkers.ts changes what this
// judge reads: bump SESSION_FEATURE_SET_VERSION in the same change (a test in
// sessionFeatures.test.ts pins the three values to make that hard to miss).
import { belowLengthFloor, renderTranscript, transcriptStats } from './allianceMarkers.js';
import { shouldSkipPostSessionWork } from './harnessPostSession.service.js';
import {
  SESSION_FEATURE_SET_VERSION,
  SESSION_FEATURES_MODEL,
  askSessionFeatures,
  type SessionFeaturesClient,
} from './sessionFeatures.js';
import { enqueueSessionJudgeJob } from './sessionJudgeQueue.js';

const log = createLogger('sessionFeatures');

export interface SessionFeaturesConfig {
  enabled: boolean;
}

/** Code default: OFF. Only an explicit `enabled: true` turns the job on. */
export const DEFAULT_SESSION_FEATURES_CONFIG: SessionFeaturesConfig = { enabled: false };

/** system_config.session_features. Any doubt (no row, a malformed value, a
 *  failed read) means off. */
export async function getSessionFeaturesConfig(): Promise<SessionFeaturesConfig> {
  try {
    const row = await getSystemConfigByKey('session_features');
    const value = (row?.config_value ?? {}) as { enabled?: unknown };
    return { enabled: value.enabled === true };
  } catch (err) {
    log.warn({ err }, 'could not read session_features config; treating it as off');
    return { ...DEFAULT_SESSION_FEATURES_CONFIG };
  }
}

/**
 * skipped reasons:
 *   not_eligible       the session may not be coded (see the eligibility rule);
 *   already_extracted  an answer exists for exactly the transcript as it is now;
 *   in_progress        another run holds the claim for this session right now;
 *   kept_existing      the judge call failed and an earlier answer was left in
 *                      place rather than replaced by an errored row.
 */
export type ExtractOutcome =
  | { outcome: 'skipped'; reason: 'not_eligible' | 'already_extracted' | 'in_progress' | 'kept_existing' }
  | { outcome: 'stored'; row: SessionFeaturesRow };

export interface ExtractOptions {
  /** Code again even when a current answer for this feature set exists. */
  force?: boolean;
  /** Test seam. */
  client?: SessionFeaturesClient;
}

let sharedClient: OpenAI | null = null;
async function getClient(): Promise<SessionFeaturesClient> {
  if (!sharedClient) sharedClient = new OpenAI({ apiKey: await getOpenAIKey(), timeout: 120_000 });
  return sharedClient;
}

/**
 * Code one session and store the result. Does not look at the on/off switch:
 * that is the caller's decision (the automatic hooks check it, the opt-in
 * script is itself the opt-in). Never throws for a failed judge call; that is
 * stored as an errored row.
 *
 * A session that already has an answer is coded again only when that answer
 * is stale (the readable transcript has changed since) or with `force`.
 */
export async function extractSessionFeatures(sessionId: string, options: ExtractOptions = {}): Promise<ExtractOutcome> {
  if (!(await isSessionJudgeEligible(sessionId))) return { outcome: 'skipped', reason: 'not_eligible' };

  // Everything from the "is there an answer already" check to the write
  // happens under the claim, so a second run that starts meanwhile neither
  // calls the judge nor writes.
  const claimed = await withSessionFeaturesClaim(sessionId, SESSION_FEATURE_SET_VERSION, () =>
    extractClaimedSession(sessionId, options),
  );
  return claimed.acquired ? claimed.result : { outcome: 'skipped', reason: 'in_progress' };
}

async function extractClaimedSession(sessionId: string, options: ExtractOptions): Promise<ExtractOutcome> {
  const { turns, fingerprint } = await getTranscriptForJudge(sessionId);

  if (!options.force) {
    const existing = await getSessionFeatures(sessionId, SESSION_FEATURE_SET_VERSION);
    if (existing && existing.status !== 'errored' && existing.transcript_fingerprint === fingerprint) {
      return { outcome: 'skipped', reason: 'already_extracted' };
    }
  }

  const stats = transcriptStats(turns);
  const base = {
    sessionId,
    featureSetVersion: SESSION_FEATURE_SET_VERSION,
    participantTurns: stats.participantTurns,
    participantWords: stats.participantWords,
    transcriptMessages: turns.length,
    transcriptFingerprint: fingerprint,
  };
  // upsertSessionFeatures returns null only when an errored result was
  // refused because an answer is already stored.
  const stored = (row: SessionFeaturesRow | null): ExtractOutcome =>
    row ? { outcome: 'stored', row } : { outcome: 'skipped', reason: 'kept_existing' };

  // Too little participant speech to code anything from: recorded as such
  // without a model call, with no values (not a row of "absent").
  if (belowLengthFloor(stats)) {
    return stored(
      await upsertSessionFeatures({
        ...base,
        status: 'too_short',
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
    const answer = await askSessionFeatures(options.client ?? (await getClient()), text);
    const row = await upsertSessionFeatures({
      ...base,
      status: 'extracted',
      features: answer.features,
      unknownCount: answer.unknownCount,
      transcriptChars: text.length,
      transcriptTruncated: truncated,
      model: answer.model,
      tokensIn: answer.tokensIn,
      tokensOut: answer.tokensOut,
    });
    log.info(
      `session features stored for ${sessionId.substring(0, 12)}... [${SESSION_FEATURE_SET_VERSION}]` +
        (answer.unknownCount ? `: ${answer.unknownCount} variable(s) unknown` : ''),
    );
    return stored(row);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error(`session features judge failed for ${sessionId.substring(0, 12)}...: ${message}`);
    const row = await upsertSessionFeatures({
      ...base,
      status: 'errored',
      transcriptChars: text.length,
      transcriptTruncated: truncated,
      model: SESSION_FEATURES_MODEL,
      tokensIn: null,
      tokensOut: null,
      error: message || 'unknown error',
    });
    if (!row) {
      log.warn(`session features: kept the stored answer for ${sessionId.substring(0, 12)}... after a failed re-run`);
    }
    return stored(row);
  }
}

/**
 * Fire-and-forget hook for the end of the redaction job (after its leak
 * check). Safe to call unconditionally: it does nothing unless the switch is
 * on, skips a red-team harness session that did not opt in to post-session
 * work, and never throws or rejects. Codes a session that has no answer, an
 * errored one or a stale one. Runs on the queue shared with the alliance
 * hook, one session at a time. The returned promise settles when this
 * session's turn in the queue is done (tests await it; callers ignore it).
 */
export function maybeExtractFeaturesForSession(sessionId: string): Promise<void> {
  const run = async (): Promise<void> => {
    const cfg = await getSessionFeaturesConfig();
    if (!cfg.enabled) return;
    if (await shouldSkipPostSessionWork(sessionId, 'features')) return;
    await extractSessionFeatures(sessionId);
  };
  return enqueueSessionJudgeJob(run, (err) => log.error({ err }, `session features failed for ${sessionId}`));
}

/**
 * Fire-and-forget hook for the leak-review tool: a researcher corrected or
 * approved a message, which changes what the judge may read. Does nothing
 * unless the switch is on. While other messages of the session still wait
 * for review it does nothing either, so reviewing a session message by
 * message costs one new extraction at the end, not one per message; meanwhile
 * the stored row reads as stale. Never throws or rejects.
 */
export function maybeExtractFeaturesAfterLeakReview(messageId: string | number): Promise<void> {
  return getSessionFeaturesConfig()
    .then(async (cfg) => {
      if (!cfg.enabled) return;
      const state = await getLeakReviewStateForMessage(messageId);
      if (!state || state.awaitingReview > 0) return;
      await maybeExtractFeaturesForSession(state.sessionId);
    })
    .catch((err) => log.error({ err }, `session features after leak review failed for message ${messageId}`));
}

export interface FeaturesBackfillSummary {
  candidates: number;
  extracted: number;
  tooShort: number;
  errored: number;
  skipped: number;
}

/** Code every eligible session that has no current answer under the current
 *  feature-set version (never coded, errored, or stale), one at a time,
 *  oldest first. `skipped` counts sessions another run was coding at that
 *  moment and failed re-runs that left the stored answer in place. */
export async function backfillSessionFeatures(
  opts: { limit?: number | null; client?: SessionFeaturesClient } = {},
): Promise<FeaturesBackfillSummary> {
  const sessionIds = await getSessionsNeedingFeatures(SESSION_FEATURE_SET_VERSION, { limit: opts.limit ?? null });
  const summary: FeaturesBackfillSummary = {
    candidates: sessionIds.length,
    extracted: 0,
    tooShort: 0,
    errored: 0,
    skipped: 0,
  };
  for (const sessionId of sessionIds) {
    const result = await extractSessionFeatures(sessionId, { client: opts.client });
    if (result.outcome === 'skipped') summary.skipped++;
    else if (result.row.status === 'extracted') summary.extracted++;
    else if (result.row.status === 'too_short') summary.tooShort++;
    else summary.errored++;
  }
  return summary;
}
