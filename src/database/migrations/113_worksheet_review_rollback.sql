-- Rollback for 113_worksheet_review.sql
-- Drops the review bookkeeping only. Promoted knowledge_chunks rows
-- (source = 'worksheet_promotion') are ordinary corpus content and stay.
BEGIN;

DROP INDEX IF EXISTS idx_worksheet_instances_review_queue;
ALTER TABLE worksheet_instances DROP CONSTRAINT IF EXISTS worksheet_instances_review_status_check;
ALTER TABLE worksheet_instances
  DROP COLUMN IF EXISTS review_status,
  DROP COLUMN IF EXISTS reviewed_by,
  DROP COLUMN IF EXISTS reviewed_at,
  DROP COLUMN IF EXISTS review_note,
  DROP COLUMN IF EXISTS promoted_chunk_id;

COMMIT;
