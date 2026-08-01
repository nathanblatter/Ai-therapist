-- Migration 054 (ai-therapist-106 + ai-therapist-105): safety-wave schema deltas.
-- Date: 2026-07-31
--
-- Three additive constraint changes to support (a) the chat-pipeline crisis
-- parity work (105) and (b) the minor / age-eligibility safeguard (106):
--   1. intervention_actions: allow the new 'eligibility_minor_end' action type
--      (same pattern as migrations 025/027 — a missing CHECK value makes
--      logInterventionAction silently swallow the row).
--   2. adverse_event_reports: add a `category` column so eligibility-violation
--      AEs are distinguishable from crisis AEs, allow the 'auto_eligibility'
--      trigger source, and enforce one auto eligibility AE per session.
--   3. session_llm_usage: cost-track the eligibility confirmation calls (106)
--      and the RAG rerank calls (88; 'rerank' added here so migration 055 stays
--      a purely additive table).

-- (1) intervention_actions: allow the eligibility action type.
ALTER TABLE intervention_actions DROP CONSTRAINT intervention_actions_action_type_check;
ALTER TABLE intervention_actions ADD CONSTRAINT intervention_actions_action_type_check
  CHECK (action_type IN (
    'low_risk_resources', 'medium_risk_alert', 'high_risk_emergency',
    'supervisor_review', 'clinical_review', 'handoff_initiated',
    'monitoring_increased', 'external_api_called', 'auto_flag', 'manual_flag',
    'risk_steering', 'ai_escalation', 'crisis_sms_alert', 'safety_protocol',
    'eligibility_minor_end'
  ));

-- (2) adverse_event_reports: category + new trigger source + per-session auto
-- eligibility idempotence.
ALTER TABLE adverse_event_reports
  ADD COLUMN IF NOT EXISTS category VARCHAR(30) NOT NULL DEFAULT 'crisis'
    CHECK (category IN ('crisis', 'eligibility_violation'));
ALTER TABLE adverse_event_reports DROP CONSTRAINT adverse_event_reports_trigger_source_check;
ALTER TABLE adverse_event_reports ADD CONSTRAINT adverse_event_reports_trigger_source_check
  CHECK (trigger_source IN ('auto_crisis_flag', 'manual', 'auto_eligibility'));
-- One auto eligibility AE per session (crisis AEs keep their per-crisis_event
-- unique index from 048; these two partial indexes don't collide).
CREATE UNIQUE INDEX IF NOT EXISTS idx_ae_reports_eligibility_session
  ON adverse_event_reports(session_id) WHERE trigger_source = 'auto_eligibility';

-- (3) session_llm_usage: cost-track eligibility + rerank calls.
ALTER TABLE session_llm_usage DROP CONSTRAINT session_llm_usage_purpose_check;
ALTER TABLE session_llm_usage ADD CONSTRAINT session_llm_usage_purpose_check
  CHECK (purpose IN ('insights', 'redaction', 'crisis', 'eligibility', 'rerank'));

COMMENT ON COLUMN adverse_event_reports.category IS 'crisis (988/self-harm) vs eligibility_violation (disclosed minor); drives admin filtering (ai-therapist-106)';
