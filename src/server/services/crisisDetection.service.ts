import OpenAI from 'openai';
import { pool } from '../config/db.js';
import { getOpenAIKey } from '../config/secrets.js';
import { recordCrisisEvent } from '../db/crisis.queries.js';
import { createLogger } from '../utils/logger.js';
import type { HistoryMessage } from './minorSafeguard.service.js';

const log = createLogger('crisisDetection');

// ============================================
// STAGE 1: TIERED KEYWORD SCREEN
// ============================================
// The keyword screen's job is SCREENING, not judging: any tier match sends the
// conversation to the stage-2 LLM assessment, which understands context
// (negation, bystander talk, quoting the 988 hotline's name, media
// references). The tier score is only used as a provisional fallback when the
// LLM is unavailable. Assistant messages are never scored — the caller gates
// on role (an assistant reciting "988 Suicide & Crisis Lifeline" once flagged
// a session as a high-severity crisis).

const CRISIS_KEYWORDS: Record<string, { keywords: string[]; score: number }> = {
  // Explicit ideation / self-harm / means.
  high: {
    keywords: [
      'suicide', 'suicidal', 'kill myself', 'end my life', 'take my own life',
      'want to die', 'better off dead', 'wish i was dead', 'wish i were dead',
      'end it all', 'no reason to live', 'not worth living',
      'self-harm', 'self harm', 'cut myself', 'hurt myself', 'harm myself',
      'overdose',
    ],
    score: 75,
  },
  // Passive ideation / escape wishes — the phrases the old list missed.
  // (Colloquial forms like "wanna" are normalized to "want to" before
  // matching, so spoken variants land here too.)
  medium: {
    keywords: [
      "don't want to be here", 'do not want to be here', "don't want to exist",
      "don't want to be alive", "don't want to live", "don't want to wake up",
      'want to disappear', "can't go on", 'cannot go on', 'no point in living',
      'no point going on', 'give up on life', 'tired of living', 'tired of being alive',
      'everyone would be better off without me', 'better off without me',
    ],
    score: 40,
  },
  // Acute distress — enough to warrant a contextual look, nothing more.
  low: {
    keywords: [
      'hopeless', 'worthless', "can't take it anymore", 'cannot take it anymore',
      "can't take this anymore", 'no way out',
    ],
    score: 15,
  },
};

interface DetectedKeyword {
  keyword: string;
  level: string;
  score: number;
}

interface KeywordAnalysis {
  keywords: string[];
  keywordScore: number;
  detectedKeywords: DetectedKeyword[];
}

/**
 * Tiered keyword screen. Exported for tests. Input is normalized before
 * matching — curly quotes from Whisper transcripts ("don’t"), colloquial
 * contractions voice transcription produces verbatim ("wanna" — a real spoken
 * passive-ideation turn scored 0 because "don't wanna be here" missed the
 * "don't want to be here" keyword, ai-therapist-126), and missing apostrophes
 * common in typed chat ("dont", "cant"). Over-matching is fine here: a
 * keyword hit only wakes the stage-2 LLM, which judges context.
 */
const NORMALIZATIONS: Array<[RegExp, string]> = [
  [/[‘’]/g, "'"],
  [/\bwanna\b/g, 'want to'],
  [/\bgonna\b/g, 'going to'],
  [/\bgotta\b/g, 'got to'],
  [/\bdont\b/g, "don't"],
  [/\bcant\b/g, "can't"],
  [/\bwont\b/g, "won't"],
  [/\bim\b/g, "i'm"],
];

