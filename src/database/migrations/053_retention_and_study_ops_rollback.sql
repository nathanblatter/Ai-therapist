-- Rollback 053: drops the retention/deviation tables and removes the seeded
-- system_config rows. Deletion-audit history and deviation history are lost.
DROP TABLE IF EXISTS protocol_deviations;
DROP TABLE IF EXISTS data_deletion_log;
DELETE FROM system_config WHERE config_key IN ('data_retention', 'study_protocol');
