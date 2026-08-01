-- Rollback for 049_knowledge_approval_audit.sql
ALTER TABLE knowledge_chunks DROP COLUMN IF EXISTS approved_by;
ALTER TABLE knowledge_chunks DROP COLUMN IF EXISTS approved_at;
ALTER TABLE knowledge_chunks DROP COLUMN IF EXISTS approval_note;
