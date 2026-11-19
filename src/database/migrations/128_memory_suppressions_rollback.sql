-- Rollback for 128_memory_suppressions.sql
-- Drops the forget-request records. The code treats the missing table as "no
-- suppressions": memory reads show everything again (including items a
-- request had hidden), and forget_this tells the model the request could not
-- be recorded. Summaries already marked memory_excluded stay excluded (the
-- marker is in session_insights.summary). No study record is affected.
BEGIN;

DROP INDEX IF EXISTS idx_memory_suppressions_session;
DROP INDEX IF EXISTS idx_memory_suppressions_user;
DROP TABLE IF EXISTS memory_suppressions;

COMMIT;
