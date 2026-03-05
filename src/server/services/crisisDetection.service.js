import { pool } from '../config/db.js';

// ============================================
// CRISIS KEYWORD DETECTION
// ============================================

const CRISIS_KEYWORDS = {
  high: {
    keywords: [
      // Suicidal ideation
      'suicide', 'kill myself', 'end my life', 'want to die',
      // Self-harm
      'self-harm', 'cut myself',
      // Substance crisis
      'overdose'
    ],
    score: 75
  }
};

/**
 * Detect crisis keywords in message content
 * @param {string} content - Message content
 * @returns {object} { keywords: string[], keywordScore: number, detectedKeywords: array }
 */
function detectCrisisKeywords(content) {
  if (!content) return { keywords: [], keywordScore: 0, detectedKeywords: [] };

  const lowerContent = content.toLowerCase();
  const detectedKeywords = [];
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
// EMOTIONAL TRAJECTORY TRACKING (passive history logging)
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
// RISK ANALYSIS
// ============================================

/**
 * Analyze message risk using keyword detection only.
 * Trajectory is tracked passively for history but does not affect score.
 * @param {object} message - Message object
 * @param {array} conversationHistory - Unused, kept for call-site compatibility
 * @returns {object} Risk analysis result
 */
export async function analyzeMessageRisk(message, conversationHistory = []) {
  try {
    const keywordAnalysis = detectCrisisKeywords(message.content);

    // Call passively for history logging — score not added to total
    await trackEmotionalTrajectory(message.session_id);

    const riskScore = Math.min(keywordAnalysis.keywordScore, 100);
    const severity = riskScore >= 75 ? 'high' : 'none';

    const factors = keywordAnalysis.keywords;

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
          keyword_score: keywordAnalysis.keywordScore,
          keywords: keywordAnalysis.keywords
        })
      ]
    );

    return {
      riskScore,
      severity,
      factors,
      breakdown: {
        keywords: keywordAnalysis.keywordScore
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
