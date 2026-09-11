-- 102_reredact_tool_events.sql — re-queue tool-event rows that were never redacted
--
-- POST /api/sessions/:id/tool-event wrote the participant's verbatim free text
-- into BOTH `content` and `content_redacted`. That text comes from thought
-- records and fear ladders and carries names, places and dates.
--
-- Because content_redacted was already non-NULL, redactSession skipped the rows
-- (it only processes content_redacted IS NULL), and its role filter excluded
-- role='system' anyway. So raw participant PHI sat in the column that every
-- researcher surface treats as de-identified: the admin session view and the
-- full export both select content_redacted for non-owner roles.
--
-- The code is fixed on both sides (the route no longer pre-fills the column;
-- redactSession now covers tool_event_% rows). This migration repairs the rows
-- already written.
--
-- Setting content_redacted back to NULL is what re-queues them: redactSession
-- selects exactly `content_redacted IS NULL`. Until the redaction job runs for
-- a given session, those rows will read as NULL rather than as raw PHI — which
-- is the correct failure direction. `content` is untouched, so nothing is lost.

UPDATE messages
SET content_redacted = NULL
WHERE message_type LIKE 'tool_event_%'
  AND content_redacted IS NOT NULL
  -- Only rows that were never actually redacted. If the two columns differ,
  -- redaction genuinely ran at some point and the result must be preserved.
  AND content_redacted IS NOT DISTINCT FROM content;

-- Re-run redaction for the affected sessions with:
--   node src/database/scripts/... (or the admin re-redact control)
-- Sessions that are still active will be covered by the normal end-of-session
-- redaction pass.
