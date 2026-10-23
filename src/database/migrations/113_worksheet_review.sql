-- Migration 113: worksheet review outcome (ai-therapist-89)
-- Date: 2026-10-23
--
-- Migration 041 designed a generate -> review -> canon loop for personalized
-- worksheets (create_custom_worksheet) but only built the generate half:
-- worksheet_instances.promoted exists and nothing ever set it. This adds the
-- review half's bookkeeping. A completed instance sits in the review queue
-- (review_status = 'pending') until a researcher either promotes its
-- de-personalised TEMPLATE into knowledge_chunks (source =
-- 'worksheet_promotion') or rejects it. The participant's answers never leave
-- worksheet_instances; promoted_chunk_id makes promotion idempotent per
-- instance. `promoted` is kept in sync for existing readers.
BEGIN;

ALTER TABLE worksheet_instances
  ADD COLUMN IF NOT EXISTS review_status TEXT NOT NULL DEFAULT 'pending',
  ADD COLUMN IF NOT EXISTS reviewed_by VARCHAR(255),
  ADD COLUMN IF NOT EXISTS reviewed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS review_note TEXT,
  ADD COLUMN IF NOT EXISTS promoted_chunk_id BIGINT REFERENCES knowledge_chunks(chunk_id) ON DELETE SET NULL;

ALTER TABLE worksheet_instances DROP CONSTRAINT IF EXISTS worksheet_instances_review_status_check;
ALTER TABLE worksheet_instances
  ADD CONSTRAINT worksheet_instances_review_status_check
  CHECK (review_status IN ('pending', 'promoted', 'rejected'));

-- Nothing ever set promoted = TRUE before this migration, but keep the two
-- columns consistent should a hand edit have done so.
UPDATE worksheet_instances SET review_status = 'promoted' WHERE promoted IS TRUE AND review_status = 'pending';

CREATE INDEX IF NOT EXISTS idx_worksheet_instances_review_queue
  ON worksheet_instances (completed_at DESC)
  WHERE status = 'completed' AND review_status = 'pending';

COMMENT ON COLUMN worksheet_instances.review_status IS 'pending | promoted | rejected: researcher review outcome for a completed instance';
COMMENT ON COLUMN worksheet_instances.reviewed_by IS 'Admin username that promoted or rejected the instance';
COMMENT ON COLUMN worksheet_instances.reviewed_at IS 'When the review outcome was recorded';
COMMENT ON COLUMN worksheet_instances.review_note IS 'Reviewer rationale (required on reject, optional on promote)';
COMMENT ON COLUMN worksheet_instances.promoted_chunk_id IS 'knowledge_chunks row holding the de-personalised template (source = worksheet_promotion); set once per instance';

COMMIT;
