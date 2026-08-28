-- Rollback for migration 078: drop the seeded clinical row, restore the
-- original 047 index, drop the audience column.

BEGIN;

DELETE FROM consent_documents WHERE version = '2026-08-27.c1';

DROP INDEX IF EXISTS idx_consent_documents_effective;
CREATE INDEX IF NOT EXISTS idx_consent_documents_effective_at
  ON consent_documents(effective_at DESC);

ALTER TABLE consent_documents DROP COLUMN IF EXISTS audience;

COMMIT;
