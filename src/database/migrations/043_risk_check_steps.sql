-- Migration: Structured C-SSRS-style laddered risk-assessment logging
-- (ai-therapist-71)
-- Date: 2026-07-30
--
-- Backs the run_risk_check tool. The existing crisis-detection pipeline
-- (crisisIntervention.service SAFETY_PROTOCOL_GUIDANCE) already instructs the
-- model to ask a laddered sequence of safety questions when risk is high; this
-- table lets the model log each step explicitly for clean study data on how
-- far the assessment progressed and what band it resolved to. Complements,
-- does not replace, the automatic crisis_events pipeline (011).

CREATE TABLE IF NOT EXISTS risk_check_steps (
    check_step_id  BIGSERIAL PRIMARY KEY,
    session_id     TEXT NOT NULL REFERENCES therapy_sessions(session_id) ON DELETE CASCADE,
    crisis_event_id BIGINT REFERENCES crisis_events(event_id) ON DELETE SET NULL, -- linked crisis flag, if any
    step            TEXT NOT NULL CHECK (step IN (
                       'ideation', 'plan', 'means', 'timeframe', 'intent', 'protective_factors'
                     )),
    answer          TEXT NOT NULL,             -- the participant's answer, close to their words (redacted downstream like other content)
    risk_band       TEXT NOT NULL CHECK (risk_band IN ('none', 'low', 'moderate', 'high', 'imminent')),
    sequence        INTEGER NOT NULL DEFAULT 1, -- ordering within one assessment pass (a session can have multiple passes)
    created_at      TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_risk_check_steps_session ON risk_check_steps(session_id);
CREATE INDEX IF NOT EXISTS idx_risk_check_steps_crisis_event ON risk_check_steps(crisis_event_id);

COMMENT ON TABLE risk_check_steps IS 'Structured C-SSRS-style ladder steps logged by the run_risk_check tool (ai-therapist-71); complements the automatic crisis_events pipeline';
COMMENT ON COLUMN risk_check_steps.step IS 'Ladder position: ideation -> plan -> means -> timeframe -> intent, plus protective_factors as an optional counterweight step';
