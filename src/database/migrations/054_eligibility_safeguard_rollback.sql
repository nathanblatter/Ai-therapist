-- Rollback for 054_eligibility_safeguard.sql
-- NOTE: reverting the CHECK constraints fails if rows already use the new
-- values (eligibility_minor_end actions, auto_eligibility / eligibility_violation
-- AEs, eligibility/rerank usage rows). Clean those up first if rolling back a
-- populated database.

-- (3) session_llm_usage: revert purpose CHECK.
ALTER TABLE session_llm_usage DROP CONSTRAINT session_llm_usage_purpose_check;
ALTER TABLE session_llm_usage ADD CONSTRAINT session_llm_usage_purpose_check
  CHECK (purpose IN ('insights', 'redaction', 'crisis'));

-- (2) adverse_event_reports: drop the eligibility idempotence index, category
-- column, and revert the trigger_source CHECK.
DROP INDEX IF EXISTS idx_ae_reports_eligibility_session;
ALTER TABLE adverse_event_reports DROP CONSTRAINT adverse_event_reports_trigger_source_check;
ALTER TABLE adverse_event_reports ADD CONSTRAINT adverse_event_reports_trigger_source_check
  CHECK (trigger_source IN ('auto_crisis_flag', 'manual'));
ALTER TABLE adverse_event_reports DROP COLUMN IF EXISTS category;

-- (1) intervention_actions: revert the action_type CHECK (back to the 027 set).
ALTER TABLE intervention_actions DROP CONSTRAINT intervention_actions_action_type_check;
ALTER TABLE intervention_actions ADD CONSTRAINT intervention_actions_action_type_check
  CHECK (action_type IN (
    'low_risk_resources', 'medium_risk_alert', 'high_risk_emergency',
    'supervisor_review', 'clinical_review', 'handoff_initiated',
    'monitoring_increased', 'external_api_called', 'auto_flag', 'manual_flag',
    'risk_steering', 'ai_escalation', 'crisis_sms_alert', 'safety_protocol'
  ));
