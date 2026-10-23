-- Migration 111: seed the notification email recipient gate (ai-therapist-154).
-- Date: 2026-10-22
--
-- notification.service emails care-team members at their username when it is
-- email-shaped; there is no users.email column and no address verification.
-- This switch makes that explicit and closed by default: notification email
-- goes only to usernames whose domain is on allowed_domains while enabled is
-- true. The reader (loadNotificationEmailGate) treats a missing or malformed
-- row as disabled, so applying this migration changes nothing on its own
-- beyond making the setting visible and editable. In-app notifications and
-- the sandbox/PHI rules are unaffected. ON CONFLICT DO NOTHING leaves an
-- existing row alone.
BEGIN;

INSERT INTO system_config (config_key, config_value, description) VALUES
(
    'notification_email_recipients',
    '{"enabled": false, "allowed_domains": []}'::jsonb,
    'Recipient gate for care-team notification email (notification.service): with no users.email column the address is the email-shaped username, so email is sent only when enabled=true AND the username domain is listed in allowed_domains (lower-case, exact match)'
)
ON CONFLICT (config_key) DO NOTHING;

COMMIT;
