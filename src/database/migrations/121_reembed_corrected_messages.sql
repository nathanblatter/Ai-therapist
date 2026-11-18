-- 121: clear stale message embeddings on hand-corrected redactions
-- (ai-therapist-177, researcher semantic search).
--
-- The 085 sweep embeds content_redacted once and never revisits a row. A
-- researcher correction in the /redact tool (redaction_review_log
-- action='corrected') or a transcript edit (metadata.edited) rewrites
-- content_redacted but, before this change, left the vector computed from the
-- OLD text in place. For a /redact correction that old text is precisely the
-- one a reviewer judged to still carry an identifier, so ranking on it (the
-- new semantic search) would be a small inference channel on PHI the study
-- already removed. The write paths now clear embedding with the text; this
-- clears the rows corrected before that. The sweep re-embeds them from the
-- current content_redacted on its next tick (a handful of rows; one batched
-- embeddings call).
--
-- Data-only and idempotent. No lock beyond the row updates; no index change.

BEGIN;

UPDATE messages
   SET embedding = NULL
 WHERE embedding IS NOT NULL
   AND (metadata->>'edited' = 'true'
        OR message_id IN (SELECT message_id FROM redaction_review_log WHERE action = 'corrected'));

COMMIT;
