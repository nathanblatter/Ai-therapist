ALTER TABLE users DROP COLUMN IF EXISTS risk_context_share_enabled;
ALTER TABLE session_insights DROP COLUMN IF EXISTS notes_created_at;
ALTER TABLE session_insights DROP COLUMN IF EXISTS notes_author;
ALTER TABLE session_insights DROP COLUMN IF EXISTS notes_for_next_session;
DROP TABLE IF EXISTS user_case_profiles;
