BEGIN;

-- Add user preference columns for voice and language
ALTER TABLE users
ADD COLUMN preferred_voice VARCHAR(50) DEFAULT 'cedar',
ADD COLUMN preferred_language VARCHAR(10) DEFAULT 'en';

-- Add index for faster lookups
CREATE INDEX idx_users_preferences ON users(userid, preferred_voice, preferred_language);

COMMENT ON COLUMN users.preferred_voice IS 'User''s preferred AI voice (e.g., cedar, alloy, shimmer)';
COMMENT ON COLUMN users.preferred_language IS 'User''s preferred language code (e.g., en, es-ES, fr-FR)';

COMMIT;
