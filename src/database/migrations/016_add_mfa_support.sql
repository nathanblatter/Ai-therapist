-- Migration 016: Add Multi-Factor Authentication Support
-- Description: Adds TOTP-based MFA for admin accounts (therapist, researcher roles)

-- Add MFA columns to users table
ALTER TABLE users ADD COLUMN IF NOT EXISTS mfa_enabled BOOLEAN DEFAULT FALSE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS mfa_secret TEXT; -- Encrypted TOTP secret
ALTER TABLE users ADD COLUMN IF NOT EXISTS mfa_backup_codes TEXT[]; -- Array of hashed backup codes
ALTER TABLE users ADD COLUMN IF NOT EXISTS mfa_enabled_at TIMESTAMPTZ; -- When MFA was enabled
ALTER TABLE users ADD COLUMN IF NOT EXISTS last_mfa_verified_at TIMESTAMPTZ; -- Last successful MFA verification

-- Add index for MFA lookups
CREATE INDEX IF NOT EXISTS idx_users_mfa_enabled ON users(mfa_enabled) WHERE mfa_enabled = true;

-- Add comments for documentation
COMMENT ON COLUMN users.mfa_enabled IS 'Whether MFA is enabled for this user';
COMMENT ON COLUMN users.mfa_secret IS 'Base32-encoded TOTP secret (encrypted at application level)';
COMMENT ON COLUMN users.mfa_backup_codes IS 'Array of bcrypt-hashed backup codes for account recovery';
COMMENT ON COLUMN users.mfa_enabled_at IS 'Timestamp when MFA was first enabled';
COMMENT ON COLUMN users.last_mfa_verified_at IS 'Timestamp of last successful MFA verification';
