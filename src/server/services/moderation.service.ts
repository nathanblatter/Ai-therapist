// Free OpenAI moderation scores as an additional crisis signal
// (ai-therapist-167). omni-moderation-latest classifies text (not audio)
// across 13 categories; the three self-harm categories give a second,
// zero-cost screen alongside the keyword tier and the LLM assessor.
//
// Contract: never throws, returns null on any failure — moderation is a
// supplementary signal and its outage must not change existing behavior.
// Calibration caveat (documented by OpenAI): category_scores can shift as
// they upgrade the model, so raw scores are logged with every use and
// thresholds live in one place here.
import OpenAI from 'openai';
import { getOpenAIKey } from '../config/secrets.js';
import { createLogger } from '../utils/logger.js';

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
  return Math.round(
    100 * Math.max(scores.selfHarmIntent, 0.85 * scores.selfHarm, 0.6 * scores.selfHarmInstructions)
  );
}

/** Self-harm moderation scores for one text, or null on any failure. */
export async function getSelfHarmScores(text: string): Promise<SelfHarmScores | null> {
  if (!text || !text.trim()) return null;
  try {
    const openai = await getClient();
    const response = await openai.moderations.create({
      model: MODERATION_MODEL,
      input: text.slice(0, 8000),
    });
    const result = response.results?.[0];
    if (!result) return null;
    const scores = result.category_scores;
    return {
      flagged: result.flagged === true,
      selfHarm: scores?.['self-harm'] ?? 0,
      selfHarmIntent: scores?.['self-harm/intent'] ?? 0,
      selfHarmInstructions: scores?.['self-harm/instructions'] ?? 0,
    };
  } catch (err) {
    log.warn({ err }, 'moderation call failed (supplementary signal, non-fatal)');
    return null;
  }
}
