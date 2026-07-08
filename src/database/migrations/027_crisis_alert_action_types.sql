-- The crisis-system expansion adds two new intervention action types:
-- 'crisis_sms_alert' (on-call phone paged via the iMessage API on a high
-- flag) and 'safety_protocol' (structured safety-assessment guidance injected
-- to the live model). The intervention_actions CHECK constraint must allow
-- them, or logInterventionAction silently swallows the rejection (same
-- failure mode migration 025 fixed for risk_steering/ai_escalation).
ALTER TABLE intervention_actions DROP CONSTRAINT intervention_actions_action_type_check;
ALTER TABLE intervention_actions ADD CONSTRAINT intervention_actions_action_type_check
  CHECK (action_type IN (
    'low_risk_resources', 'medium_risk_alert', 'high_risk_emergency',
    'supervisor_review', 'clinical_review', 'handoff_initiated',
    'monitoring_increased', 'external_api_called', 'auto_flag', 'manual_flag',
    'risk_steering', 'ai_escalation',
    'crisis_sms_alert', 'safety_protocol'
  ));
