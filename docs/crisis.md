# Crisis Management System Implementation Plan

## Overview
Implement a comprehensive, multi-layered crisis detection and intervention system with graduated response protocols, emotional trajectory tracking, and safe integration with human clinicians. System combines clinical keyword triggers, sentiment analysis, contextual risk scoring, and automated handoff pathways to ensure participant safety.

## Core Requirements

### Detection & Risk Assessment
- **Multi-layered detection**: Clinical keywords + sentiment analysis + conversation context + emotional trajectory
- **Risk scoring**: 0-100 scale based on multiple factors (keywords, sentiment shifts, demographics, conversation history)
- **Continuous monitoring**: Track emotional trajectory toward hopelessness, panic, or detachment
- **Manual override**: Admin flagging with severity levels (low, medium, high)

### Graduated Response System
- **Low Risk (0-30)**: Self-help resources, coping strategies, relaxation techniques
- **Medium Risk (31-70)**: Supervisor review alert, increased monitoring, therapeutic check-ins
- **High Risk (71-100)**: Immediate emergency hotline display, human handoff preparation, real-world intervention

### Crisis Intervention Sequence
1. Validation and acknowledgment of distress
2. Emotional stabilization and soothing
3. Trust-building and active listening
4. Grounding techniques (breathing, 5-4-3-2-1 sensory)
5. Crisis context clarification
6. Co-develop coping plan
7. Safety commitment prompts

### Human Integration & Handoff
- **Automated handoff**: Direct API integration with crisis hotlines (988, Crisis Text Line)
- **Bypass urgent queues**: High-risk cases skip automated responses
- **Clinical oversight**: Therapeutic evaluators review flagged sessions
- **Audit compliance**: Complete documentation for legal/ethical review

### Continuous Improvement
- **Iterative testing**: Real-world feedback loops, A/B testing responses
- **Post-incident reviews**: Document outcomes, refine triggers
- **Boundary safeguards**: Prevent role confusion, scope creep, inappropriate advice
- **Transparency**: Clear disclaimers about chatbot limitations

---

## Implementation Steps

### 1. Database Migration

**File:** `src/database/migrations/011_add_crisis_management.sql` (NEW)

Comprehensive crisis management database schema:

