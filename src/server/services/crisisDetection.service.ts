import OpenAI from 'openai';
import { pool } from '../config/db.js';
import { getOpenAIKey } from '../config/secrets.js';
import { createLogger } from '../utils/logger.js';

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
  medium: {
    keywords: [
      "don't want to be here", 'do not want to be here', "don't want to exist",
      'want to disappear', "can't go on", 'cannot go on', 'no point in living',
      'no point going on', 'give up on life',
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
 * Tiered keyword screen. Exported for tests. Curly quotes are normalized so
 * Whisper transcripts ("don’t") match the straight-quote keyword list.
 */
export function detectCrisisKeywords(content: string): KeywordAnalysis {
  if (!content) return { keywords: [], keywordScore: 0, detectedKeywords: [] };

  const lowerContent = content.toLowerCase().replace(/[‘’]/g, "'");
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

const RISK_MODEL = 'gpt-4o-mini';

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

interface HistoryMessage {
  role: string;
  content?: string | null;
  content_redacted?: string | null;
}

// Periodic sweep: the keyword screen only wakes the LLM when specific phrases
// appear, so someone spiraling in unusual language would sail past it. Every
// SWEEP_EVERY participant messages without an LLM assessment, run one anyway
// over the recent conversation. The counter resets whenever the LLM runs for
// any reason. Cost: at most one extra call per 8 user turns per session.
const SWEEP_EVERY = 8;
const sweepCounters = new Map<string, number>();

function sweepDue(sessionId: string): boolean {
  const count = (sweepCounters.get(sessionId) ?? 0) + 1;
  sweepCounters.set(sessionId, count);
  // Opportunistic cleanup so ended sessions don't accumulate.
  if (sweepCounters.size > 500) {
    for (const [id, c] of sweepCounters) {
      if (c === 0) sweepCounters.delete(id);
      if (sweepCounters.size <= 250) break;
    }
  }
  return count >= SWEEP_EVERY;
}

function resetSweep(sessionId: string): void {
  sweepCounters.set(sessionId, 0);
}

/** LLM contextual assessment of the recent conversation. Throws on failure. */
async function assessRiskWithLLM(
  latestContent: string,
  conversationHistory: HistoryMessage[],
): Promise<LlmRiskAssessment> {
  const client = await getClient();

  const transcript = conversationHistory
    .filter(m => (m.role === 'user' || m.role === 'assistant') && (m.content ?? m.content_redacted))
    .map(m => `${m.role === 'user' ? 'Participant' : 'Assistant'}: ${m.content ?? m.content_redacted}`)
    .join('\n')
    .slice(-6000);

  const response = await client.chat.completions.create({
    model: RISK_MODEL,
    temperature: 0,
    max_tokens: 300,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: RISK_ASSESSMENT_PROMPT },
      {
        role: 'user',
        content: `Recent transcript:\n${transcript}\n\nLatest participant message (the one that tripped the screen):\n"${latestContent}"`,
      },
    ],
  });

  const parsed = JSON.parse(response.choices[0]?.message?.content ?? '{}') as Partial<LlmRiskAssessment>;
  const score = Math.max(0, Math.min(100, Math.round(Number(parsed.risk_score) || 0)));
  const severity = (['none', 'low', 'medium', 'high'] as const).includes(parsed.severity as 'none')
    ? (parsed.severity as LlmRiskAssessment['severity'])
    : score >= 75 ? 'high' : score >= 50 ? 'medium' : score >= 25 ? 'low' : 'none';

  return {
    risk_score: score,
    severity,
    context: typeof parsed.context === 'string' ? parsed.context : 'unclear',
    factors: Array.isArray(parsed.factors) ? parsed.factors.filter((f): f is string => typeof f === 'string').slice(0, 8) : [],
    reasoning: typeof parsed.reasoning === 'string' ? parsed.reasoning.slice(0, 400) : '',
  };
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
    const keywordAnalysis = detectCrisisKeywords(message.content);

    // Trajectory across the session's recent scores (computed BEFORE this
    // message's insert, so it reflects the run-up, not the current message).
    const trajectory = await trackEmotionalTrajectory(message.session_id);

    let riskScore = Math.min(keywordAnalysis.keywordScore, 100);
    let factors = keywordAnalysis.keywords;
    let method = 'keyword_only';
    let llm: LlmRiskAssessment | null = null;

    const isSweep = keywordAnalysis.keywordScore === 0 && sweepDue(message.session_id);

    if (keywordAnalysis.keywordScore > 0 || isSweep) {
      try {
        llm = await assessRiskWithLLM(message.content, conversationHistory);
        resetSweep(message.session_id);
        riskScore = llm.risk_score;
        factors = llm.factors.length > 0 ? llm.factors : keywordAnalysis.keywords;
        method = isSweep ? 'llm_sweep' : 'llm_assessed';
        log.info(
          `[risk] session ${message.session_id.substring(0, 12)}…: ${isSweep ? 'periodic sweep' : `keywords [${keywordAnalysis.keywords.join(', ')}]`} ` +
            `→ LLM ${llm.risk_score}/100 (${llm.context}): ${llm.reasoning}`,
        );
      } catch (err) {
        // LLM unavailable — keyword tier score stands as the provisional score.
        method = 'keyword_fallback';
        log.error({ err }, `[risk] LLM assessment failed for session ${message.session_id}; using keyword tier score ${riskScore}`);
      }
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
          ...(llm ? {
            llm_score: llm.risk_score,
            llm_context: llm.context,
            llm_factors: llm.factors,
            llm_reasoning: llm.reasoning,
          } : {}),
        })
      ]
    );

    return {
      riskScore,
      severity,
      factors,
      breakdown: {
        keywords: keywordAnalysis.keywordScore,
        ...(trajectory.trajectoryScore > 0 ? { trajectory: trajectory.trajectoryScore } : {}),
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

    // Create crisis event
    await client.query(
      `INSERT INTO crisis_events
       (session_id, event_type, severity, risk_score, triggered_by, trigger_method, message_id, risk_factors, notes)
       VALUES ($1, 'flagged', $2, $3, $4, $5, $6, $7, $8)`,
      [sessionId, severity, riskScore, triggeredBy, triggerMethod, messageId, JSON.stringify(factors), notes]
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
    await client.query(
      `INSERT INTO crisis_events
       (session_id, event_type, triggered_by, trigger_method, notes)
       VALUES ($1, 'unflagged', $2, 'manual', $3)`,
      [sessionId, unflaggedBy, notes]
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
    await client.query(
      `INSERT INTO crisis_events
       (session_id, event_type, severity, previous_severity, risk_score, previous_risk_score, triggered_by, trigger_method, notes)
       VALUES ($1, 'risk_score_updated', $2, $3, $4, $5, $6, 'manual', $7)`,
      [sessionId, newSeverity, prev.crisis_severity, newScore, prev.crisis_risk_score, changedBy, notes]
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
export async function getActiveCrisisSessions(): Promise<unknown[]> {
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
     ORDER BY ts.crisis_risk_score DESC, ts.crisis_flagged_at DESC`
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
