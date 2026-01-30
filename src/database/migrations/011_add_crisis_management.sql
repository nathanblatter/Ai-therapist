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