```sql
BEGIN;

-- ============================================
-- Add crisis fields to therapy_sessions table
-- ============================================
ALTER TABLE therapy_sessions
ADD COLUMN crisis_flagged BOOLEAN DEFAULT FALSE,
ADD COLUMN crisis_severity VARCHAR(10) CHECK (crisis_severity IN ('low', 'medium', 'high')),
ADD COLUMN crisis_risk_score INTEGER CHECK (crisis_risk_score >= 0 AND crisis_risk_score <= 100),
ADD COLUMN crisis_flagged_at TIMESTAMPTZ,
ADD COLUMN crisis_flagged_by VARCHAR(255),
ADD COLUMN crisis_unflagged_at TIMESTAMPTZ,
ADD COLUMN crisis_unflagged_by VARCHAR(255),
ADD COLUMN monitoring_frequency VARCHAR(20) DEFAULT 'normal' CHECK (monitoring_frequency IN ('normal', 'high', 'critical'));

-- Indexes for crisis queries
CREATE INDEX idx_sessions_crisis_flagged ON therapy_sessions(crisis_flagged) WHERE crisis_flagged = TRUE;
CREATE INDEX idx_sessions_crisis_severity ON therapy_sessions(crisis_severity) WHERE crisis_severity IS NOT NULL;
CREATE INDEX idx_sessions_crisis_risk_score ON therapy_sessions(crisis_risk_score DESC) WHERE crisis_risk_score IS NOT NULL;
CREATE INDEX idx_sessions_crisis_flagged_at ON therapy_sessions(crisis_flagged_at DESC);
CREATE INDEX idx_sessions_monitoring_frequency ON therapy_sessions(monitoring_frequency) WHERE monitoring_frequency != 'normal';

COMMENT ON COLUMN therapy_sessions.crisis_risk_score IS '0-100 risk score from multi-layered detection';
COMMENT ON COLUMN therapy_sessions.monitoring_frequency IS 'Monitoring intensity: normal, high (every message), critical (real-time admin oversight)';

-- ============================================
-- Create crisis_events audit trail table
-- ============================================
CREATE TABLE IF NOT EXISTS crisis_events (
    event_id BIGSERIAL PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES therapy_sessions(session_id) ON DELETE CASCADE,
    event_type VARCHAR(30) NOT NULL CHECK (event_type IN (
      'flagged', 'unflagged', 'severity_changed', 'risk_score_updated',
      'intervention_triggered', 'handoff_initiated', 'clinical_review_requested'
    )),
    severity VARCHAR(10) CHECK (severity IN ('low', 'medium', 'high')),
    previous_severity VARCHAR(10) CHECK (previous_severity IN ('low', 'medium', 'high')),
    risk_score INTEGER CHECK (risk_score >= 0 AND risk_score <= 100),
    previous_risk_score INTEGER,
    triggered_by VARCHAR(255) NOT NULL,
    trigger_method VARCHAR(20) NOT NULL CHECK (trigger_method IN ('auto', 'manual', 'system')),
    message_id BIGINT REFERENCES messages(message_id) ON DELETE SET NULL,
    risk_factors JSONB,
    intervention_details JSONB,
    notes TEXT,
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_crisis_events_session_id ON crisis_events(session_id);
CREATE INDEX idx_crisis_events_created_at ON crisis_events(created_at DESC);
CREATE INDEX idx_crisis_events_event_type ON crisis_events(event_type);
CREATE INDEX idx_crisis_events_risk_score ON crisis_events(risk_score DESC) WHERE risk_score IS NOT NULL;

COMMENT ON TABLE crisis_events IS 'Complete audit trail of all crisis management events and interventions';
COMMENT ON COLUMN crisis_events.risk_factors IS 'JSON object with detection factors: keywords, sentiment, trajectory';
COMMENT ON COLUMN crisis_events.intervention_details IS 'JSON object with intervention type, resources provided, handoff status';

-- ============================================
-- Create intervention_actions table
-- ============================================
CREATE TABLE IF NOT EXISTS intervention_actions (
    action_id BIGSERIAL PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES therapy_sessions(session_id) ON DELETE CASCADE,
    action_type VARCHAR(50) NOT NULL CHECK (action_type IN (
      'low_risk_resources', 'medium_risk_alert', 'high_risk_emergency',
      'supervisor_review', 'clinical_review', 'handoff_initiated',
      'monitoring_increased', 'external_api_called'
    )),
    risk_score INTEGER CHECK (risk_score >= 0 AND risk_score <= 100),
    action_details JSONB NOT NULL,
    performed_by VARCHAR(255) DEFAULT 'system',
    performed_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    outcome VARCHAR(255),
    notes TEXT
);

CREATE INDEX idx_intervention_actions_session_id ON intervention_actions(session_id);
CREATE INDEX idx_intervention_actions_performed_at ON intervention_actions(performed_at DESC);
CREATE INDEX idx_intervention_actions_action_type ON intervention_actions(action_type);

COMMENT ON TABLE intervention_actions IS 'Log of all automated and manual interventions performed';
COMMENT ON COLUMN intervention_actions.action_details IS 'JSON with intervention-specific data (resources shown, alerts sent, etc.)';

-- ============================================
-- Create human_handoffs table
-- ============================================
CREATE TABLE IF NOT EXISTS human_handoffs (
    handoff_id BIGSERIAL PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES therapy_sessions(session_id) ON DELETE CASCADE,
    risk_score INTEGER NOT NULL CHECK (risk_score >= 0 AND risk_score <= 100),
    handoff_type VARCHAR(30) NOT NULL CHECK (handoff_type IN (
      'crisis_hotline', 'clinical_review', 'emergency_services', 'supervisor_escalation'
    )),
    status VARCHAR(20) NOT NULL CHECK (status IN (
      'pending', 'in_progress', 'completed', 'cancelled'
    )) DEFAULT 'pending',
    initiated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    initiated_by VARCHAR(255) DEFAULT 'system',
    assigned_to VARCHAR(255),
    completed_at TIMESTAMPTZ,
    outcome TEXT,
    external_reference VARCHAR(255),
    notes TEXT
);

CREATE INDEX idx_human_handoffs_session_id ON human_handoffs(session_id);
CREATE INDEX idx_human_handoffs_status ON human_handoffs(status);
CREATE INDEX idx_human_handoffs_initiated_at ON human_handoffs(initiated_at DESC);
CREATE INDEX idx_human_handoffs_risk_score ON human_handoffs(risk_score DESC);

COMMENT ON TABLE human_handoffs IS 'Track handoffs to human clinicians, crisis hotlines, emergency services';
COMMENT ON COLUMN human_handoffs.external_reference IS 'Reference number from external crisis service API (if applicable)';

-- ============================================
-- Create clinical_reviews table
-- ============================================
CREATE TABLE IF NOT EXISTS clinical_reviews (
    review_id BIGSERIAL PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES therapy_sessions(session_id) ON DELETE CASCADE,
    risk_score INTEGER CHECK (risk_score >= 0 AND risk_score <= 100),
    review_reason VARCHAR(255) NOT NULL,
    review_type VARCHAR(30) NOT NULL CHECK (review_type IN (
      'post_crisis', 'quality_assurance', 'compliance_audit', 'therapeutic_oversight'
    )),
    status VARCHAR(20) NOT NULL CHECK (status IN (
      'pending', 'in_progress', 'completed'
    )) DEFAULT 'pending',
    requested_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    requested_by VARCHAR(255) DEFAULT 'system',
    assigned_to VARCHAR(255),
    reviewed_at TIMESTAMPTZ,
    review_findings TEXT,
    recommendations TEXT,
    compliance_status VARCHAR(20) CHECK (compliance_status IN ('compliant', 'non_compliant', 'needs_followup'))
);

CREATE INDEX idx_clinical_reviews_session_id ON clinical_reviews(session_id);
CREATE INDEX idx_clinical_reviews_status ON clinical_reviews(status);
CREATE INDEX idx_clinical_reviews_requested_at ON clinical_reviews(requested_at DESC);

COMMENT ON TABLE clinical_reviews IS 'Clinical oversight and post-incident reviews for crisis sessions';

-- ============================================
-- Create risk_score_history table (trajectory tracking)
-- ============================================
CREATE TABLE IF NOT EXISTS risk_score_history (
    history_id BIGSERIAL PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES therapy_sessions(session_id) ON DELETE CASCADE,
    message_id BIGINT REFERENCES messages(message_id) ON DELETE SET NULL,
    risk_score INTEGER NOT NULL CHECK (risk_score >= 0 AND risk_score <= 100),
    severity VARCHAR(10) CHECK (severity IN ('low', 'medium', 'high')),
    score_factors JSONB NOT NULL,
    calculated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_risk_score_history_session_id ON risk_score_history(session_id);
CREATE INDEX idx_risk_score_history_calculated_at ON risk_score_history(calculated_at DESC);
CREATE INDEX idx_risk_score_history_risk_score ON risk_score_history(risk_score DESC);

COMMENT ON TABLE risk_score_history IS 'Tracks risk score changes over time for emotional trajectory analysis';
COMMENT ON COLUMN risk_score_history.score_factors IS 'JSON breakdown: keyword_score, sentiment_score, context_score, trajectory_score';

COMMIT;
```

---

### 2. Multi-Layered Crisis Detection Service

**File:** `src/server/services/crisisDetection.service.js` (NEW)

Comprehensive risk assessment service combining multiple detection layers:

#### A. Clinical Keyword Detection (Layer 1)

**Explicit Crisis Keywords (High Risk +40-60 points):**
- Suicidal ideation: "suicide", "kill myself", "end my life", "want to die", "better off dead"
- Self-harm: "self-harm", "cut myself", "hurt myself", "cutting", "burning myself"
- Substance crisis: "overdose", "pills", "drunk and driving"
- Violence: "shooting", "gun", "kill someone", "hurt others"
- Abuse/trauma: "being abused", "rape", "sexual assault", "domestic violence"

