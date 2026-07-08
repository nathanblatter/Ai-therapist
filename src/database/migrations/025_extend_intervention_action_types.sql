-- The intervention_actions CHECK constraint predates risk-adaptive steering
-- (ai-therapist-42) and model-initiated escalation (ai-therapist-29); both new
-- action types were being rejected (and swallowed by logInterventionAction's
-- catch). Extend the allowed set.
ALTER TABLE intervention_actions DROP CONSTRAINT intervention_actions_action_type_check;
ALTER TABLE intervention_actions ADD CONSTRAINT intervention_actions_action_type_check
  CHECK (action_type IN (
    'low_risk_resources', 'medium_risk_alert', 'high_risk_emergency',
    'supervisor_review', 'clinical_review', 'handoff_initiated',
    'monitoring_increased', 'external_api_called', 'auto_flag', 'manual_flag',
    'risk_steering', 'ai_escalation'
  ));
