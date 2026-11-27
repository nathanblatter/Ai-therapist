// Shadow risk scorer (ai-therapist-83, ai-therapist-261): a second,
// independent opinion on every participant turn the crisis pipeline scores.
// It runs BESIDE the pipeline and never acts.
//
// After the production pipeline has its verdict for a turn, the pipeline
// calls shadowScoreTurn() and moves on. This module then asks the OpenAI
// Decisions API the question set in shadowRiskQuestions.ts about the same
// turn, with the same recent transcript the production assessor was given,
// and stores one row in shadow_risk_scores (migration 133): the production
// score and severity at that moment beside the shadow answers. Researchers
// read the disagreements in the admin "Shadow scorer" panel.
//
// What it must never do, and how that is held:
//   - Change what a participant experiences or what staff are paged about.
//     This module imports nothing from the crisis pipeline, the detector,
//     steering, flagging, paging or the socket layer, and nothing in those
//     reads shadow_risk_scores. Its only outputs are one INSERT and log
//     lines. (shadowRiskScorer.isolation.test.ts checks the imports.)
//   - Slow the production path. shadowScoreTurn() is synchronous, returns
//     void and awaits nothing; the work starts on a promise the pipeline
//     never sees. The request has its own deadline (SHADOW_TIMEOUT_MS) and no
//     retries. At most SHADOW_MAX_IN_FLIGHT turns are in flight; a turn that
//     arrives beyond that is dropped (counted in a log line, no row), so a
//     slow Decisions API or database cannot queue work behind the pipeline.
//   - Fail loudly. Every error is caught here. A failed, timed-out or refused
//     answer is stored as status 'errored' ("unknown", never "none"); if even
//     that insert fails it is logged and dropped.
//
// Two switches, both needed:
//   1. system_config.shadow_risk_scorer = {"enabled": true}. DEFAULT OFF: an
//      absent row, an unreadable row or anything but a literal true is off.
//      Read at most once per SHADOW_CONFIG_TTL_MS.
//   2. startShadowRiskScorer(), called once when the server boots
//      (index.ts). Scripts and harnesses that import the pipeline without
//      booting the server never shadow-score.
//
// Data flow: switching it on sends the participant's message text and the
// recent transcript to POST /v1/decisions. The Decisions API has no
// per-request `store: false`; retention follows the organisation's data
// controls. The production assessor already sends the same text to OpenAI.
// No message text is stored by this module.
import OpenAI from 'openai';
import { getOpenAIKey } from '../config/secrets.js';
import { createLogger } from '../utils/logger.js';
import type { RiskSeverity } from '../../shared/riskBands.js';
import {
  buildShadowBody,
  parseShadowResponse,
  ShadowAnswerError,
  SHADOW_MODEL,
  SHADOW_QUESTION_SET_VERSION,
  type ShadowHistoryTurn,
} from './shadowRiskQuestions.js';
import type { ShadowRiskScoreInsert } from '../db/shadowRisk.queries.js';

const log = createLogger('shadowRiskScorer');

export const SHADOW_CONFIG_KEY = 'shadow_risk_scorer';
/** The whole request, start to answer. Measured p95 on the goldens: 0.55 s. */
export const SHADOW_TIMEOUT_MS = 8000;
export const SHADOW_MAX_IN_FLIGHT = 4;
export const SHADOW_CONFIG_TTL_MS = 30_000;

export interface ShadowScorerConfig {
  enabled: boolean;
}
/** DEFAULT OFF. */
export const DEFAULT_SHADOW_CONFIG: ShadowScorerConfig = { enabled: false };

/** Only a literal `enabled: true` turns it on. */
export function parseShadowConfig(value: unknown): ShadowScorerConfig {
  const v = value as { enabled?: unknown } | null | undefined;
  return { enabled: typeof v === 'object' && v !== null && v.enabled === true };
}

export interface ShadowTurn {
  sessionId: string;
  messageId: string | number | null;
  /** The text the production pipeline scored. */
  content: string;
  source?: 'checkin';
  /** The history the production assessor was given for this turn. */
  history: ShadowHistoryTurn[];
  productionScore: number;
  productionSeverity: string;
}