export function detectCrisisKeywords(content: string): KeywordAnalysis {
  if (!content) return { keywords: [], keywordScore: 0, detectedKeywords: [] };

  let lowerContent = content.toLowerCase();
  for (const [pattern, replacement] of NORMALIZATIONS) {
    lowerContent = lowerContent.replace(pattern, replacement);
  }
  const detectedKeywords: DetectedKeyword[] = [];
  let totalScore = 0;

  for (const [level, data] of Object.entries(CRISIS_KEYWORDS)) {
    for (const keyword of data.keywords) {
      const regex = new RegExp(`\\b${keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
      if (regex.test(lowerContent)) {
        detectedKeywords.push({ keyword, level, score: data.score });
        totalScore = Math.max(totalScore, data.score);
      }
    }
  }

  return {
    keywords: detectedKeywords.map(k => k.keyword),
    keywordScore: totalScore,
    detectedKeywords
  };
}

// ============================================
// STAGE 2: LLM RISK ASSESSMENT
// ============================================

const DEFAULT_RISK_MODEL = 'gpt-4o-mini';

/** Admin-configurable assessor model (system_config crisis.risk_model,
 *  mirroring evals.judge_model) so a candidate model can be A/B'd without a
 *  deploy. Any swap must pass the red-team suite first. */
async function resolveRiskModel(): Promise<string> {
  try {
    const { getSystemConfig } = await import('../utils/sessionHelpers.js');
    const config = await getSystemConfig();
    const crisis = config.crisis as { risk_model?: string } | undefined;
    return typeof crisis?.risk_model === 'string' && crisis.risk_model ? crisis.risk_model : DEFAULT_RISK_MODEL;
  } catch {
    return DEFAULT_RISK_MODEL;
  }
}

let openaiClient: OpenAI | null = null;
async function getClient(): Promise<OpenAI> {
  if (!openaiClient) {
    openaiClient = new OpenAI({ apiKey: await getOpenAIKey() });
  }
  return openaiClient;
}

const RISK_ASSESSMENT_PROMPT = `You are a clinical risk-assessment assistant for an AI-assisted therapy research platform. A keyword screen flagged possible crisis language in a support conversation. Read the recent transcript and assess the PARTICIPANT's current suicide/self-harm risk.

Return STRICT JSON only:
{
  "risk_score": <0-100>,
  "severity": "none" | "low" | "medium" | "high",
  "context": "genuine" | "negated" | "bystander" | "reference" | "unclear",
  "factors": [<short strings: e.g. "passive ideation", "expressed plan", "hopelessness", "protective factors present">],
  "reasoning": "<one sentence>"
}

Context judgment matters more than keywords:
- "reference": mentioning a hotline's name, suicide prevention, a movie/book/news story → score 0-10, severity none.
- "negated": "I'm not suicidal", "I'd never hurt myself" → score 0-15, severity none (unless other signals contradict).
- "bystander": talking about someone ELSE's crisis or loss → score 0-20, severity none/low (their own grief may still warrant low).
- "genuine" acute distress WITHOUT ideation → 15-30, low. Distress alone is hopelessness, worthlessness, exhaustion, "can't take it" — e.g. "I just feel hopeless and worthless lately" is 15-30, low. It is NOT passive ideation: reserve that label for an expressed wish to die, disappear, not exist, not wake up, or not be here. Never score distress alone as medium.
- "genuine" passive ideation ("I don't want to be here anymore", "no point going on") → 40-60, medium.
- "genuine" active ideation without plan → 60-75, high.
- "genuine" ideation with plan, means, or timeframe → 80-100, high.
Weigh protective factors (future plans, reasons for living, engaged help-seeking) downward. Base the score on the participant's CURRENT state in this conversation, not history alone.`;

interface LlmRiskAssessment {
  risk_score: number;
  severity: 'none' | 'low' | 'medium' | 'high';
  context: string;
  factors: string[];
  reasoning: string;
}

// Strict structured output (ai-therapist-179). json_object only guarantees
// *valid* JSON; strict json_schema guarantees the SHAPE, which is what a
// risk-scoring path needs — a malformed severity or a missing risk_score
// previously fell through to defensive defaults that could read as calmer
// than reality. Strict-mode rules: additionalProperties:false, and every
// property listed in `required`.
const RISK_ASSESSMENT_SCHEMA = {
  type: 'json_schema' as const,
  json_schema: {
    name: 'crisis_risk_assessment',
    strict: true,
    schema: {
      type: 'object',
      properties: {
        risk_score: { type: 'integer', minimum: 0, maximum: 100 },
        severity: { type: 'string', enum: ['none', 'low', 'medium', 'high'] },
        context: { type: 'string', enum: ['genuine', 'negated', 'bystander', 'reference', 'unclear'] },
        factors: { type: 'array', items: { type: 'string' } },
        reasoning: { type: 'string' },
      },
      required: ['risk_score', 'severity', 'context', 'factors', 'reasoning'],
      additionalProperties: false,
    },
  },
};

// Sticky fallback: if the configured assessor model rejects json_schema
// (an admin can point crisis.risk_model at anything), degrade to the old
// json_object format for the rest of the process rather than failing the
// assessment. The defensive parsing below still covers that case.
let strictSchemaUnsupported = false;

function isSchemaUnsupportedError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /json_schema|response_format|structured output/i.test(message)
    && /unsupported|not supported|invalid|unknown/i.test(message);
}

// HistoryMessage (role + content/content_redacted) is shared with the minor
// safeguard, which exports the canonical declaration.

// Periodic sweep: the keyword screen only wakes the LLM when specific phrases
// appear, so someone spiraling in unusual language would sail past it. Every
// SWEEP_EVERY participant messages without an LLM assessment, run one anyway
// over the recent conversation. The counter resets whenever the LLM runs for
// any reason. Cost: at most one extra call per 8 user turns per session.
const SWEEP_EVERY = 8;
const sweepCounters = new Map<string, number>();

function sweepDue(sessionId: string): boolean {
  const count = (sweepCounters.get(sessionId) ?? 0) + 1;
  // Opportunistic cleanup so ended sessions don't accumulate. Evict the
  // oldest-inserted entries (Map preserves insertion order); the previous
  // `c === 0` filter deleted only just-reset counters — which active sessions
  // recreate anyway — while stale mid-count sessions accumulated forever.
  // The current session's count is captured above and re-set below, so it
  // survives even if its old entry is evicted.
  if (sweepCounters.size > 500) {
    for (const id of sweepCounters.keys()) {
      if (sweepCounters.size <= 250) break;
      sweepCounters.delete(id);
    }
  }
  sweepCounters.set(sessionId, count);
  return count >= SWEEP_EVERY;
}

/** Test hook: current sweep-counter map size (leak regression guard). */
export function _sweepCounterSizeForTests(): number {
  return sweepCounters.size;
}

function resetSweep(sessionId: string): void {
  sweepCounters.set(sessionId, 0);
}

/** LLM contextual assessment of the recent conversation. Throws on failure. */
async function assessRiskWithLLM(
  latestContent: string,
  conversationHistory: HistoryMessage[],
  sessionId?: string,
): Promise<LlmRiskAssessment> {
  const client = await getClient();

  const transcript = conversationHistory
    .filter(m => (m.role === 'user' || m.role === 'assistant') && (m.content ?? m.content_redacted))
    .map(m => `${m.role === 'user' ? 'Participant' : 'Assistant'}: ${m.content ?? m.content_redacted}`)
    .join('\n')
    .slice(-6000);

  const riskModel = await resolveRiskModel();

  // safety_identifier scopes any OpenAI-side enforcement to this participant
  // rather than the org key; best-effort, never blocks the assessment.
  let safetyIdentifier: string | undefined;
  if (sessionId) {
    try {
      const { safetyIdentifierForSession } = await import('../utils/safetyIdentifier.js');
      safetyIdentifier = await safetyIdentifierForSession(sessionId);
    } catch { /* proceed without */ }
  }

  const callAssessor = (useStrictSchema: boolean) => client.chat.completions.create({
    model: riskModel,
    temperature: 0,
    max_tokens: 300,
    response_format: useStrictSchema ? RISK_ASSESSMENT_SCHEMA : { type: 'json_object' },
    // This call carries un-redacted transcript excerpts (the assessment
    // needs the participant's actual words). Never let it become stored
    // application state on OpenAI's side.
    store: false,
    ...(safetyIdentifier ? { safety_identifier: safetyIdentifier } : {}),
    messages: [
      { role: 'system', content: RISK_ASSESSMENT_PROMPT },
      {
        role: 'user',
        content: `Recent transcript:\n${transcript}\n\nLatest participant message (the one that tripped the screen):\n"${latestContent}"`,
      },
    ],
  });

  let response;
  if (strictSchemaUnsupported) {
    response = await callAssessor(false);
  } else {
    try {
      response = await callAssessor(true);
    } catch (err) {
      if (!isSchemaUnsupportedError(err)) throw err;
      strictSchemaUnsupported = true;
      log.error({ err }, `[risk] model '${riskModel}' rejected strict json_schema; falling back to json_object for this process`);
      response = await callAssessor(false);
    }
  }

  // Structured outputs can return a refusal instead of content. Treat it as
  // an assessment failure so the caller's keyword/moderation fallback runs —
  // never as a silent "no risk found".
  const refusal = response.choices[0]?.message?.refusal;
  if (refusal) {
    throw new Error(`Risk assessor refused to answer: ${String(refusal).slice(0, 200)}`);
  }
  if (response.choices[0]?.finish_reason === 'length') {
    throw new Error('Risk assessment truncated before completing (max_tokens)');
  }

  // Cost tracking (ai-therapist-25c): best-effort, never blocks risk assessment.
  if (sessionId) {
    import('../db/index.js')
      .then(({ recordLlmUsage }) => recordLlmUsage(
        sessionId, 'crisis', riskModel,
        response.usage?.prompt_tokens ?? null, response.usage?.completion_tokens ?? null,
      ))
      .catch(err => log.error({ err }, '[risk] failed to record LLM usage (non-fatal)'));
  }

  const parsed = JSON.parse(response.choices[0]?.message?.content ?? '{}') as Partial<LlmRiskAssessment>;
  const score = Math.max(0, Math.min(100, Math.round(Number(parsed.risk_score) || 0)));

  // Strict schema guarantees severity is a VALID enum, not that it AGREES
  // with risk_score — models do emit mismatched pairs (observed: score 8 with
  // severity 'high'). analyzeStandaloneRisk consumes this severity directly,
  // so reconcile by taking the MORE severe of the model's label and the
  // score-derived band: a "score 90 / severity none" pairing must never read
  // as calm. Fail toward detection, consistent with the rest of the pipeline.
  const derived: LlmRiskAssessment['severity'] =
    score >= 75 ? 'high' : score >= 50 ? 'medium' : score >= 25 ? 'low' : 'none';
  const stated = (['none', 'low', 'medium', 'high'] as const).includes(parsed.severity as 'none')
    ? (parsed.severity as LlmRiskAssessment['severity'])
    : derived;
  const RANK = { none: 0, low: 1, medium: 2, high: 3 } as const;
  const severity = RANK[stated] >= RANK[derived] ? stated : derived;

  return {
    risk_score: score,
    severity,
    context: typeof parsed.context === 'string' ? parsed.context : 'unclear',
    factors: Array.isArray(parsed.factors) ? parsed.factors.filter((f): f is string => typeof f === 'string').slice(0, 8) : [],
    reasoning: typeof parsed.reasoning === 'string' ? parsed.reasoning.slice(0, 400) : '',
  };
}

// ============================================
// STANDALONE RISK ANALYSIS (no session context)
// ============================================

export interface StandaloneRiskResult {
  riskScore: number;
  severity: 'none' | 'low' | 'medium' | 'high';
  factors: string[];
  /** How the score was produced (mirrors analyzeMessageRisk's method field).
   *  'llm_unavailable' = the LLM could not be reached AND there was no keyword
   *  floor to fall back on, so the verdict is INDETERMINATE, not "clear" — the
   *  caller must retry rather than treat it as safe (ai-therapist-142). */
  method: 'keyword_only' | 'llm_assessed' | 'keyword_fallback' | 'llm_unavailable';
  /** True when the scan could not reach a real verdict (LLM down, no keyword
   *  floor). Callers must NOT record this as clear — retry instead. */
  indeterminate?: boolean;
}

/**
 * Two-stage risk analysis for content that is NOT part of a live therapy
 * session (caseworker portal: async thread messages, docs/caseworker-portal.md
 * section 3). Same stage-1 keyword screen and stage-2 LLM context assessment
 * as analyzeMessageRisk, but with NO session machinery: no trajectory bonus,
 * no risk_score_history insert, no periodic sweep counter, no LLM cost row
 * (those are all keyed on a therapy session id, which does not exist here).
 *
 * `historyLines` is optional surrounding conversation (e.g. recent thread
 * messages) for the LLM's context judgment; participant turns should use
 * role 'user' and the counterpart's turns role 'assistant'.
 *
 * Fail-toward-detection: if the LLM call fails after a keyword hit, the
 * keyword tier score stands. Never throws.
 */
export async function analyzeStandaloneRisk(
  content: string,
  historyLines: HistoryMessage[] = [],
): Promise<StandaloneRiskResult> {
  const keywordAnalysis = detectCrisisKeywords(content);

  // Always run the LLM — do NOT short-circuit on a zero keyword score
  // (ai-therapist-142). Async messages have no periodic sweep like live
  // sessions do, so a message whose risk is phrased without lexicon words
  // ("bought a gun", "wrote goodbye letters") would otherwise be scored 0 and
  // marked clear, never seeing the LLM. Message volume is low, so an LLM call
  // per message is affordable and the safe default.
  try {
    const llm = await assessRiskWithLLM(content, historyLines);
    log.info(
      `[risk] standalone: keywords [${keywordAnalysis.keywords.join(', ')}] ` +
        `→ LLM ${llm.risk_score}/100 (${llm.context}): ${llm.reasoning}`,
    );
    return {
      riskScore: llm.risk_score,
      severity: llm.severity,
      factors: llm.factors.length > 0 ? llm.factors : keywordAnalysis.keywords,
      method: 'llm_assessed',
    };
  } catch (err) {
    // LLM unavailable. If keywords hit, the keyword tier score stands (fail
    // toward detection). If there were NO keywords, we have no signal at all —
    // return INDETERMINATE so the caller retries rather than recording "clear"
    // (ai-therapist-142): a means/farewell message the LLM would have caught
    // must not be dismissed just because the model was briefly down.
    if (keywordAnalysis.keywordScore === 0) {
      log.error({ err }, '[risk] standalone LLM unavailable with no keyword floor; verdict indeterminate');
      return { riskScore: 0, severity: 'none', factors: [], method: 'llm_unavailable', indeterminate: true };
    }
    const riskScore = Math.min(keywordAnalysis.keywordScore, 100);
    log.error({ err }, `[risk] standalone LLM assessment failed; using keyword tier score ${riskScore}`);
    return {
      riskScore,
      severity: riskScore >= 75 ? 'high' : riskScore >= 50 ? 'medium' : riskScore >= 25 ? 'low' : 'none',
      factors: keywordAnalysis.keywords,
      method: 'keyword_fallback',
    };
  }
}

// ============================================
// EMOTIONAL TRAJECTORY TRACKING (passive history logging)
// ============================================

interface TrajectoryResult {
  trajectoryScore: number;
  trend: string;
}

/**
 * Track emotional trajectory across recent messages
 * @param {string} sessionId - Session ID
 * @returns {object} { trajectoryScore: number, trend: string }
 */
async function trackEmotionalTrajectory(sessionId: string): Promise<TrajectoryResult> {
  try {
    // Get risk score history for this session
    const historyResult = await pool.query<{ risk_score: number; calculated_at: Date }>(
      `SELECT risk_score, calculated_at
       FROM risk_score_history
       WHERE session_id = $1
       ORDER BY calculated_at DESC
       LIMIT 5`,
      [sessionId]
    );

    const history = historyResult.rows.reverse(); // Chronological order

    if (history.length < 2) {
      return { trajectoryScore: 0, trend: 'insufficient_data' };
    }

    let trajectoryScore = 0;
    let trend = 'stable';

    // Detect downward spiral (increasing risk scores)
    const scores = history.map(h => h.risk_score);
    const isIncreasing = scores.every((score, i) => i === 0 || score >= scores[i - 1]);

    if (isIncreasing && scores.length >= 3) {
      trajectoryScore += 15;
      trend = 'deteriorating';
    }

    // Sudden spike (large increase in short time)
    if (scores.length >= 2) {
      const recentIncrease = scores[scores.length - 1] - scores[scores.length - 2];
      if (recentIncrease > 20) {
        trajectoryScore += 10;
        trend = 'sudden_spike';
      }
    }

    return {
      trajectoryScore: Math.min(trajectoryScore, 20),
      trend
    };
  } catch (error) {
    console.error('Error tracking emotional trajectory:', error);
    return { trajectoryScore: 0, trend: 'error' };
  }
}

// ============================================
// RISK ANALYSIS
// ============================================

interface MessageInput {
  content: string;
  session_id: string;
  message_id?: string | number;
}

interface RiskAnalysisResult {
  riskScore: number;
  severity: string;
  factors: string[];
  breakdown: Record<string, number>;
}

/**
 * Two-stage risk analysis for a participant message.
 *
 * Stage 1: tiered keyword screen (cheap, every message). No match → score 0,
 * no LLM call. Stage 2: on any keyword match, an LLM reads the recent
 * conversation and judges CONTEXT — negation, bystander talk, quoting the
 * hotline, media references all score ~0, while genuine passive/active
 * ideation lands in graduated 25/50/75 bands that drive steering → medium
 * flag → high flag + alert. If the LLM call fails, the keyword tier score
 * stands (fail toward detection, never away from it).
 */
export async function analyzeMessageRisk(message: MessageInput, conversationHistory: HistoryMessage[] = []): Promise<RiskAnalysisResult> {
  try {
    // Free moderation screen runs in parallel with the keyword/trajectory
    // work (ai-therapist-167). It is a supplementary signal: null on outage.
    const moderationPromise = import('./moderation.service.js')
      .then(m => m.getSelfHarmScores(message.content).then(scores => ({ scores, riskOf: m.moderationRiskScore })))
      .catch(() => null);

    const keywordAnalysis = detectCrisisKeywords(message.content);

    // Trajectory across the session's recent scores (computed BEFORE this
    // message's insert, so it reflects the run-up, not the current message).
    const trajectory = await trackEmotionalTrajectory(message.session_id);

    const moderationResult = await moderationPromise;
    const moderation = moderationResult?.scores ?? null;
    const moderationScore = moderation ? moderationResult!.riskOf(moderation) : 0;

    let riskScore = Math.min(keywordAnalysis.keywordScore, 100);
    let factors = keywordAnalysis.keywords;
    let method = 'keyword_only';
    let llm: LlmRiskAssessment | null = null;

    const isSweep = keywordAnalysis.keywordScore === 0 && sweepDue(message.session_id);
    // Moderation as a second screen: when the keyword tier saw nothing but
    // moderation reads meaningful self-harm signal, wake the LLM so the
    // context-aware assessor (negation, bystander, reference) stays the
    // scorer. Moderation itself never scores directly while the LLM is up.
    const isModerationWake = keywordAnalysis.keywordScore === 0 && !isSweep && moderationScore >= 40;

    if (keywordAnalysis.keywordScore > 0 || isSweep || isModerationWake) {
      try {
        llm = await assessRiskWithLLM(message.content, conversationHistory, message.session_id);
        resetSweep(message.session_id);
        riskScore = llm.risk_score;
        factors = llm.factors.length > 0 ? llm.factors : keywordAnalysis.keywords;
        method = isSweep ? 'llm_sweep' : isModerationWake ? 'llm_moderation_wake' : 'llm_assessed';
        log.info(
          `[risk] session ${message.session_id.substring(0, 12)}…: ${isSweep ? 'periodic sweep' : isModerationWake ? `moderation wake (${moderationScore}/100)` : `keywords [${keywordAnalysis.keywords.join(', ')}]`} ` +
            `→ LLM ${llm.risk_score}/100 (${llm.context}): ${llm.reasoning}`,
        );
      } catch (err) {
        // LLM unavailable — fall back to the best available screen signal
        // (fail toward detection, never away from it). Moderation is capped
        // below 90 so a screen alone cannot mimic the very top band.
        riskScore = Math.max(riskScore, Math.min(85, moderationScore));
        method = 'keyword_fallback';
        log.error({ err }, `[risk] LLM assessment failed for session ${message.session_id}; using screen-tier score ${riskScore}`);
      }
    }

    if (moderation && moderationScore >= 30) {
      factors = [...factors, `moderation self-harm signal (${moderationScore}/100)`];
    }

    // Trajectory bonus: a deteriorating run-up makes the same message more
    // concerning. Only applied when the current message itself carries risk,
    // so a neutral message never inherits score from history alone.
    if (riskScore > 0 && trajectory.trajectoryScore > 0) {
      riskScore = Math.min(100, riskScore + trajectory.trajectoryScore);
      factors = [...factors, `trajectory: ${trajectory.trend}`];
    }

    const severity = riskScore >= 75 ? 'high' : riskScore >= 50 ? 'medium' : riskScore >= 25 ? 'low' : 'none';

    // Passive logging — insert unconditionally regardless of flagging.
    // severity column has CHECK (severity IN ('low','medium','high')), so use NULL when no keyword matched.
    // Best-effort: a failed history insert must never zero an already-computed
    // verdict — before this was isolated, an insert error fell into the outer
    // catch and returned riskScore 0 / severity 'none', silently dropping a
    // crisis the LLM had already scored high (fail toward detection).
    try {
      await pool.query(
        `INSERT INTO risk_score_history
         (session_id, message_id, risk_score, severity, score_factors, calculated_at)
         VALUES ($1, $2, $3, $4, $5, CURRENT_TIMESTAMP)`,
        [
          message.session_id,
          message.message_id,
          riskScore,
          severity === 'none' ? null : severity,
          JSON.stringify({
            method,
            keyword_score: keywordAnalysis.keywordScore,
            keywords: keywordAnalysis.keywords,
            ...(trajectory.trajectoryScore > 0 ? {
              trajectory_score: trajectory.trajectoryScore,
              trajectory_trend: trajectory.trend,
            } : {}),
            ...(moderation ? {
              moderation_score: moderationScore,
              moderation_flagged: moderation.flagged,
              moderation_self_harm: moderation.selfHarm,
              moderation_self_harm_intent: moderation.selfHarmIntent,
              moderation_self_harm_instructions: moderation.selfHarmInstructions,
            } : {}),
            ...(llm ? {
              llm_score: llm.risk_score,
              llm_context: llm.context,
              llm_factors: llm.factors,
              llm_reasoning: llm.reasoning,
            } : {}),
          })
        ]
      );
    } catch (insertError) {
      console.error('Error logging risk_score_history (non-fatal, verdict stands):', insertError);
    }

    return {
      riskScore,
      severity,
      factors,
      breakdown: {
        keywords: keywordAnalysis.keywordScore,
        ...(trajectory.trajectoryScore > 0 ? { trajectory: trajectory.trajectoryScore } : {}),
        ...(moderationScore > 0 ? { moderation: moderationScore } : {}),
        ...(llm ? { llm: llm.risk_score } : {}),
      }
    };
  } catch (error) {
    console.error('Error in analyzeMessageRisk:', error);
    return {
      riskScore: 0,
      severity: 'none',
      factors: [],
      breakdown: {}
    };
  }
}

// ============================================
// DATABASE OPERATIONS
// ============================================

/**
 * Flag a session as crisis
 */
export async function flagSessionCrisis(
  sessionId: string,
  severity: string,
  riskScore: number,
  triggeredBy: string,
  triggerMethod: string,
  messageId: string | number | null,
  factors: string[],
  notes: string | null
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Update therapy_sessions
    await client.query(
      `UPDATE therapy_sessions
       SET crisis_flagged = TRUE,
           crisis_severity = $2::VARCHAR,
           crisis_risk_score = $3,
           crisis_flagged_at = CURRENT_TIMESTAMP,
           crisis_flagged_by = $4,
           monitoring_frequency = CASE
             WHEN $2::VARCHAR = 'high' THEN 'critical'
             WHEN $2::VARCHAR = 'medium' THEN 'high'
             ELSE 'normal'
           END
       WHERE session_id = $1`,
      [sessionId, severity, riskScore, triggeredBy]
    );

    // Create crisis event (single writer: db/crisis.queries recordCrisisEvent)
    await recordCrisisEvent(
      {
        sessionId,
        eventType: 'flagged',
        severity,
        riskScore,
        triggeredBy,
        triggerMethod,
        messageId,
        riskFactors: factors,
        notes,
      },
      client
    );

    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }

  // IRB adverse-event auto-draft (ai-therapist-95): a high-severity flag is a
  // qualifying adverse event. Fire-and-forget after COMMIT so it can never
  // affect the crisis pipeline; the assembler is idempotent per crisis_event_id.
  // Dynamic import matches the crisisAlert pattern and keeps test mocking easy.
  if (severity === 'high') {
    import('./adverseEvent.service.js')
      .then(m => m.draftAdverseEventFromCrisis(sessionId))
      .catch(err => console.error('AE auto-draft failed:', err));
  }
}

/**
 * Unflag a session
 */
export async function unflagSessionCrisis(sessionId: string, unflaggedBy: string, notes: string | null): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Update therapy_sessions
    await client.query(
      `UPDATE therapy_sessions
       SET crisis_flagged = FALSE,
           crisis_unflagged_at = CURRENT_TIMESTAMP,
           crisis_unflagged_by = $2,
           monitoring_frequency = 'normal'
       WHERE session_id = $1`,
      [sessionId, unflaggedBy]
    );

    // Create crisis event
    await recordCrisisEvent(
      { sessionId, eventType: 'unflagged', triggeredBy: unflaggedBy, triggerMethod: 'manual', notes },
      client
    );

    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Update risk score
 */
export async function updateRiskScore(
  sessionId: string,
  newScore: number,
  newSeverity: string,
  changedBy: string,
  notes: string | null
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Get previous values
    const prevResult = await client.query<{ crisis_risk_score: number; crisis_severity: string }>(
      `SELECT crisis_risk_score, crisis_severity FROM therapy_sessions WHERE session_id = $1`,
      [sessionId]
    );
    const prev = prevResult.rows[0];

    // Update therapy_sessions
    await client.query(
      `UPDATE therapy_sessions
       SET crisis_risk_score = $2,
           crisis_severity = $3
       WHERE session_id = $1`,
      [sessionId, newScore, newSeverity]
    );

    // Create crisis event
    await recordCrisisEvent(
      {
        sessionId,
        eventType: 'risk_score_updated',
        severity: newSeverity,
        previousSeverity: prev.crisis_severity,
        riskScore: newScore,
        previousRiskScore: prev.crisis_risk_score,
        triggeredBy: changedBy,
        triggerMethod: 'manual',
        notes,
      },
      client
    );

    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

interface ActionDetails {
  riskScore?: number;
  [key: string]: unknown;
}

/**
 * Log intervention action
 */
export async function logInterventionAction(sessionId: string, actionType: string, actionDetails: ActionDetails): Promise<void> {
  try {
    await pool.query(
      `INSERT INTO intervention_actions
       (session_id, action_type, action_details, risk_score)
       VALUES ($1, $2, $3, $4)`,
      [
        sessionId,
        actionType,
        JSON.stringify(actionDetails),
        actionDetails.riskScore || null
      ]
    );
  } catch (error) {
    console.error('Error logging intervention action:', error);
  }
}

/**
 * Get session crisis events
 */
export async function getSessionCrisisEvents(sessionId: string): Promise<unknown[]> {
  const result = await pool.query(
    `SELECT * FROM crisis_events
     WHERE session_id = $1
     ORDER BY created_at DESC`,
    [sessionId]
  );
  return result.rows;
}

/**
 * Get active crisis sessions
 */
export async function getActiveCrisisSessions(orgId?: number | null): Promise<unknown[]> {
  // orgId scopes the read to one organization (org-bound researchers, C13);
  // null returns byte-identical rows to the pre-scoping query (care-team
  // callers, who are further caseload-filtered by the route).
  const result = await pool.query(
    `SELECT
       ts.session_id,
       ts.user_id,
       ts.crisis_severity,
       ts.crisis_risk_score,
       ts.crisis_flagged_at,
       ts.crisis_flagged_by,
       u.username
     FROM therapy_sessions ts
     LEFT JOIN users u ON ts.user_id = u.userid
     WHERE ts.crisis_flagged = TRUE
       AND ($1::int IS NULL OR u.organization_id = $1)
     ORDER BY ts.crisis_risk_score DESC, ts.crisis_flagged_at DESC`,
    [orgId ?? null]
  );
  return result.rows;
}

/**
 * Get session risk history
 */
export async function getSessionRiskHistory(sessionId: string): Promise<unknown[]> {
  const result = await pool.query(
    `SELECT * FROM risk_score_history
     WHERE session_id = $1
     ORDER BY calculated_at ASC`,
    [sessionId]
  );
  return result.rows;
}
