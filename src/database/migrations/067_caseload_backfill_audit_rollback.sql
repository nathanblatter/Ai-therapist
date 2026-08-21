BEGIN;
DELETE FROM caseload_audit_log WHERE detail->>'source' = 'migration_064_backfill';
COMMIT;
