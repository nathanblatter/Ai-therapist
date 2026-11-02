-- 118: allow action_type 'crisis_timer_extended' (ai-therapist-281).
--
-- On a high crisis flag our own session duration limit is lifted to the
-- vendor ceiling so the participant is not cut off by us. That is an
-- intervention the participant experienced, logged where admins already look.

ALTER TABLE intervention_actions DROP CONSTRAINT IF EXISTS intervention_actions_action_type_check;
ALTER TABLE intervention_actions ADD CONSTRAINT intervention_actions_action_type_check
  CHECK (action_type IN (
    'low_risk_resources', 'medium_risk_alert', 'high_risk_emergency',
    'supervisor_review', 'clinical_review', 'handoff_initiated',
    'monitoring_increased', 'external_api_called', 'auto_flag', 'manual_flag',
    'risk_steering', 'ai_escalation', 'crisis_sms_alert', 'safety_protocol',
    'eligibility_minor_end', 'voice_refusal_recovery', 'model_end_refused',
    'model_end_participant_requested', 'crisis_timer_extended'
  ));
