-- Rollback for 048_adverse_event_reports.sql
DROP INDEX IF EXISTS idx_ae_reports_crisis_event;
DROP INDEX IF EXISTS idx_ae_reports_status;
DROP INDEX IF EXISTS idx_ae_reports_due_at;
DROP INDEX IF EXISTS idx_ae_reports_session;
DROP TABLE IF EXISTS adverse_event_reports;
