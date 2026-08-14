-- Rollback for migration 060: remove the deployment_mode config row.
-- The admin API and UI both fall back to 'research' when the row is absent.

DELETE FROM system_config WHERE config_key = 'deployment_mode';
