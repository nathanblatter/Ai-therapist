-- Rollback for migration 074: drop both notification tables.

BEGIN;

DROP TABLE IF EXISTS notification_preferences;
DROP TABLE IF EXISTS notifications;

COMMIT;
