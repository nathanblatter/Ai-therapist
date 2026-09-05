-- redteam-seed.sql — idempotent config seed for the red-team harness DB.
--
-- Migration 007 already seeds crisis_contact / features / voices, so on a clean
-- 003..046 run these rows exist. This file is belt-and-braces: it guarantees the
-- rows the harness relies on are present (chat + voice enabled) EVEN if an
-- upstream migration seed changes, and — critically — it FORCES the crisis_alert
-- config to enabled=false so the harness can never page a real on-call from CI
-- (spec §14 R3b). The env guard (no IMESSAGE_API_KEY / CRISIS_ALERT_PHONE) is the
-- primary defense; this is the second layer.

INSERT INTO system_config (config_key, config_value, description) VALUES
  ('crisis_contact',
   '{"hotline": "988 Suicide & Crisis Lifeline", "phone": "988", "text": "HOME to 741741", "enabled": true}'::jsonb,
   'Crisis contact information (redteam seed)'),
  ('features',
   '{"voice_enabled": true, "chat_enabled": true, "file_upload_enabled": false, "session_recording_enabled": false}'::jsonb,
   'Feature flags (redteam seed)'),
  ('voices',
   '{"enabled_voices": ["cedar", "alloy"], "default_voice": "cedar"}'::jsonb,
   'Available voice options (redteam seed)')
ON CONFLICT (config_key) DO NOTHING;

-- Disable per-participant session limits so a single red-team participant can
-- run all chat scenarios in one pass without tripping max_sessions_per_day.
INSERT INTO system_config (config_key, config_value, description)
VALUES ('session_limits', '{"enabled": false}'::jsonb, 'Session limits DISABLED for redteam/CI')
ON CONFLICT (config_key)
  DO UPDATE SET config_value = jsonb_set(COALESCE(system_config.config_value, '{}'::jsonb), '{enabled}', 'false'::jsonb);

-- Force crisis paging OFF regardless of what migration 044 seeded.
INSERT INTO system_config (config_key, config_value, description)
VALUES ('crisis_alert', '{"enabled": false, "phone": null}'::jsonb, 'Crisis paging DISABLED for redteam/CI')
ON CONFLICT (config_key)
  DO UPDATE SET config_value = '{"enabled": false, "phone": null}'::jsonb,
                description   = 'Crisis paging DISABLED for redteam/CI';
