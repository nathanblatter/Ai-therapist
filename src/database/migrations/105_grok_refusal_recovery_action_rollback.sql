-- Rollback for 105_grok_refusal_recovery_action.sql — back to the 054 set.
-- Rows written by the refusal-loop guard must go first or the constraint
-- cannot be re-created.

DELETE FROM intervention_actions WHERE action_type = 'voice_refusal_recovery';

ALTER TABLE intervention_actions DROP CONSTRAINT IF EXISTS intervention_actions_action_type_check;
ALTER TABLE intervention_actions ADD CONSTRAINT intervention_actions_action_type_check
  CHECK (action_type IN (
    'low_risk_resources', 'medium_risk_alert', 'high_risk_emergency',
    'supervisor_review', 'clinical_review', 'handoff_initiated',
    'monitoring_increased', 'external_api_called', 'auto_flag', 'manual_flag',
    'risk_steering', 'ai_escalation', 'crisis_sms_alert', 'safety_protocol',
    'eligibility_minor_end'
  ));