**Moderate Risk Keywords (Medium Risk +20-40 points):**
- Depression indicators: "severe depression", "hopeless", "worthless", "no point living", "can't go on"
- Anxiety crisis: "severe anxiety", "panic attack", "can't breathe", "losing control"
- Substance abuse: "addiction", "substance abuse", "drinking too much", "drug problem"
- Self-destructive: "self-destructive", "reckless behavior", "don't care anymore"

**Low Risk Keywords (Low Risk +10-20 points):**
- Stress: "stressed", "overwhelmed", "burned out", "exhausted"
- General anxiety: "anxious", "worried", "nervous", "can't sleep", "insomnia"
- Relationship: "relationship problems", "family issues", "breakup", "lonely"

#### B. Sentiment Analysis (Layer 2)

**Negative Sentiment Scoring:**
- Analyze message sentiment using weighted emotional lexicon
- Track sentiment trends over conversation (improving vs. deteriorating)
- Score: -100 (extremely negative) to +100 (extremely positive)
- Risk contribution: `Math.max(0, -sentiment) * 0.3` (max +30 points for very negative)

**Emotional Markers Tracked:**
- Hopelessness indicators: "nothing helps", "tried everything", "no way out"
- Detachment: "don't feel anything", "numb", "disconnected", "floating"
- Urgency: "right now", "tonight", "can't wait", "immediately"
- Finality: "goodbye", "last time", "final decision", "done"

#### C. Contextual Risk Scoring (Layer 3)

**Conversation History Analysis:**
- Message frequency: Rapid messaging = escalation (+5-10 points)
- Topic persistence: Repeatedly returning to crisis themes (+10-15 points)
- Rejection of help: Dismissing coping strategies (+15-20 points)
- Isolation mentions: "alone", "no one cares", "nobody understands" (+5-10 points)

**Emotional Trajectory Tracking:**
- Monitor emotional state across last 10 messages
- Detect downward spiral: Each consecutive negative message +5 points
- Sudden shifts: Calm → distressed within 3 messages +15 points
- Persistent negativity: 5+ consecutive negative messages +20 points

#### D. Risk Score Calculation

**Total Risk Score (0-100):**
```javascript
riskScore =
  keywordScore +           // 0-60 points
  sentimentScore +         // 0-30 points
  conversationScore +      // 0-30 points
  trajectoryScore +        // 0-20 points
  manualAdjustment         // ±20 points (admin override)

// Cap at 0-100
riskScore = Math.max(0, Math.min(100, riskScore));
```

**Severity Mapping:**
- **Low (0-30)**: General distress, non-urgent
- **Medium (31-70)**: Concerning patterns, needs monitoring
- **High (71-100)**: Immediate risk, urgent intervention

#### E. Key Functions

**Core Detection:**
- `analyzeMessageRisk(message, conversationHistory)` - Multi-layer analysis, return { riskScore, severity, factors }
- `detectCrisisKeywords(content)` - Layer 1: Clinical keywords
- `analyzeSentiment(content)` - Layer 2: Emotional tone
- `assessConversationContext(sessionId, messageHistory)` - Layer 3: Contextual risk
- `trackEmotionalTrajectory(sessionId)` - Layer 4: Trend analysis

**Database Operations:**
- `flagSessionCrisis(sessionId, severity, riskScore, triggeredBy, triggerMethod, messageId, factors, notes)`
- `unflagSessionCrisis(sessionId, unflaggedBy, notes)`
- `updateRiskScore(sessionId, newScore, newSeverity, changedBy, notes)`
- `getSessionRiskHistory(sessionId)` - Track risk score over time

**Audit & Reporting:**
- `getSessionCrisisEvents(sessionId)` - Full audit trail
- `getActiveCrisisSessions()` - All flagged sessions
- `getHighRiskTrends()` - Analytics for common triggers
- `logInterventionAction(sessionId, actionType, details)` - Record all interventions

---

### 3. Integrate Multi-Layered Risk Analysis into Message Pipeline

**File:** `src/server/index.js`

**Location:** Lines 1143-1261 (POST /logs/batch endpoint)

After `insertMessagesBatch` (around line 1223), add comprehensive risk analysis:

```javascript
// ========== MULTI-LAYERED CRISIS DETECTION ==========
const { analyzeMessageRisk, flagSessionCrisis, logInterventionAction } = await import('./services/crisisDetection.service.js');

for (const msg of insertedMessages) {
  // Analyze risk for user and assistant messages
  if (msg.role === 'user' || msg.role === 'assistant') {
    // Get conversation history (last 10 messages)
    const historyResult = await pool.query(
      `SELECT * FROM messages
       WHERE session_id = $1
       ORDER BY created_at DESC
       LIMIT 10`,
      [msg.session_id]
    );

    const conversationHistory = historyResult.rows.reverse(); // Chronological order

    // Perform multi-layered risk analysis
    const riskAnalysis = await analyzeMessageRisk(msg, conversationHistory);

    if (riskAnalysis.riskScore > 0) {
      console.log(`📊 Risk detected in session ${msg.session_id}:
        Score=${riskAnalysis.riskScore},
        Severity=${riskAnalysis.severity},
        Factors=${JSON.stringify(riskAnalysis.factors)}`);

      // Check current session state
      const sessionCheck = await pool.query(
        `SELECT crisis_flagged, crisis_severity, crisis_risk_score
         FROM therapy_sessions
         WHERE session_id = $1`,
        [msg.session_id]
      );

      const session = sessionCheck.rows[0];
      const currentScore = session?.crisis_risk_score || 0;

      // Flag if score exceeds threshold (>30) or increases significantly
      const shouldFlag = riskAnalysis.riskScore > 30 &&
        (!session.crisis_flagged || riskAnalysis.riskScore > currentScore + 10);

      if (shouldFlag) {
        // Flag session with risk score and factors
        await flagSessionCrisis(
          msg.session_id,
          riskAnalysis.severity,
          riskAnalysis.riskScore,
          'system',
          'auto',
          msg.message_id,
          riskAnalysis.factors,
          `Risk score: ${riskAnalysis.riskScore} - Factors: ${riskAnalysis.factors.join(', ')}`
        );

        // Log intervention triggered
        await logInterventionAction(msg.session_id, 'auto_flag', {
          riskScore: riskAnalysis.riskScore,
          severity: riskAnalysis.severity,
          messageId: msg.message_id,
          factors: riskAnalysis.factors
        });

        // Emit real-time alert to admins
        global.io.to('admin-broadcast').emit('session:crisis-detected', {
          sessionId: msg.session_id,
          severity: riskAnalysis.severity,
          riskScore: riskAnalysis.riskScore,
          factors: riskAnalysis.factors,
          messageId: msg.message_id,
          detectedAt: new Date(),
          message: `${riskAnalysis.severity.toUpperCase()} risk detected (score: ${riskAnalysis.riskScore})`
        });

        // Execute graduated response based on severity
        await executeGraduatedResponse(msg.session_id, riskAnalysis.severity, riskAnalysis.riskScore);

        console.log(`Session ${msg.session_id} flagged as ${riskAnalysis.severity} risk (score: ${riskAnalysis.riskScore})`);
      }
    }
  }
}
// ========== END CRISIS DETECTION ==========
```

