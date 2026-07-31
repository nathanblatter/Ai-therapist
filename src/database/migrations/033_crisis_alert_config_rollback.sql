-- Rollback for 033_crisis_alert_config.sql
DELETE FROM system_config WHERE config_key = 'crisis_alert';
