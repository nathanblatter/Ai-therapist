// Free OpenAI moderation scores as an additional crisis signal
// (ai-therapist-167). omni-moderation-latest classifies text (not audio)
// across 13 categories; the three self-harm categories give a second,
// zero-cost screen alongside the keyword tier and the LLM assessor.
//
// Contract: never throws, returns null on any failure — moderation is a
// supplementary signal and its outage must not change existing behavior.
// A failure is still REPORTED to the caller (getSelfHarmScreen) so the risk
// record can say the screen was down rather than read as "screened, clean",
// and a billing-cap rejection pages the on-call (ai-therapist-190).
//
// No retries (maxRetries: 0, overriding the SDK default of 2): the risk
// pipeline awaits this before the assessor runs, so a retry here would hold
// up the stronger signal for the sake of the weaker one. One attempt, 5s cap.
// Calibration caveat (documented by OpenAI): category_scores can shift as
// they upgrade the model, so raw scores are logged with every use and
// thresholds live in one place here.
import OpenAI from 'openai';
import { getOpenAIKey } from '../config/secrets.js';
import { createLogger } from '../utils/logger.js';
import { classifyOpenAIError, type OpenAIErrorKind } from '../utils/openaiErrors.js';

const log = createLogger('moderation');

const MODERATION_MODEL = 'omni-moderation-latest';
const TIMEOUT_MS = 5000;

let client: OpenAI | null = null;
async function getClient(): Promise<OpenAI> {
  if (!client) {
    client = new OpenAI({ apiKey: await getOpenAIKey(), timeout: TIMEOUT_MS });
  }
  return client;
}

export interface SelfHarmScores {
  flagged: boolean;
  selfHarm: number;
  selfHarmIntent: number;
  selfHarmInstructions: number;
}

/**
 * 0-100 risk contribution from moderation scores. Intent weighs full;
 * generic self-harm and instructions weigh less (instructions often fire on
 * requests for information rather than personal risk).
 */
export function moderationRiskScore(scores: SelfHarmScores): number {
  return Math.round(100 * Math.max(scores.selfHarmIntent, 0.85 * scores.selfHarm, 0.6 * scores.selfHarmInstructions));
}

export interface SelfHarmScreen {
  /** Scores, or null when there was nothing to screen or the call failed. */
  scores: SelfHarmScores | null;
  /** True when the screen could not run - distinct from "ran, nothing found". */
  failed: boolean;
  /** Why it failed (quota, rate_limit, overloaded, timeout, ...). */
  errorKind?: OpenAIErrorKind;
}

/** Self-harm moderation screen for one text. Never throws. */
export async function getSelfHarmScreen(text: string): Promise<SelfHarmScreen> {
  if (!text || !text.trim()) return { scores: null, failed: false };
  try {
    const openai = await getClient();
    const response = await openai.moderations.create(
      {
        model: MODERATION_MODEL,
        input: text.slice(0, 8000),
      },
      { maxRetries: 0 },
    );
    const result = response.results?.[0];
    if (!result) return { scores: null, failed: true, errorKind: 'other' };
    const scores = result.category_scores;
    return {
      scores: {
        flagged: result.flagged === true,
        selfHarm: scores?.['self-harm'] ?? 0,
        selfHarmIntent: scores?.['self-harm/intent'] ?? 0,
        selfHarmInstructions: scores?.['self-harm/instructions'] ?? 0,
      },
      failed: false,
    };
  } catch (err) {
    const info = classifyOpenAIError(err);
    log.warn({ err, kind: info.kind }, 'moderation call failed (supplementary signal, non-fatal)');
    if (info.kind === 'quota') {
      void import('./crisisAlert.service.js')
        .then((m) => m.reportOpenAIQuotaExhausted('moderation', info.code))
        .catch((reportErr) => log.error({ err: reportErr }, 'failed to report moderation quota exhaustion'));
    }
    return { scores: null, failed: true, errorKind: info.kind };
  }
}

/** Self-harm moderation scores for one text, or null on any failure. */
export async function getSelfHarmScores(text: string): Promise<SelfHarmScores | null> {
  return (await getSelfHarmScreen(text)).scores;
}