---

### 4. Graduated Response System & Crisis Intervention Protocols

**File:** `src/server/services/crisisIntervention.service.js` (NEW)

Implement automated intervention responses based on risk severity:

#### A. Low Risk (0-30) - Self-Help Resources

**Intervention Actions:**
```javascript
async function executeLowRiskResponse(sessionId, riskScore) {
  // 1. Log intervention
  await logInterventionAction(sessionId, 'low_risk_resources', {
    riskScore,
    resourcesProvided: ['coping_strategies', 'relaxation_techniques']
  });

  // 2. Send self-help resources message to session
  const resources = {
    role: 'system',
    message_type: 'crisis_intervention',
    content: `I notice you're experiencing some distress. Here are some immediate coping strategies:

**Grounding Technique (5-4-3-2-1):**
- 5 things you can see
- 4 things you can touch
- 3 things you can hear
- 2 things you can smell
- 1 thing you can taste

**Deep Breathing:**
Box breathing: Inhale 4 seconds → Hold 4 seconds → Exhale 4 seconds → Hold 4 seconds. Repeat 4 times.

**Progressive Muscle Relaxation:**
Tense and release muscle groups, starting from toes to head.

If you continue to feel distressed, I'm here to talk. Would you like to discuss what's troubling you?`,
    metadata: {
      intervention_type: 'low_risk_self_help',
      risk_score: riskScore
    }
  };

  // Insert into messages table and emit to client
  await insertInterventionMessage(sessionId, resources);
  global.io.to(`session:${sessionId}`).emit('messages:new', [resources]);
}
```

#### B. Medium Risk (31-70) - Supervisor Review + Enhanced Monitoring

**Intervention Actions:**
```javascript
async function executeMediumRiskResponse(sessionId, riskScore) {
  // 1. Alert supervisors for review
  await logInterventionAction(sessionId, 'medium_risk_alert', {
    riskScore,
    alertsSent: ['supervisor_review', 'increased_monitoring']
  });

  // 2. Emit alert to supervisors (therapists + researchers)
  global.io.to('admin-broadcast').emit('session:supervisor-review-required', {
    sessionId,
    severity: 'medium',
    riskScore,
    priority: 'high',
    message: `Session requires supervisor review - Risk score: ${riskScore}`,
    requiredAt: new Date()
  });

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

If you're comfortable, let's work through this together. Would you like to talk about what brought this on?`,
    metadata: {
      intervention_type: 'medium_risk_therapeutic_checkin',
      risk_score: riskScore
    }
  };

  await insertInterventionMessage(sessionId, checkIn);
  global.io.to(`session:${sessionId}`).emit('messages:new', [checkIn]);

  // 4. Increase monitoring frequency
  await updateMonitoringFrequency(sessionId, 'high'); // Real-time monitoring every message
}
```

#### C. High Risk (71-100) - Emergency Hotline + Human Handoff

**Intervention Actions:**
```javascript
async function executeHighRiskResponse(sessionId, riskScore) {
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
      emergency: true
    }
  };

  await insertInterventionMessage(sessionId, emergencyMessage);
  global.io.to(`session:${sessionId}`).emit('messages:new', [emergencyMessage]);
  global.io.to(`session:${sessionId}`).emit('session:crisis-emergency', {
    severity: 'high',
    riskScore,
    hotlines: {
      primary: { name: '988 Lifeline', number: '988' },
      text: { name: 'Crisis Text Line', code: 'HOME to 741741' },
      emergency: { name: 'Emergency', number: '911' }
    }
  });

  // 3. Initiate human handoff workflow
  await initiateHumanHandoff(sessionId, riskScore);

  // 4. Send urgent alert to all admins
  global.io.to('admin-broadcast').emit('session:crisis-emergency', {
    sessionId,
    severity: 'high',
    riskScore,
    priority: 'critical',
    message: `🚨 CRITICAL: High-risk crisis detected - Immediate attention required`,
    emergencyAt: new Date(),
    requiresImmediate Intervention: true
  });

  // 5. AI response guidance: Validate, stabilize, build trust
  const interventionPrompt = {
    role: 'system',
    message_type: 'ai_guidance',
    content: `CRISIS INTERVENTION PROTOCOL ACTIVATED:
1. VALIDATE: Acknowledge their pain without judgment
2. STABILIZE: Use calming, supportive language
3. BUILD TRUST: Express genuine care and concern
4. GROUND: Guide them through grounding techniques
5. CLARIFY: Understand immediate crisis context
6. SAFETY: Assess immediate danger, encourage professional help
7. CONNECT: Emphasize support resources and human connection

IMPORTANT: Do NOT minimize their feelings. Show empathy and encourage them to reach out to crisis resources immediately.`,
    metadata: {
      ai_protocol: 'crisis_intervention_sequence',
      risk_score: riskScore
    }
  };

  // Send AI guidance (invisible to user, guides AI behavior)
  await insertInterventionMessage(sessionId, interventionPrompt, true); // Hidden from user
}
```

#### D. Crisis Intervention Sequence

**7-Step Protocol (Applied in High-Risk Situations):**

1. **Validation and Acknowledgment:**
   ```
   "I hear how much pain you're in right now, and I want you to know that your feelings are valid."
   ```

2. **Emotional Stabilization:**
   ```
   "Let's take this one moment at a time. You're safe right now, and you're not alone."
   ```

3. **Trust Building:**
   ```
   "I'm here to support you, and I care about your wellbeing. Would it be okay if we work through this together?"
   ```

4. **Grounding Techniques:**
   ```
   "Let's try a grounding exercise to help you feel more present. Can you name 5 things you see around you right now?"
   ```

5. **Crisis Context Clarification:**
   ```
   "Can you tell me what's happening right now that's most overwhelming? Understanding your situation helps me support you better."
   ```

6. **Co-Develop Coping Plan:**
   ```
   "What has helped you cope with difficult feelings in the past? Let's identify some strategies that might help right now."
   ```

7. **Safety Commitment Prompts:**
   ```
   "Can you commit to reaching out to someone you trust or calling a crisis hotline if these feelings intensify? Your safety is the priority."
   ```

#### E. Main Graduated Response Function

```javascript
async function executeGraduatedResponse(sessionId, severity, riskScore) {
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
}

