-- Rollback for 011_add_crisis_management_patch.sql
-- Restores the original eight-value action_type CHECK from
-- 011_add_crisis_management.sql (drops 'auto_flag' and 'manual_flag').
--
-- Precondition: no intervention_actions rows may hold 'auto_flag' or
-- 'manual_flag' (stage has auto_flag rows, so this will refuse there until
-- they are deleted). Later migrations (025, 027, 068, 105) widen the same
-- constraint; roll those back first so the value set shrinks in order.
BEGIN;

ALTER TABLE intervention_actions DROP CONSTRAINT intervention_actions_action_type_check;

ALTER TABLE intervention_actions ADD CONSTRAINT intervention_actions_action_type_check
CHECK (action_type IN (
  'low_risk_resources', 'medium_risk_alert', 'high_risk_emergency',
  'supervisor_review', 'clinical_review', 'handoff_initiated',
  'monitoring_increased', 'external_api_called'
));

COMMIT;
