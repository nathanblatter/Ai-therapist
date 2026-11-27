-- Rollback for 134_session_alliance_ratings.sql
-- Drops every stored alliance rating. The ratings can be regenerated from the
-- redacted transcripts with src/database/scripts/rateAllianceMarkers.ts.
BEGIN;
DELETE FROM system_config WHERE config_key = 'alliance_markers';
DROP TABLE IF EXISTS session_alliance_ratings;
COMMIT;
