-- Rollback for 135_session_features.sql
-- Drops every stored session-features row. They can be regenerated from the
-- redacted transcripts with src/database/scripts/extractSessionFeatures.ts.
BEGIN;
DELETE FROM system_config WHERE config_key = 'session_features';
DROP TABLE IF EXISTS session_features;
COMMIT;
