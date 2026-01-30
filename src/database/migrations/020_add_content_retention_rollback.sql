-- Rollback: Remove content retention settings and wipe log
-- Date: 2026-01-29

DROP TABLE IF EXISTS content_wipe_log;

DELETE FROM system_config WHERE config_key = 'content_retention';
