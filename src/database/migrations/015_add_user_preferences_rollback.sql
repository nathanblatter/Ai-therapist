BEGIN;

-- Remove user preference columns
DROP INDEX IF EXISTS idx_users_preferences;

ALTER TABLE users
DROP COLUMN IF EXISTS preferred_voice,
DROP COLUMN IF EXISTS preferred_language;

COMMIT;
