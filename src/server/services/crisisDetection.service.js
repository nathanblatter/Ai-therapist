import { pool } from '../config/db.js';

// ============================================
// CRISIS KEYWORD DETECTION (Layer 1)
// ============================================

const CRISIS_KEYWORDS = {
  high: {
    keywords: [
      // Suicidal ideation
      'suicide', 'kill myself', 'end my life', 'want to die', 'better off dead',
      'not worth living', 'take my own life', 'suicidal',
      // Self-harm
      'self-harm', 'self harm', 'cut myself', 'hurt myself', 'cutting', 'burning myself',
      // Substance crisis
      'overdose', 'pills to die', 'drunk and driving',
      // Violence
      'shoot myself', 'shooting myself', 'gun to my head', 'kill someone', 'hurt others',
      // Abuse/trauma (ongoing)
      'being abused', 'abusing me', 'rape', 'sexual assault', 'domestic violence'
    ],
    score: 75  // Increased from 50 to 75 to trigger HIGH severity (71-100 range)
  },
  medium: {
    keywords: [
      // Depression indicators
      'severe depression', 'hopeless', 'worthless', 'no point living', 'can\'t go on',
      'nothing matters', 'give up', 'no reason to live', 'life is meaningless',
      // Anxiety crisis
      'severe anxiety', 'panic attack', 'can\'t breathe', 'losing control', 'going crazy',
      // Substance abuse
      'addiction', 'substance abuse', 'drinking too much', 'drug problem', 'can\'t stop using',
      // Self-destructive
      'self-destructive', 'reckless behavior', 'don\'t care anymore', 'want to disappear'
    ],
    score: 45  // Increased from 30 to 45 to sit firmly in MEDIUM range (31-70)
  },
  low: {
    keywords: [
      // Stress
      'stressed', 'overwhelmed', 'burned out', 'exhausted', 'can\'t cope',
      // General anxiety
      'anxious', 'worried', 'nervous', 'can\'t sleep', 'insomnia',
      // Relationship
      'relationship problems', 'family issues', 'breakup', 'lonely', 'isolated'
    ],
    score: 15
  }
};

// Emotional markers that intensify risk
const EMOTIONAL_INTENSIFIERS = {
  hopelessness: ['nothing helps', 'tried everything', 'no way out', 'pointless'],
  detachment: ['don\'t feel anything', 'numb', 'disconnected', 'floating', 'empty'],
  urgency: ['right now', 'tonight', 'can\'t wait', 'immediately', 'today'],
  finality: ['goodbye', 'last time', 'final decision', 'done', 'it\'s over']
};

/**
 * Detect crisis keywords in message content
 * @param {string} content - Message content
 * @returns {object} { keywords: string[], score: number }
 */
