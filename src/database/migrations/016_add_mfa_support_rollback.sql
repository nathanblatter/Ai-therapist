-- Rollback Migration 016: Remove Multi-Factor Authentication Support

-- Drop index
DROP INDEX IF EXISTS idx_users_mfa_enabled;

-- Remove MFA columns from users table
ALTER TABLE users DROP COLUMN IF EXISTS mfa_enabled;
ALTER TABLE users DROP COLUMN IF EXISTS mfa_secret;
ALTER TABLE users DROP COLUMN IF EXISTS mfa_backup_codes;
ALTER TABLE users DROP COLUMN IF EXISTS mfa_enabled_at;
ALTER TABLE users DROP COLUMN IF EXISTS last_mfa_verified_at;
