-- 119: users.email (ai-therapist-283, phase 1).
--
-- Staff accounts (researcher / therapist / caseworker) get an email address of
-- their own: provisioned as <slug>@byuisresearch.com from the admin Users
-- view, or set by hand. Until now the only address the notifier could use was
-- an email-shaped username (ai-therapist-154). Participants stay anonymous:
-- the application never sets this column for the participant role.
--
-- The notification recipient gate (111) keeps its enabled flag as it is
-- (seeded off); byuisresearch.com joins its domain allowlist so that, once the
-- gate is switched on, provisioned study addresses are deliverable.

ALTER TABLE users ADD COLUMN IF NOT EXISTS email text;
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email_lower ON users (lower(email)) WHERE email IS NOT NULL;

UPDATE system_config
SET config_value = jsonb_set(
      config_value,
      '{allowed_domains}',
      COALESCE(config_value->'allowed_domains', '[]'::jsonb) || '["byuisresearch.com"]'::jsonb
    ),
    updated_at = CURRENT_TIMESTAMP,
    updated_by = 'migration 119 (study email domain on the notification allowlist)'
WHERE config_key = 'notification_email_recipients'
  AND NOT (COALESCE(config_value->'allowed_domains', '[]'::jsonb) ? 'byuisresearch.com');