type DecisionsClient = { decisions: { create: (body: OpenAI.DecisionCreateParams) => Promise<unknown> } };

export interface ShadowDeps {
  readConfig: () => Promise<unknown>;
  getClient: () => Promise<DecisionsClient>;
  insert: (row: ShadowRiskScoreInsert) => Promise<void>;
  now: () => number;
  timeoutMs: number;
}

let client: DecisionsClient | null = null;
const realDeps: ShadowDeps = {
  readConfig: async () => {
    const { getSystemConfigByKey } = await import('../db/config.queries.js');
    return (await getSystemConfigByKey(SHADOW_CONFIG_KEY))?.config_value;
  },
  getClient: async () => {
    // Its own client: its own timeout, and no retries (a retry would hold an
    // in-flight slot for a turn nobody is waiting on).
    client ??= new OpenAI({ apiKey: await getOpenAIKey(), timeout: SHADOW_TIMEOUT_MS, maxRetries: 0 });
    return client;
  },
  insert: async (row) => {
    const { insertShadowRiskScore } = await import('../db/shadowRisk.queries.js');
    await insertShadowRiskScore(row);
  },
  now: () => Date.now(),
  timeoutMs: SHADOW_TIMEOUT_MS,
};
let deps: ShadowDeps = realDeps;

let started = false;
let cachedConfig: { value: ShadowScorerConfig; at: number } | null = null;
let configRead: Promise<ShadowScorerConfig> | null = null;
const inFlight = new Set<Promise<void>>();
let dropped = 0;

/** Called once at server boot. Until then shadowScoreTurn does nothing. */
export function startShadowRiskScorer(): void {
  started = true;
}

async function currentConfig(): Promise<ShadowScorerConfig> {
  const now = deps.now();
  if (cachedConfig && now - cachedConfig.at < SHADOW_CONFIG_TTL_MS) return cachedConfig.value;
  // One read at a time, whatever the turn rate.
  configRead ??= (async () => {
    let value = DEFAULT_SHADOW_CONFIG;
    try {
      value = parseShadowConfig(await deps.readConfig());
    } catch (err) {
      // Unreadable is off, and stays off for the TTL: no read per turn
      // against a database that is already struggling.
      log.warn({ err }, 'could not read shadow_risk_scorer config; treating as disabled');
    }
    cachedConfig = { value, at: deps.now() };
    configRead = null;
    return value;
  })();
  return configRead;
}

class ShadowTimeoutError extends Error {}

/** A short code from a fixed vocabulary. Never the error's message: an API
 *  error body is not ours to store beside research data. */
export function errorCodeFor(err: unknown): string {
  if (err instanceof ShadowTimeoutError) return 'timeout';
  if (err instanceof ShadowAnswerError) return 'malformed';
  const e = err as { status?: unknown; name?: unknown; message?: unknown } | null | undefined;
  if (typeof e?.status === 'number' && e.status >= 100 && e.status <= 599) return `http_${e.status}`;
  if (e?.name === 'APIConnectionTimeoutError') return 'timeout';
  if (typeof e?.message === 'string' && e.message.includes('OPENAI_API_KEY')) return 'no_key';
  return 'error';
}

const SEVERITIES: readonly RiskSeverity[] = ['none', 'low', 'medium', 'high'];

/** A stored message id, or null for a check-in or an in-memory stand-in id. */
function storedMessageId(id: string | number | null): number | null {
  if (typeof id === 'number') return Number.isSafeInteger(id) && id > 0 ? id : null;
  return typeof id === 'string' && /^\d{1,15}$/.test(id) ? Number(id) : null;
}

async function ask(turn: ShadowTurn): Promise<unknown> {
  const c = await deps.getClient();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new ShadowTimeoutError('shadow scorer deadline')), deps.timeoutMs);
    timer.unref?.();
  });
  const call = Promise.resolve().then(() => c.decisions.create(buildShadowBody(turn.content, turn.history)));
  // A call that loses the race still settles on its own; its late rejection
  // must not become an unhandled one.
  call.catch(() => undefined);
  return Promise.race([call, deadline]).finally(() => clearTimeout(timer));
}