function detectCrisisKeywords(content) {
  if (!content) return { keywords: [], score: 0 };

  const lowerContent = content.toLowerCase();
  const detectedKeywords = [];
  let totalScore = 0;

  // Check each risk level
  for (const [level, data] of Object.entries(CRISIS_KEYWORDS)) {
    for (const keyword of data.keywords) {
      // Use word boundary matching to avoid partial matches
      const regex = new RegExp(`\\b${keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
      if (regex.test(lowerContent)) {
        detectedKeywords.push({ keyword, level, score: data.score });
        totalScore = Math.max(totalScore, data.score); // Take highest severity
      }
    }
  }

  // Check for emotional intensifiers (add bonus points)
  for (const [type, markers] of Object.entries(EMOTIONAL_INTENSIFIERS)) {
    for (const marker of markers) {
      const regex = new RegExp(`\\b${marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
      if (regex.test(lowerContent)) {
        totalScore += 5; // Add 5 points for each intensifier
      }
    }
  }

  return {
    keywords: detectedKeywords.map(k => k.keyword),
    keywordScore: Math.min(totalScore, 60), // Cap at 60
    detectedKeywords
  };
}

// ============================================
// SENTIMENT ANALYSIS (Layer 2)
// ============================================

const NEGATIVE_SENTIMENT_WORDS = {
  veryNegative: ['terrible', 'awful', 'horrible', 'miserable', 'devastating', 'unbearable', 'agonizing'],
  negative: ['bad', 'sad', 'difficult', 'hard', 'painful', 'struggling', 'suffering'],
  neutral: ['okay', 'fine', 'alright', 'managing'],
  positive: ['good', 'better', 'improving', 'hopeful', 'optimistic'],
  veryPositive: ['great', 'wonderful', 'excellent', 'fantastic', 'amazing']
};

/**
 * Analyze sentiment of message content
 * @param {string} content - Message content
 * @returns {object} { sentiment: number, sentimentScore: number }
 */
function analyzeSentiment(content) {
  if (!content) return { sentiment: 0, sentimentScore: 0 };

  const lowerContent = content.toLowerCase();
  let sentimentValue = 0;

  // Count sentiment words
  for (const word of NEGATIVE_SENTIMENT_WORDS.veryNegative) {
    if (new RegExp(`\\b${word}\\b`, 'i').test(lowerContent)) sentimentValue -= 10;
  }
  for (const word of NEGATIVE_SENTIMENT_WORDS.negative) {
    if (new RegExp(`\\b${word}\\b`, 'i').test(lowerContent)) sentimentValue -= 5;
  }
  for (const word of NEGATIVE_SENTIMENT_WORDS.positive) {
    if (new RegExp(`\\b${word}\\b`, 'i').test(lowerContent)) sentimentValue += 5;
  }
  for (const word of NEGATIVE_SENTIMENT_WORDS.veryPositive) {
    if (new RegExp(`\\b${word}\\b`, 'i').test(lowerContent)) sentimentValue += 10;
  }

  // Normalize to -100 to +100 scale
  const sentiment = Math.max(-100, Math.min(100, sentimentValue));

  // Convert to risk score (0-30 points)
  // Negative sentiment contributes to risk
  const sentimentScore = Math.max(0, Math.floor(-sentiment * 0.3));

  return { sentiment, sentimentScore: Math.min(sentimentScore, 30) };
}

// ============================================
// CONVERSATION CONTEXT ANALYSIS (Layer 3)
// ============================================

/**
 * Assess conversation context and patterns
 * @param {string} sessionId - Session ID
 * @param {array} messageHistory - Recent messages
 * @returns {object} { contextScore: number, factors: array }
 */
async function assessConversationContext(sessionId, messageHistory) {
  let contextScore = 0;
  const factors = [];

  if (!messageHistory || messageHistory.length === 0) {
    return { contextScore: 0, factors: [] };
  }

  // 1. Message frequency analysis (rapid messaging = escalation)
  const recentMessages = messageHistory.filter(m => m.role === 'user').slice(-5);
  if (recentMessages.length >= 3) {
    const timestamps = recentMessages.map(m => new Date(m.created_at).getTime());
    const avgInterval = timestamps.length > 1 ?
      (timestamps[timestamps.length - 1] - timestamps[0]) / (timestamps.length - 1) : Infinity;

    // If messages are less than 30 seconds apart on average
    if (avgInterval < 30000) {
      contextScore += 10;
      factors.push('rapid_messaging');
    }
  }

  // 2. Topic persistence (repeatedly returning to crisis themes)
  const crisisMessageCount = messageHistory.filter(m => {
    const detection = detectCrisisKeywords(m.content);
    return detection.keywords.length > 0;
  }).length;

  if (crisisMessageCount >= 3) {
    contextScore += 15;
    factors.push('persistent_crisis_themes');
  }

  // 3. Isolation mentions
  const isolationKeywords = ['alone', 'no one cares', 'nobody understands', 'by myself', 'isolated'];
  const hasIsolation = messageHistory.some(m =>
    isolationKeywords.some(keyword => new RegExp(`\\b${keyword}\\b`, 'i').test(m.content))
  );

  if (hasIsolation) {
    contextScore += 8;
    factors.push('isolation_mentioned');
  }

  return {
    contextScore: Math.min(contextScore, 30),
    factors
  };
}

// ============================================
// EMOTIONAL TRAJECTORY TRACKING (Layer 4)
// ============================================

/**
 * Track emotional trajectory across recent messages
 * @param {string} sessionId - Session ID
 * @returns {object} { trajectoryScore: number, trend: string }
 */
async function trackEmotionalTrajectory(sessionId) {
  try {
    // Get risk score history for this session
    const historyResult = await pool.query(
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
// MULTI-LAYERED RISK ANALYSIS
// ============================================

/**
 * Analyze message risk using all detection layers
 * @param {object} message - Message object
 * @param {array} conversationHistory - Recent conversation history
 * @returns {object} Risk analysis result
 */
export async function analyzeMessageRisk(message, conversationHistory = []) {
  try {
    // Layer 1: Keyword Detection
    const keywordAnalysis = detectCrisisKeywords(message.content);

    // Layer 2: Sentiment Analysis
    const sentimentAnalysis = analyzeSentiment(message.content);

    // Layer 3: Conversation Context
    const contextAnalysis = await assessConversationContext(message.session_id, conversationHistory);

    // Layer 4: Emotional Trajectory
    const trajectoryAnalysis = await trackEmotionalTrajectory(message.session_id);

    // Calculate total risk score
    const totalScore =
      keywordAnalysis.keywordScore +
      sentimentAnalysis.sentimentScore +
      contextAnalysis.contextScore +
      trajectoryAnalysis.trajectoryScore;

    const riskScore = Math.max(0, Math.min(100, totalScore));

    // Determine severity
    let severity = 'low';
    if (riskScore >= 71) severity = 'high';
    else if (riskScore >= 31) severity = 'medium';

    // Compile factors
    const factors = [
      ...keywordAnalysis.keywords,
      ...contextAnalysis.factors
    ];

    // Save to risk score history
    if (riskScore > 0) {
      await pool.query(
        `INSERT INTO risk_score_history
         (session_id, message_id, risk_score, severity, score_factors, calculated_at)
         VALUES ($1, $2, $3, $4, $5, CURRENT_TIMESTAMP)`,
        [
          message.session_id,
          message.message_id,
          riskScore,
          severity,
          JSON.stringify({
            keyword_score: keywordAnalysis.keywordScore,
            sentiment_score: sentimentAnalysis.sentimentScore,
            context_score: contextAnalysis.contextScore,
            trajectory_score: trajectoryAnalysis.trajectoryScore,
            keywords: keywordAnalysis.keywords,
            trend: trajectoryAnalysis.trend
          })
        ]
      );
    }

    return {
      riskScore,
      severity,
      factors,
      breakdown: {
        keywords: keywordAnalysis.keywordScore,
        sentiment: sentimentAnalysis.sentimentScore,
        context: contextAnalysis.contextScore,
        trajectory: trajectoryAnalysis.trajectoryScore
      }
    };
  } catch (error) {
    console.error('Error in analyzeMessageRisk:', error);
    return {
      riskScore: 0,
      severity: 'low',
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
export async function flagSessionCrisis(sessionId, severity, riskScore, triggeredBy, triggerMethod, messageId, factors, notes) {
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
export async function unflagSessionCrisis(sessionId, unflaggedBy, notes) {
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
export async function updateRiskScore(sessionId, newScore, newSeverity, changedBy, notes) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Get previous values
    const prevResult = await client.query(
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

/**
 * Log intervention action
 */
export async function logInterventionAction(sessionId, actionType, actionDetails) {
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
export async function getSessionCrisisEvents(sessionId) {
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
export async function getActiveCrisisSessions() {
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
export async function getSessionRiskHistory(sessionId) {
  const result = await pool.query(
    `SELECT * FROM risk_score_history
     WHERE session_id = $1
     ORDER BY calculated_at ASC`,
    [sessionId]
  );
  return result.rows;
}
