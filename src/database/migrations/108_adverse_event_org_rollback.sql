-- Rollback for 108_adverse_event_org.sql
BEGIN;
DROP INDEX IF EXISTS idx_ae_reports_org;
ALTER TABLE adverse_event_reports DROP COLUMN IF EXISTS organization_id;
COMMIT;
