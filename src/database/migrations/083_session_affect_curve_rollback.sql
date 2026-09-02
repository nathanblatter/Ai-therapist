BEGIN;

ALTER TABLE session_insights DROP COLUMN IF EXISTS affect_curve;

COMMIT;
