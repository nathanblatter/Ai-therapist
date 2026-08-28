-- Rollback for migration 073: drop the work queue table.

BEGIN;

DROP TABLE IF EXISTS work_items;

COMMIT;
