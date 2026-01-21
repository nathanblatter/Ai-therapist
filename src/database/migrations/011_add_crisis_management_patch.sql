-- Patch migration to add missing action types to intervention_actions
BEGIN;

-- Drop the existing constraint
ALTER TABLE intervention_actions DROP CONSTRAINT intervention_actions_action_type_check;

-- Add new constraint with additional action types
ALTER TABLE intervention_actions ADD CONSTRAINT intervention_actions_action_type_check
CHECK (action_type IN (
  'low_risk_resources', 'medium_risk_alert', 'high_risk_emergency',
  'supervisor_review', 'clinical_review', 'handoff_initiated',
  'monitoring_increased', 'external_api_called',
  'auto_flag', 'manual_flag'
));

COMMIT;
