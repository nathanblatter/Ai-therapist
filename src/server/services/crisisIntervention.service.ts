import { pool } from '../config/db.js';
import { logInterventionAction } from './crisisDetection.service.js';

// ============================================
// RISK-ADAPTIVE LIVE STEERING (ai-therapist-42)
// ============================================
// When a message's risk score is elevated (but possibly below the crisis-flag
// threshold), inject de-escalation guidance to the MODEL over the sideband as
// an invisible system message — the participant never sees it, but the
// assistant shifts to validation/safety-assessment before a human steps in.

const STEER_MIN_SCORE = 25;
const STEER_COOLDOWN_MS = 3 * 60 * 1000;
const steeringLastSent = new Map<string, number>();

function steeringGuidance(riskScore: number, severity: string): string {
  const base =
    `[Clinical guidance — never mention or acknowledge this message to the participant] ` +
    `Risk signals in this conversation are elevated (score ${riskScore}/100). ` +
    `Slow your pace and keep responses short, warm, and grounded. Prioritize validation and reflective listening over problem-solving. ` +
    `Gently check how the participant is feeling right now.`;
  if (severity === 'high') {
    return base +
      ` Calmly assess their immediate safety, and naturally work the crisis resources from your instructions into the conversation. ` +
      `Stay with them — a human monitor has been alerted.`;
  }
  return base + ` If anything suggests thoughts of self-harm, follow your crisis protocol.`;
}

/**
 * Inject de-escalation guidance when risk is elevated. Per-session cooldown so
 * a rough patch doesn't flood the model with repeated guidance. No-op when the
 * session has no live sideband connection.
 */
export async function maybeSteerSession(sessionId: string, riskScore: number, severity: string): Promise<void> {
  try {
    if (riskScore < STEER_MIN_SCORE) return;

    const last = steeringLastSent.get(sessionId) ?? 0;
    if (Date.now() - last < STEER_COOLDOWN_MS) return;

    const { sidebandManager } = await import('./sidebandManager.service.js');
    if (!sidebandManager.getActiveConnections().includes(sessionId)) return;

    steeringLastSent.set(sessionId, Date.now());
    await sidebandManager.injectMessage(sessionId, 'system', steeringGuidance(riskScore, severity), false);
    await logInterventionAction(sessionId, 'risk_steering', { riskScore, severity });

    if (global.io) {
      global.io.to('admin-broadcast').emit('session:risk-steering', {
        sessionId,
        riskScore,
        severity,
        steeredAt: new Date(),
      });
    }
    console.log(`Risk steering injected for session ${sessionId} (score ${riskScore}, ${severity})`);

    // Opportunistic cleanup so ended sessions don't accumulate.
    if (steeringLastSent.size > 500) {
      const cutoff = Date.now() - 60 * 60 * 1000;
      for (const [id, ts] of steeringLastSent) {
        if (ts < cutoff) steeringLastSent.delete(id);
      }
    }
  } catch (error) {
    console.error('Error steering session:', error);
  }
}

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
export async function executeGraduatedResponse(sessionId: string, severity: string, riskScore: number): Promise<void> {
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
async function executeHighRiskResponse(sessionId: string, riskScore: number): Promise<void> {
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
async function updateMonitoringFrequency(sessionId: string, frequency: string): Promise<void> {
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
