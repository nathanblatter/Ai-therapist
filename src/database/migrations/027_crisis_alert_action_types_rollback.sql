-- Rollback 027: restore the migration-025 constraint (drops rows first would
-- be required if any crisis_sms_alert/safety_protocol rows exist; delete them
-- so the narrower constraint can be re-applied).
DELETE FROM intervention_actions WHERE action_type IN ('crisis_sms_alert', 'safety_protocol');
ALTER TABLE intervention_actions DROP CONSTRAINT intervention_actions_action_type_check;
ALTER TABLE intervention_actions ADD CONSTRAINT intervention_actions_action_type_check
  CHECK (action_type IN (
    'low_risk_resources', 'medium_risk_alert', 'high_risk_emergency',
    'supervisor_review', 'clinical_review', 'handoff_initiated',
    'monitoring_increased', 'external_api_called', 'auto_flag', 'manual_flag',
    'risk_steering', 'ai_escalation'
  ));
