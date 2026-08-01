-- Rollback for 047_consent_versioning.sql
ALTER TABLE participant_consents DROP COLUMN IF EXISTS body_hash;
DROP INDEX IF EXISTS idx_consent_documents_effective_at;
DROP TABLE IF EXISTS consent_documents;
