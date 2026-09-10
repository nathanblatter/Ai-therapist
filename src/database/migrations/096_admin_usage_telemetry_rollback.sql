-- Rollback for migration 096: de-identified admin usage telemetry.

BEGIN;

DROP TABLE IF EXISTS admin_usage_events;

UPDATE system_config
SET config_value = config_value - 'telemetry_admin_usage'
WHERE config_key = 'features';

COMMIT;