// Helper to insert intervention messages
async function insertInterventionMessage(sessionId, messageData, hiddenFromUser = false) {
  const messageRecord = {
    session_id: sessionId,
    role: messageData.role,
    message_type: messageData.message_type,
    content: messageData.content,
    content_redacted: messageData.content, // No redaction for system messages
    metadata: {
      ...messageData.metadata,
      hidden_from_user: hiddenFromUser,
      intervention_timestamp: new Date()
    }
  };

  const result = await pool.query(
    `INSERT INTO messages (session_id, role, message_type, content, content_redacted, metadata, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, CURRENT_TIMESTAMP)
     RETURNING *`,
    [messageRecord.session_id, messageRecord.role, messageRecord.message_type,
     messageRecord.content, messageRecord.content_redacted, JSON.stringify(messageRecord.metadata)]
  );

  return result.rows[0];
}
```

---

### 5. Human Handoff & External Integration

**File:** `src/server/services/humanHandoff.service.js` (NEW)

Automated handoff to crisis hotlines and human clinicians:

#### A. Handoff Workflow

**Initiate Handoff:**
```javascript
async function initiateHumanHandoff(sessionId, riskScore) {
  // 1. Create handoff record
  const handoffRecord = await pool.query(
    `INSERT INTO human_handoffs
     (session_id, risk_score, status, initiated_at, handoff_type)
     VALUES ($1, $2, 'pending', CURRENT_TIMESTAMP, 'crisis_hotline')
     RETURNING *`,
    [sessionId, riskScore]
  );

  // 2. Notify admins to facilitate handoff
  global.io.to('admin-broadcast').emit('session:handoff-required', {
    sessionId,
    riskScore,
    handoffId: handoffRecord.rows[0].handoff_id,
    message: 'Human handoff initiated - Admin action required'
  });

  // 3. Log intervention action
  await logInterventionAction(sessionId, 'handoff_initiated', {
    handoffId: handoffRecord.rows[0].handoff_id,
    riskScore
  });

  // 4. Optional: Trigger external API/webhook (future enhancement)
  // await triggerExternalHandoffAPI(sessionId, riskScore);

  return handoffRecord.rows[0];
}
```

#### B. External API Integration (Future Enhancement)

**Crisis Hotline API Integration:**
```javascript
// Placeholder for future integration with crisis services
async function triggerExternalHandoffAPI(sessionId, riskScore) {
  // Example: Crisis Text Line API, 988 Lifeline API
  try {
    const response = await fetch('https://api.crisisservice.org/referral', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.CRISIS_API_KEY}`
      },
      body: JSON.stringify({
        sessionId,
        riskLevel: riskScore,
        timestamp: new Date(),
        urgency: riskScore > 70 ? 'critical' : 'high'
      })
    });

    if (response.ok) {
      const data = await response.json();
      await logInterventionAction(sessionId, 'external_api_notified', {
        apiResponse: data,
        provider: 'crisis_hotline_api'
      });
    }
  } catch (err) {
    console.error('Failed to trigger external API:', err);
    // Fallback: Continue with internal handoff process
  }
}
```

#### C. Clinical Oversight & Review

**Therapeutic Evaluator Review:**
```javascript
async function flagForClinicalReview(sessionId, riskScore, reviewReason) {
  await pool.query(
    `INSERT INTO clinical_reviews
     (session_id, risk_score, review_reason, status, requested_at)
     VALUES ($1, $2, $3, 'pending', CURRENT_TIMESTAMP)`,
    [sessionId, riskScore, reviewReason]
  );

  // Notify researchers/therapists
  global.io.to('admin-broadcast').emit('session:clinical-review-required', {
    sessionId,
    riskScore,
    reviewReason,
    priority: riskScore > 70 ? 'critical' : 'high'
  });
}
```

---

### 6. Crisis Management API Endpoints

**File:** `src/server/index.js`

**Location:** After line 1806 (after existing admin routes)

Add four new endpoints:

1. **POST /admin/api/sessions/:sessionId/crisis/flag** - Manual flag with severity + notes
2. **DELETE /admin/api/sessions/:sessionId/crisis/flag** - Unflag crisis
3. **GET /admin/api/crisis/events** - Get audit trail (all or by sessionId)
4. **GET /admin/api/crisis/active** - Get all active crisis sessions

All require `requireRole('therapist', 'researcher')` authentication.

Each endpoint emits corresponding Socket.io event to `admin-broadcast` room.

---

### 5. Update Active Sessions Query

**File:** `src/server/index.js`

**Location:** Lines 1265-1292 (GET /admin/api/sessions/active)

Modify query to include crisis fields:

```sql
SELECT
  ts.session_id,
  ts.user_id,
  ts.session_name,
  u.username,
  ts.status,
  ts.created_at,
  ts.crisis_flagged,
  ts.crisis_severity,
  ts.crisis_flagged_at,
  ts.crisis_flagged_by,
  COUNT(m.message_id) as message_count,
  MAX(m.created_at) as last_activity,
  EXTRACT(EPOCH FROM (CURRENT_TIMESTAMP - ts.created_at)) as duration_seconds
FROM therapy_sessions ts
LEFT JOIN users u ON ts.user_id = u.userid
LEFT JOIN messages m ON ts.session_id = m.session_id
WHERE ts.status = 'active'
GROUP BY ts.session_id, u.username
ORDER BY ts.crisis_flagged DESC, ts.created_at DESC
```

---

### 6. LiveMonitoring Component Enhancements

**File:** `src/client/admin/components/LiveMonitoring.jsx`

**Major Changes:**

1. **Add State:**
   - `showCrisisOnly` - Filter toggle
   - `crisisAlert` - Alert banner data
   - `browserNotificationsEnabled` - Permission status

2. **Request Browser Notifications:**
   ```javascript
   useEffect(() => {
     if ('Notification' in window && Notification.permission === 'default') {
       Notification.requestPermission().then(permission => {
         setBrowserNotificationsEnabled(permission === 'granted');
       });
     }
   }, []);
   ```

3. **Socket.io Event Listeners:**
   - `session:crisis-detected` - Auto-detection triggered
   - `session:crisis-flagged` - Manual flag by admin
   - `session:crisis-unflagged` - Crisis resolved

4. **Crisis Event Handlers:**
   - Update session in state
   - Show alert banner (auto-dismiss after 30s for auto-detect, 15s for manual)
   - Trigger browser notification (if permission granted)

5. **UI Additions:**
   - **Crisis Alert Banner** - Red/yellow/orange based on severity, with "View Session" and "Dismiss" buttons
   - **Crisis Filter Toggle** - "Crisis Only" button to filter sessions
   - **Crisis Count Stats Card** - Fourth stats card showing flagged session count
   - **Crisis Column in Table** - New column with severity badge
   - **Row Highlighting** - Red left border for crisis sessions
   - **Crisis Badge Helper Functions**:
     ```javascript
     const getCrisisBadge = (severity) => {
       const badges = {
         high: 'bg-red-600 text-white animate-pulse',
         medium: 'bg-yellow-500 text-yellow-900',
         low: 'bg-orange-400 text-orange-900'
       };
       return badges[severity];
     };
     ```

6. **Filtered Display:**
   ```javascript
   const displayedSessions = showCrisisOnly
     ? activeSessions.filter(s => s.crisis_flagged)
     : activeSessions;
   ```

---

### 7. SessionDetail Component Enhancements

**File:** `src/client/admin/components/SessionDetail.jsx`

**Major Changes:**

1. **Add State:**
   - `showFlagModal` - Flag modal visibility
   - `flagSeverity` - Selected severity (default: 'medium')
   - `flagNotes` - Optional notes
   - `flagging` - Loading state

2. **Flag/Unflag Handlers:**
   - `handleFlagCrisis()` - POST to `/admin/api/sessions/:sessionId/crisis/flag`
   - `handleUnflagCrisis()` - DELETE with confirmation dialog

3. **UI Additions:**
   - **Crisis Badge in Header** - Pulsing badge next to session name (red/yellow/orange)
   - **Crisis Metadata Display** - Show severity, flagged by, flagged at
   - **Flag/Unflag Button** - Toggle between "Flag Crisis" and "Unflag Crisis"
   - **Flag Modal** - Severity dropdown + notes textarea + confirm/cancel buttons

4. **Flag Modal UI:**
   ```jsx
   {showFlagModal && (
     <div className="fixed inset-0 bg-black bg-opacity-70 flex items-center justify-center z-50">
       <div className="bg-white p-6 rounded-lg shadow-xl max-w-md w-full">
         <h3>Flag Session as Crisis</h3>
         <select value={flagSeverity} onChange={(e) => setFlagSeverity(e.target.value)}>
           <option value="low">Low - General concern</option>
           <option value="medium">Medium - Moderate risk</option>
           <option value="high">High - Immediate attention required</option>
         </select>
         <textarea value={flagNotes} onChange={(e) => setFlagNotes(e.target.value)}
                   placeholder="Add any relevant notes..." />
         <button onClick={handleFlagCrisis}>Flag Crisis</button>
         <button onClick={() => setShowFlagModal(false)}>Cancel</button>
       </div>
     </div>
   )}
   ```

5. **Message Highlighting** (future enhancement):
   - Pass `isCrisisTrigger` prop to ConversationBubble for messages that triggered auto-detection
   - Show red border + "🚨 Crisis Trigger" badge on those messages

---

## Socket.io Events

### Emitted by Server:

1. **session:crisis-detected** (auto-detection)
   ```javascript
   {
     sessionId: string,
     severity: 'low' | 'medium' | 'high',
     keywords: string[],
     messageId: number,
     detectedAt: Date,
     message: string
   }
   ```

2. **session:crisis-flagged** (manual flag)
   ```javascript
   {
     sessionId: string,
     severity: 'low' | 'medium' | 'high',
     flaggedBy: string,
     flaggedAt: Date,
     message: string
   }
   ```

3. **session:crisis-unflagged**
   ```javascript
   {
     sessionId: string,
     unflaggedBy: string,
     unflaggedAt: Date,
     message: string
   }
   ```

All events sent to `admin-broadcast` room for real-time admin updates.

---

## Testing Checklist

**Database:**
- [ ] Migration runs successfully
- [ ] Rollback works
- [ ] Indexes created correctly
- [ ] Constraints enforced (severity values, event_type values)

**Automatic Detection:**
- [ ] High-severity keywords trigger flag (suicide, self-harm)
- [ ] Medium-severity keywords trigger flag (depressed, hopeless)
- [ ] Low-severity keywords trigger flag (stressed, anxious)
- [ ] Higher severity overrides lower severity
- [ ] crisis_events audit record created
- [ ] Socket.io event emitted
- [ ] Browser notification appears (if permission granted)
- [ ] Alert banner displays in LiveMonitoring

**Manual Flagging:**
- [ ] Flag button opens modal
- [ ] All severity levels selectable
- [ ] Notes field optional
- [ ] Flag saves to database
- [ ] Socket.io event emitted
- [ ] LiveMonitoring updates in real-time
- [ ] Session appears in SessionDetail with badge

**Unflagging:**
- [ ] Unflag button shows confirmation
- [ ] Unflag updates database
- [ ] Socket.io event emitted
- [ ] UI updates remove crisis indicators

**UI Visual Indicators:**
- [ ] Crisis badge colors correct (red=high, yellow=medium, orange=low)
- [ ] Pulse animation on high severity
- [ ] Crisis column in LiveMonitoring table
- [ ] Red left border on crisis rows
- [ ] Crisis filter toggle works
- [ ] Crisis count in stats card accurate
- [ ] Alert banner auto-dismisses
- [ ] Browser notification permission requested

**API Endpoints:**
- [ ] POST /admin/api/sessions/:sessionId/crisis/flag validates severity
- [ ] POST returns 404 for non-existent session
- [ ] DELETE /admin/api/sessions/:sessionId/crisis/flag works
- [ ] GET /admin/api/crisis/events returns audit trail
- [ ] GET /admin/api/crisis/active returns flagged sessions only

**Edge Cases:**
- [ ] Multiple keywords in one message
- [ ] Session ends while flagged (metadata preserved)
- [ ] Concurrent flag/unflag operations handled
- [ ] Invalid severity returns 400 error
- [ ] Browser notification permission denied (graceful fallback)
- [ ] Partial word matches don't trigger (word boundary matching)

---

## Critical Files

**New Files:**
1. `src/database/migrations/011_add_crisis_flagging.sql` - Migration
2. `src/server/services/crisisDetection.service.js` - Crisis detection logic

**Modified Files:**
1. `src/server/index.js` - Lines 1223 (crisis detection), after 1806 (API endpoints), lines 1265-1292 (active sessions query)
2. `src/client/admin/components/LiveMonitoring.jsx` - State, handlers, UI enhancements
3. `src/client/admin/components/SessionDetail.jsx` - Flag modal, UI badges

---

## Key Design Decisions

1. **Keyword Matching**: Regex with word boundaries to avoid false positives
2. **Severity Escalation**: Higher severity auto-flags override lower severity
3. **Audit Trail**: Complete history in crisis_events table
4. **Real-time Updates**: Socket.io for instant admin notification
5. **Browser Notifications**: Optional, requires permission, high severity uses `requireInteraction: true`
6. **UI Integration**: No separate tab, integrated into existing LiveMonitoring
7. **Transaction Safety**: Database transactions for flag/unflag operations
8. **Performance**: Partial indexes only on flagged sessions, minimal query overhead

---

---

### 10. Continuous Improvement & Safety Safeguards

**File:** `src/server/services/continuousImprovement.service.js` (NEW)

#### A. Post-Incident Reviews

**Automated Review Triggers:**
```javascript
async function triggerPostIncidentReview(sessionId, riskScore, outcome) {
  // Create clinical review request for high-risk sessions
  await pool.query(
    `INSERT INTO clinical_reviews
     (session_id, risk_score, review_reason, review_type, requested_by)
     VALUES ($1, $2, $3, 'post_crisis', 'system')`,
    [sessionId, riskScore, `Post-crisis review: Risk score ${riskScore}, Outcome: ${outcome}`]
  );

  // Notify therapeutic evaluators
  global.io.to('admin-broadcast').emit('clinical-review:post-incident', {
    sessionId,
    riskScore,
    outcome,
    reviewDueDate: new Date(Date.now() + 48 * 60 * 60 * 1000) // 48 hours
  });
}
```

**Review Documentation:**
- Session transcript
- Risk score trajectory (time-series chart)
- Interventions performed and timing
- Participant outcome (if known)
- Areas for improvement
- Recommendations for similar future cases

#### B. Iterative Testing & Feedback Loops

**Keyword Effectiveness Analysis:**
```javascript
async function analyzeKeywordEffectiveness() {
  // Query false positive/negative rates
  const result = await pool.query(`
    SELECT
      ce.risk_factors->>'keywords_matched' as keywords,
      COUNT(*) as trigger_count,
      AVG(CASE WHEN hr.outcome = 'resolved_safely' THEN 1 ELSE 0 END) as accuracy_rate
    FROM crisis_events ce
    LEFT JOIN human_handoffs hr ON ce.session_id = hr.session_id
    WHERE ce.trigger_method = 'auto'
    GROUP BY keywords
    HAVING COUNT(*) > 5
    ORDER BY accuracy_rate ASC
  `);

  // Identify low-performing keywords for review
  return result.rows.filter(row => row.accuracy_rate < 0.7);
}
```

**A/B Testing Crisis Intervention Messages:**
- Test different grounding technique instructions
- Measure effectiveness: Did participant calm down (sentiment analysis post-intervention)?
- Track which coping strategies users engage with most
- Refine messaging based on real-world data

#### C. Boundary Safeguards

**Role Confusion Prevention:**
```javascript
// System prompt additions to prevent AI from overstepping
const BOUNDARY_SAFEGUARDS = `
CRITICAL BOUNDARIES:
1. You are an AI assistant, NOT a licensed therapist or clinician
2. You CANNOT diagnose mental health conditions
3. You CANNOT prescribe medication or treatment plans
4. You MUST refer to professional help for crisis situations
5. You are here to provide SUPPORT and RESOURCES, not clinical treatment

SCOPE LIMITATIONS:
- DO: Provide emotional support, active listening, coping strategies
- DO NOT: Give clinical advice, diagnose, prescribe, or replace professional care
- ALWAYS: Encourage professional help for serious mental health concerns
- ALWAYS: Provide crisis hotline numbers when detecting high risk

TRANSPARENCY:
- Remind users you are an AI when appropriate
- Clarify your limitations proactively
- Never claim therapeutic authority you don't have
`;

// Include in every high-risk session
async function injectBoundarySafeguards(sessionId) {
  const systemMessage = {
    role: 'system',
    message_type: 'ai_guidance',
    content: BOUNDARY_SAFEGUARDS,
    metadata: { safeguard_type: 'role_clarity', hidden_from_user: true }
  };

  await insertInterventionMessage(sessionId, systemMessage, true);
}
```

**Scope Creep Prevention:**
- Automatic alerts if AI makes clinical claims (keyword scan: "I diagnose", "you have", "prescribe")
- Flag sessions where AI gives medical advice for review
- Regular audits of AI responses by clinical evaluators

#### D. Compliance & Legal Documentation

**Audit Trail Completeness:**
- Every crisis flag logged with timestamps
- All interventions documented with outcomes
- Handoff attempts recorded
- Clinical review results stored
- Participant consent for data review (if required by IRB)

**Data Retention & Privacy:**
- Crisis data retained for minimum required period (7 years per healthcare standards)
- PHI redaction for non-clinical reviewers
- Access logs for all crisis data views
- Encryption at rest and in transit

**Compliance Checks:**
```javascript
async function runComplianceAudit(startDate, endDate) {
  // Verify all high-risk sessions have documentation
  const result = await pool.query(`
    SELECT
      ts.session_id,
      ts.crisis_risk_score,
      COUNT(ia.action_id) as intervention_count,
      COUNT(hh.handoff_id) as handoff_count,
      COUNT(cr.review_id) as review_count
    FROM therapy_sessions ts
    LEFT JOIN intervention_actions ia ON ts.session_id = ia.session_id
    LEFT JOIN human_handoffs hh ON ts.session_id = hh.session_id
    LEFT JOIN clinical_reviews cr ON ts.session_id = cr.session_id
    WHERE ts.crisis_flagged = TRUE
      AND ts.crisis_risk_score >= 70
      AND ts.created_at BETWEEN $1 AND $2
    GROUP BY ts.session_id, ts.crisis_risk_score
    HAVING COUNT(ia.action_id) = 0 OR COUNT(cr.review_id) = 0
  `, [startDate, endDate]);

  // Flag sessions with missing documentation
  return result.rows.map(row => ({
    sessionId: row.session_id,
    riskScore: row.crisis_risk_score,
    missingInterventions: row.intervention_count === 0,
    missingReview: row.review_count === 0,
    complianceStatus: 'non_compliant'
  }));
}
```

---

## Implementation Order

**Phase 1: Foundation (Database & Core Services)**
1. Database migration (011_add_crisis_management.sql)
2. Multi-layered crisis detection service (crisisDetection.service.js)
3. Crisis intervention service (crisisIntervention.service.js)
4. Human handoff service (humanHandoff.service.js)

**Phase 2: Integration (Message Pipeline & APIs)**
5. Integrate risk analysis into message pipeline (index.js /logs/batch)
6. Crisis management API endpoints (index.js)
7. Update active sessions query to include risk scores (index.js)

**Phase 3: UI & Real-Time Features**
8. LiveMonitoring UI enhancements (risk score display, crisis filter, alert banner)
9. SessionDetail UI enhancements (flag modal, risk indicators, intervention history)
10. Socket.io events for real-time alerts (crisis-detected, supervisor-review-required, crisis-emergency)

**Phase 4: Safety & Continuous Improvement**
11. Continuous improvement service (post-incident reviews, A/B testing framework)
12. Boundary safeguards implementation (scope prevention, compliance checks)
13. Clinical review workflow (admin interface for therapeutic evaluators)

**Phase 5: Testing & Refinement**
14. Comprehensive testing (automated detection, graduated responses, handoffs)
15. Clinical evaluator review of system outputs
16. User feedback collection and iteration
17. Compliance audit and documentation verification

---

## Critical Files Summary

**New Files (7 total):**
1. `src/database/migrations/011_add_crisis_management.sql` - Comprehensive schema (5 new tables)
2. `src/server/services/crisisDetection.service.js` - Multi-layered risk analysis
3. `src/server/services/crisisIntervention.service.js` - Graduated response protocols
4. `src/server/services/humanHandoff.service.js` - Handoff workflows and external APIs
5. `src/server/services/continuousImprovement.service.js` - Post-incident reviews and safeguards
6. `src/server/services/sentimentAnalysis.service.js` - Emotional tone analysis (Layer 2)
7. `src/server/services/trajectoryTracking.service.js` - Emotional trajectory over time (Layer 4)

**Modified Files (3 total):**
1. `src/server/index.js` - Integrate risk analysis in /logs/batch, add crisis API endpoints, update active sessions query
2. `src/client/admin/components/LiveMonitoring.jsx` - Risk scores, crisis filter, alert banners, browser notifications
3. `src/client/admin/components/SessionDetail.jsx` - Risk indicators, flag modal, intervention history display

**Database Tables Created:**
1. `crisis_events` - Audit trail of all crisis events
2. `intervention_actions` - Log of automated and manual interventions
3. `human_handoffs` - Track handoffs to clinicians and crisis services
4. `clinical_reviews` - Post-incident reviews and compliance audits
5. `risk_score_history` - Time-series risk scores for trajectory analysis

---

## Success Metrics

**Detection Performance:**
- False positive rate < 10% (flagged but not actually in crisis)
- False negative rate < 2% (missed actual crisis situations)
- Average detection time < 30 seconds from triggering message

**Intervention Effectiveness:**
- Low-risk: 80% of participants engage with self-help resources
- Medium-risk: 100% of supervisor reviews completed within 2 hours
- High-risk: 100% receive emergency hotline information within 10 seconds

**Handoff Outcomes:**
- 95% of high-risk participants contacted by human support within 24 hours
- 100% of critical cases escalated to emergency services when appropriate
- Zero deaths or serious harm among flagged participants (long-term goal)

**Compliance & Quality:**
- 100% of high-risk sessions have complete documentation
- Clinical reviews completed within 48 hours for all critical cases
- Quarterly compliance audits pass with no major violations

**User Trust & Satisfaction:**
- Participants feel supported (qualitative feedback)
- No complaints about over-intervention or false alarms
- Clear communication of AI limitations and boundaries
