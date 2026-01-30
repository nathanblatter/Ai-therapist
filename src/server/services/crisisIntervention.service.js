import { pool } from '../config/db.js';
import { logInterventionAction } from './crisisDetection.service.js';
import { initiateHumanHandoff } from './humanHandoff.service.js';

// ============================================
// GRADUATED RESPONSE SYSTEM
// ============================================

/**
 * Execute graduated response based on risk severity
 * @param {string} sessionId - Session ID
 * @param {string} severity - Risk severity (low, medium, high)
 * @param {number} riskScore - Risk score (0-100)
 */
export async function executeGraduatedResponse(sessionId, severity, riskScore) {
  try {
    switch (severity) {
      case 'low':
        await executeLowRiskResponse(sessionId, riskScore);
        break;
      case 'medium':
        await executeMediumRiskResponse(sessionId, riskScore);
        break;
      case 'high':
        await executeHighRiskResponse(sessionId, riskScore);
        break;
      default:
        console.warn(`Unknown severity level: ${severity}`);
    }
  } catch (error) {
    console.error('Error executing graduated response:', error);
  }
}

// ============================================
// LOW RISK RESPONSE (0-30)
// ============================================

/**
 * Execute low risk intervention
 * Provides self-help resources and coping strategies
 */
async function executeLowRiskResponse(sessionId, riskScore) {
  try {
    // 1. Log intervention
    await logInterventionAction(sessionId, 'low_risk_resources', {
      riskScore,
      resourcesProvided: ['coping_strategies', 'relaxation_techniques', 'grounding_exercises']
    });

    // 2. Send self-help resources message to session
    const resources = {
      role: 'system',
      message_type: 'crisis_intervention',
      content: `I notice you're experiencing some distress. Here are some immediate coping strategies that might help:

**Grounding Technique (5-4-3-2-1):**
- 5 things you can see around you
- 4 things you can touch
- 3 things you can hear
- 2 things you can smell
- 1 thing you can taste

**Deep Breathing (Box Breathing):**
Inhale for 4 seconds → Hold for 4 seconds → Exhale for 4 seconds → Hold for 4 seconds. Repeat 4 times.

**Progressive Muscle Relaxation:**
Tense and release muscle groups, starting from your toes and working up to your head.

If you continue to feel distressed, I'm here to talk. Would you like to discuss what's troubling you?`,
      metadata: {
        intervention_type: 'low_risk_self_help',
        risk_score: riskScore,
        hidden_from_user: false
      }
    };

    await insertInterventionMessage(sessionId, resources);

    // 3. Emit to client (if global.io is available)
    if (global.io) {
      global.io.to(`session:${sessionId}`).emit('messages:new', [resources]);
    }

    console.log(`Low risk intervention sent to session ${sessionId}`);
  } catch (error) {
    console.error('Error executing low risk response:', error);
  }
}

// ============================================
// MEDIUM RISK RESPONSE (31-70)
// ============================================

/**
 * Execute medium risk intervention
 * Alerts supervisors and sends therapeutic check-in
 */
