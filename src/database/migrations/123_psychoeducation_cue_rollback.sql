-- Rollback 123: drop the psychoeducation-cue experiment arm column.
ALTER TABLE session_configurations DROP COLUMN IF EXISTS psychoeducation_cue;