async function scoreTurn(turn: ShadowTurn): Promise<void> {
  if (!(await currentConfig()).enabled) return;
  const productionSeverity = SEVERITIES.includes(turn.productionSeverity as RiskSeverity)
    ? (turn.productionSeverity as RiskSeverity)
    : null;
  if (productionSeverity === null || !Number.isFinite(turn.productionScore)) return;
  const base = {
    sessionId: turn.sessionId,
    messageId: storedMessageId(turn.messageId),
    turnSource: turn.source === 'checkin' ? ('checkin' as const) : ('message' as const),
    productionScore: Math.min(100, Math.max(0, Math.round(turn.productionScore))),
    productionSeverity,
    model: SHADOW_MODEL,
    questionSetVersion: SHADOW_QUESTION_SET_VERSION,
  };
  const startedAt = deps.now();
  let row: ShadowRiskScoreInsert;
  try {
    const answer = parseShadowResponse(await ask(turn));
    const refused = answer.refused.length > 0;
    row = {
      ...base,
      // A refusal on ANY question makes the turn errored: an answer set with
      // a hole in it is not an answer. What did come back is kept.
      status: refused || answer.severity === null ? 'errored' : 'scored',
      shadowSeverity: answer.severity,
      severityProbabilities: answer.severityProbabilities,
      predicates: answer.predicates,
      refusedQuestions: answer.refused,
      errorCode: refused || answer.severity === null ? 'refused' : null,
      tokensIn: answer.tokensIn,
      tokensOut: answer.tokensOut,
      latencyMs: deps.now() - startedAt,
    };
  } catch (err) {
    const errorCode = errorCodeFor(err);
    log.warn({ errorCode }, `shadow score failed for session ${turn.sessionId.substring(0, 12)}...`);
    row = {
      ...base,
      status: 'errored',
      shadowSeverity: null,
      severityProbabilities: null,
      predicates: null,
      refusedQuestions: [],
      errorCode,
      tokensIn: null,
      tokensOut: null,
      latencyMs: deps.now() - startedAt,
    };
  }
  await deps.insert(row);
}

/**
 * Ask for a shadow score of a turn the production pipeline has just scored.
 * Fire-and-forget: synchronous, returns nothing, never throws, and the
 * caller must not (and cannot) wait for it.
 */
export function shadowScoreTurn(turn: ShadowTurn): void {
  try {
    if (!started) return;
    if (typeof turn.content !== 'string' || turn.content.trim() === '') return;
    if (inFlight.size >= SHADOW_MAX_IN_FLIGHT) {
      dropped++;
      if (dropped === 1 || dropped % 50 === 0) {
        log.warn(`shadow scorer busy (${inFlight.size} in flight); ${dropped} turn(s) dropped so far`);
      }
      return;
    }
    const work: Promise<void> = scoreTurn(turn)
      .catch((err: unknown) => {
        log.error({ errorCode: errorCodeFor(err) }, 'shadow scorer could not record a turn (dropped)');
      })
      .finally(() => {
        inFlight.delete(work);
      });
    inFlight.add(work);
  } catch {
    // Nothing here may reach the crisis pipeline.
  }
}

// ---- test hooks --------------------------------------------------------------

/** Resolves when every shadow score in flight has settled. */
export async function _settleShadowScorerForTests(): Promise<void> {
  while (inFlight.size > 0) await Promise.allSettled([...inFlight]);
}

export function _resetShadowScorerForTests(overrides: Partial<ShadowDeps> | null = null, start = false): void {
  deps = overrides ? { ...realDeps, ...overrides } : realDeps;
  started = start;
  cachedConfig = null;
  configRead = null;
  inFlight.clear();
  dropped = 0;
  client = null;
}

export function _shadowInFlightForTests(): number {
  return inFlight.size;
}
