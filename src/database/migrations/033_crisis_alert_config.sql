-- Migration 033 (ai-therapist-25a): admin-configurable on-call crisis paging.
-- crisisAlert.service.ts previously read IMESSAGE_API_KEY / CRISIS_ALERT_PHONE
-- purely from env (no enable toggle, redeploy needed to change the number).
-- This adds a system_config row so the on-call target and an explicit
-- enable/disable switch are editable from the admin SystemConfig UI, same
-- pattern as crisis_contact / session_limits. Falls back to env vars when
-- absent so existing deployments keep working unchanged.

INSERT INTO system_config (config_key, config_value, description) VALUES
(
    'crisis_alert',
    '{
        "enabled": true,
        "phone": null,
        "note": "phone left null falls back to the CRISIS_ALERT_PHONE env var"
    }'::jsonb,
    'On-call crisis paging: enable flag + destination phone for high-severity crisis SMS alerts (iMessage API)'
)
ON CONFLICT (config_key) DO NOTHING;
