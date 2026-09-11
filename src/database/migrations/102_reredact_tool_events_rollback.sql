-- Rollback for 102_reredact_tool_events.sql
--
-- Deliberately a NO-OP. The forward migration nulled content_redacted on
-- tool-event rows so they would be re-redacted; restoring it would mean
-- copying raw participant PHI back into the column researchers read as
-- de-identified, which is the bug this fixed. `content` was never modified,
-- so nothing was lost and there is nothing to restore.
SELECT 1;
