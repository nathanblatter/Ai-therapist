DROP TABLE IF EXISTS session_insights;
ALTER TABLE therapy_sessions DROP COLUMN IF EXISTS checkin;
ALTER TABLE session_configurations DROP COLUMN IF EXISTS modality;
ALTER TABLE users DROP COLUMN IF EXISTS memory_enabled;
