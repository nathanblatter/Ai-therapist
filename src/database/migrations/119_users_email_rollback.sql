-- Rollback 119: drop users.email and take byuisresearch.com off the allowlist.
DROP INDEX IF EXISTS idx_users_email_lower;
ALTER TABLE users DROP COLUMN IF EXISTS email;

UPDATE system_config
SET config_value = jsonb_set(
      config_value,
      '{allowed_domains}',
      COALESCE((SELECT jsonb_agg(d) FROM jsonb_array_elements(config_value->'allowed_domains') d WHERE d <> '"byuisresearch.com"'::jsonb), '[]'::jsonb)
    ),
    updated_at = CURRENT_TIMESTAMP,
    updated_by = 'rollback 119'
WHERE config_key = 'notification_email_recipients';
