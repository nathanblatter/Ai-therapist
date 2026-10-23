-- Rollback for 115_weekly_digests.sql
-- Drops the digest archive. Every row can be regenerated from live data
-- (same week, same org), so nothing irreplaceable is lost.
BEGIN;

DROP INDEX IF EXISTS idx_weekly_digests_org_week;
DROP TABLE IF EXISTS weekly_digests;

COMMIT;