async function executeMediumRiskResponse(sessionId, riskScore) {
  try {
    // 1. Log intervention
    await logInterventionAction(sessionId, 'medium_risk_alert', {
      riskScore,
      alertsSent: ['supervisor_review', 'increased_monitoring'],
      therapeuticCheckIn: true
    });

    // 2. Emit alert to supervisors (therapists + researchers)
    if (global.io) {
      global.io.to('admin-broadcast').emit('session:supervisor-review-required', {
        sessionId,
        severity: 'medium',
        riskScore,
        priority: 'high',
        message: `Session requires supervisor review - Risk score: ${riskScore}`,
        requiredAt: new Date()
      });
    }

    // 3. Send therapeutic check-in message
    const checkIn = {
      role: 'system',
      message_type: 'crisis_intervention',
      content: `I want to make sure you're okay. What you're feeling is valid, and I'm here to support you.

**You're not alone.** Many people experience similar feelings, and there are effective ways to work through this.

I'd like to help you explore:
1. What's most troubling you right now?
2. What typically helps you feel better?
3. Is there someone you trust you could reach out to?

If you're comfortable, let's work through this together. Would you like to talk about what brought this on?

If you need immediate support, here are some resources:
• **988 Suicide & Crisis Lifeline**: Call or text 988 (24/7)
• **Crisis Text Line**: Text HOME to 741741
• **BYU CAPS**: (801) 422-3035 (24/7 crisis support)`,
      metadata: {
        intervention_type: 'medium_risk_therapeutic_checkin',
        risk_score: riskScore,
        hidden_from_user: false
      }
    };

    await insertInterventionMessage(sessionId, checkIn);

    // 4. Send AI guidance protocol (hidden from user, guides AI behavior)
    const aiGuidance = {
      role: 'system',
      message_type: 'ai_guidance',
      content: `CRISIS INTERVENTION PROTOCOL ACTIVATED (MEDIUM RISK):

1. VALIDATE: Acknowledge their pain without judgment
   "I hear how much pain you're in right now, and I want you to know that your feelings are valid."

2. STABILIZE: Use calming, supportive language
   "Let's take this one moment at a time. You're safe right now, and you're not alone."

3. BUILD TRUST: Express genuine care and concern
   "I'm here to support you, and I care about your wellbeing. Would it be okay if we work through this together?"

4. GROUND: Guide them through grounding techniques if appropriate
   "Sometimes it helps to focus on the present moment. Can you tell me 5 things you see around you?"

5. CLARIFY: Understand what's most troubling them
   "Can you tell me what's happening right now that's most overwhelming? Understanding your situation helps me support you better."

6. SAFETY: Assess and encourage professional help
   "I want to make sure you're safe. The crisis counselors at 988 are trained to help in situations like this. Would you be willing to reach out to them?"

7. CONNECT: Emphasize support and human connection
   "Is there someone you trust who you could reach out to? You don't have to go through this alone."

CRITICAL BOUNDARIES:
- You are an AI assistant, NOT a licensed therapist
- You CANNOT diagnose or prescribe treatment
- You MUST refer to professional help for crisis situations
- ALWAYS encourage them to reach out to crisis resources (988, Crisis Text Line, BYU CAPS)
- Do NOT minimize their feelings - show empathy and genuine concern`,
      metadata: {
        ai_protocol: 'crisis_intervention_medium_risk',
        risk_score: riskScore,
        hidden_from_user: true
      }
    };

    await insertInterventionMessage(sessionId, aiGuidance, true);

    // 5. Emit both messages to client
    if (global.io) {
      global.io.to(`session:${sessionId}`).emit('messages:new', [checkIn, aiGuidance]);
    }

    // 6. Increase monitoring frequency
    await updateMonitoringFrequency(sessionId, 'high');

    console.log(`Medium risk intervention sent to session ${sessionId} - Supervisors alerted`);
  } catch (error) {
    console.error('Error executing medium risk response:', error);
  }
}

// ============================================
// HIGH RISK RESPONSE (71-100)
// ============================================

/**
 * Execute high risk intervention
 * Emergency hotline display + human handoff + critical alerts
 */
