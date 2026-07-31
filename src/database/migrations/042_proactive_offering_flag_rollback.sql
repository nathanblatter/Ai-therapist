-- Rollback for 042_proactive_offering_flag.sql
ALTER TABLE session_configurations DROP COLUMN IF EXISTS proactive_offering;
