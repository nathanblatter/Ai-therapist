-- 105_grok_refusal_recovery_action.sql — allow action_type 'voice_refusal_recovery'
--
-- xAI's server-side moderation can lock a Grok Voice session into a canned
-- refusal loop ("I can't help with that request", five times in a row in the
-- stage session of 2026-09-23). The proxy now breaks the loop: a system steer
-- first, then a server-authored recovery line spoken on the transcript
-- channel. That second step is an intervention a participant experienced, so
-- it is logged to intervention_actions where admins already look — which the
-- action_type CHECK constraint must allow (same failure class as 104).

ALTER TABLE intervention_actions DROP CONSTRAINT IF EXISTS intervention_actions_action_type_check;
ALTER TABLE intervention_actions ADD CONSTRAINT intervention_actions_action_type_check
  CHECK (action_type IN (
    'low_risk_resources', 'medium_risk_alert', 'high_risk_emergency',
    'supervisor_review', 'clinical_review', 'handoff_initiated',
    'monitoring_increased', 'external_api_called', 'auto_flag', 'manual_flag',
    'risk_steering', 'ai_escalation', 'crisis_sms_alert', 'safety_protocol',
    'eligibility_minor_end', 'voice_refusal_recovery'
  ));
