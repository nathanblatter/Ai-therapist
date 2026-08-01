-- Migration: Approval audit trail for the RAG knowledge base
-- (ai-therapist-88, audit-trail half; reranking is a separate work item)
-- Date: 2026-07-31
--
-- knowledge_chunks.active previously flipped with no record of who/when.
-- Adds approver identity + note; retrieval behavior is unchanged.

ALTER TABLE knowledge_chunks ADD COLUMN IF NOT EXISTS approved_by  VARCHAR(255);
ALTER TABLE knowledge_chunks ADD COLUMN IF NOT EXISTS approved_at  TIMESTAMPTZ;
ALTER TABLE knowledge_chunks ADD COLUMN IF NOT EXISTS approval_note TEXT;

COMMENT ON COLUMN knowledge_chunks.approved_by IS 'Identity (admin username or script --by value) that made this chunk active';
COMMENT ON COLUMN knowledge_chunks.approved_at IS 'When the current approval happened';
COMMENT ON COLUMN knowledge_chunks.approval_note IS 'Free-text rationale; retained on unapprove as the last-approval record';

-- Backfill the pre-audit-trail corpus (82 active chunks at time of writing).
UPDATE knowledge_chunks
SET approved_by   = 'system-backfill',
    approved_at   = '2026-07-30T00:00:00Z',
    approval_note = 'bulk-approved 2026-07-30 (pre-audit-trail)'
WHERE active IS TRUE
  AND approved_by IS NULL;