async function executeHighRiskResponse(sessionId, riskScore) {
  try {
    // 1. Log critical intervention
    await logInterventionAction(sessionId, 'high_risk_emergency', {
      riskScore,
      emergencyProtocol: 'activated',
      hotlineDisplayed: true,
      handoffInitiated: true
    });

    // 2. Display emergency hotline prominently
    const emergencyMessage = {
      role: 'system',
      message_type: 'crisis_emergency',
      content: `🚨 **IMMEDIATE SUPPORT AVAILABLE** 🚨

If you're in crisis or having thoughts of harming yourself, please reach out for immediate help:

**988 Suicide & Crisis Lifeline**
📞 Call or text: 988 (24/7, free, confidential)
💬 Chat online: 988lifeline.org/chat

**Crisis Text Line**
💬 Text HOME to 741741

**Emergency Services**
📞 Call 911 if you're in immediate danger

**BYU Counseling and Psychological Services**
📞 (801) 422-3035 (24/7 crisis support)

You don't have to go through this alone. Trained crisis counselors are ready to help you right now.`,
      metadata: {
        intervention_type: 'high_risk_emergency_hotline',
        risk_score: riskScore,
        emergency: true,
        hidden_from_user: false
      }
    };

    await insertInterventionMessage(sessionId, emergencyMessage);

    // 3. Emit to client with special crisis emergency event
    if (global.io) {
      global.io.to(`session:${sessionId}`).emit('messages:new', [emergencyMessage]);
      global.io.to(`session:${sessionId}`).emit('session:crisis-emergency', {
        severity: 'high',
        riskScore,
        hotlines: {
          primary: { name: '988 Lifeline', number: '988', url: 'https://988lifeline.org/chat' },
          text: { name: 'Crisis Text Line', code: 'HOME to 741741' },
          emergency: { name: 'Emergency', number: '911' },
          byu: { name: 'BYU CAPS', number: '(801) 422-3035' }
        }
      });
    }

    // 4. Initiate human handoff workflow
    await initiateHumanHandoff(sessionId, riskScore);

    // 5. Send urgent alert to all admins
    if (global.io) {
      global.io.to('admin-broadcast').emit('session:crisis-emergency', {
        sessionId,
        severity: 'high',
        riskScore,
        priority: 'critical',
        message: `🚨 CRITICAL: High-risk crisis detected - Immediate attention required`,
        emergencyAt: new Date(),
        requiresImmediateIntervention: true
      });
    }

    // 6. AI response guidance: Crisis intervention protocol
    const interventionPrompt = {
      role: 'system',
      message_type: 'ai_guidance',
      content: `CRISIS INTERVENTION PROTOCOL ACTIVATED:

1. VALIDATE: Acknowledge their pain without judgment
   "I hear how much pain you're in right now, and I want you to know that your feelings are valid."

2. STABILIZE: Use calming, supportive language
   "Let's take this one moment at a time. You're safe right now, and you're not alone."

3. BUILD TRUST: Express genuine care and concern
   "I'm here to support you, and I care about your wellbeing. Would it be okay if we work through this together?"

4. GROUND: Guide them through grounding techniques
   "Let's try a grounding exercise to help you feel more present. Can you name 5 things you see around you right now?"

5. CLARIFY: Understand immediate crisis context
   "Can you tell me what's happening right now that's most overwhelming? Understanding your situation helps me support you better."

6. SAFETY: Assess immediate danger, encourage professional help
   "I want to make sure you're safe. Have you thought about acting on these feelings? The crisis counselors at 988 are trained to help in situations like this."

7. CONNECT: Emphasize support resources and human connection
   "Is there someone you trust who you could reach out to right now? You don't have to go through this alone."

CRITICAL BOUNDARIES:
- You are an AI assistant, NOT a licensed therapist
- You CANNOT diagnose or prescribe treatment
- You MUST refer to professional help for crisis situations
- ALWAYS encourage them to reach out to crisis resources
- Do NOT minimize their feelings - show empathy and genuine concern`,
      metadata: {
        ai_protocol: 'crisis_intervention_sequence',
        risk_score: riskScore,
        hidden_from_user: true
      }
    };

    // Send AI guidance (hidden from user, guides AI behavior)
    await insertInterventionMessage(sessionId, interventionPrompt, true);

    // Emit AI guidance to client so it can send to OpenAI
    if (global.io) {
      global.io.to(`session:${sessionId}`).emit('messages:new', [interventionPrompt]);
    }

    // 7. Update monitoring to critical
    await updateMonitoringFrequency(sessionId, 'critical');

    console.log(`🚨 HIGH RISK intervention sent to session ${sessionId} - Emergency protocol activated`);
  } catch (error) {
    console.error('Error executing high risk response:', error);
  }
}

// ============================================
// HELPER FUNCTIONS
// ============================================

/**
 * Insert intervention message into database
 */
async function insertInterventionMessage(sessionId, messageData, hiddenFromUser = false) {
  try {
    const messageRecord = {
      session_id: sessionId,
      role: messageData.role,
      message_type: messageData.message_type,
      content: messageData.content,
      content_redacted: messageData.content,
      metadata: {
        ...messageData.metadata,
        hidden_from_user: hiddenFromUser,
        intervention_timestamp: new Date().toISOString()
      }
    };

    const result = await pool.query(
      `INSERT INTO messages (session_id, role, message_type, content, content_redacted, metadata, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, CURRENT_TIMESTAMP)
       RETURNING *`,
      [
        messageRecord.session_id,
        messageRecord.role,
        messageRecord.message_type,
        messageRecord.content,
        messageRecord.content_redacted,
        JSON.stringify(messageRecord.metadata)
      ]
    );

    return result.rows[0];
  } catch (error) {
    console.error('Error inserting intervention message:', error);
    throw error;
  }
}

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
