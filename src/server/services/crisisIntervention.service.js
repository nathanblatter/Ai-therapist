import { pool } from '../config/db.js';
import { logInterventionAction } from './crisisDetection.service.js';

// ============================================
// GRADUATED RESPONSE SYSTEM
// ============================================

/**
 * Execute graduated response based on risk severity.
 * Only 'high' severity triggers a response (admin alert only).
 * @param {string} sessionId - Session ID
 * @param {string} severity - Risk severity ('high' or 'none')
 * @param {number} riskScore - Risk score (0-100)
 */
export async function executeGraduatedResponse(sessionId, severity, riskScore) {
  try {
    if (severity === 'high') {
      await executeHighRiskResponse(sessionId, riskScore);
    }
  } catch (error) {
    console.error('Error executing graduated response:', error);
  }
}

// ============================================
// HIGH RISK RESPONSE
// ============================================

/**
 * Execute high risk intervention — admin alert only, no automated user message.
 */
async function executeHighRiskResponse(sessionId, riskScore) {
  try {
    await logInterventionAction(sessionId, 'high_risk_emergency', {
      riskScore,
      emergencyProtocol: 'activated'
    });

    if (global.io) {
      global.io.to(`session:${sessionId}`).emit('session:crisis-emergency', {
        severity: 'high',
        riskScore
      });

      global.io.to('admin-broadcast').emit('session:crisis-emergency', {
        sessionId,
        severity: 'high',
        riskScore,
        priority: 'critical',
        message: `CRITICAL: High-risk crisis detected - Immediate attention required`,
        emergencyAt: new Date(),
        requiresImmediateIntervention: true
      });
    }

    await updateMonitoringFrequency(sessionId, 'critical');

    console.log(`HIGH RISK alert sent to admins for session ${sessionId}`);
  } catch (error) {
    console.error('Error executing high risk response:', error);
  }
}

// ============================================
// HELPER FUNCTIONS
// ============================================

/**
 * Update monitoring frequency for session
 */
async function updateMonitoringFrequency(sessionId, frequency) {
  try {
    await pool.query(
      `UPDATE therapy_sessions
       SET monitoring_frequency = $2
       WHERE session_id = $1`,
      [sessionId, frequency]
    );

    await logInterventionAction(sessionId, 'monitoring_increased', {
      previousFrequency: 'normal',
      newFrequency: frequency
    });

    console.log(`Monitoring frequency updated to ${frequency} for session ${sessionId}`);
  } catch (error) {
    console.error('Error updating monitoring frequency:', error);
  }
}
