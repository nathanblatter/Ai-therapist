-- Migration 091: data-access audit log + redaction review log (IRB-claims audit).
-- Date: 2026-09-04
--
-- Two append-only accountability tables:
--   * data_access_log — WHO viewed transcripts / streamed recordings / ran
--     dataset exports. Writes are fire-and-forget in the routes (a log failure
--     never blocks the request), but the table itself is the durable record.
--   * redaction_review_log — WHO reviewed/corrected each sampled message in
--     the /redact verification tool (updateRedactedContent was previously a
--     bare UPDATE with no accountability). action='approved' records a
--     no-change sign-off; action='corrected' accompanies a content overwrite.
--
-- No FKs on the actor columns: audit rows must never block user deletion and
-- must survive it.

BEGIN;

CREATE TABLE IF NOT EXISTS data_access_log (
  id          BIGSERIAL PRIMARY KEY,
  accessed_by INTEGER,
  role        TEXT,
  action      TEXT NOT NULL,
  session_id  TEXT,
  user_id     INTEGER,
  detail      JSONB,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
COMMENT ON TABLE data_access_log IS
  'Append-only record of sensitive-data access (transcript views, recording streams, exports). accessed_by/user_id are userids kept without FKs so rows outlive account deletion.';
CREATE INDEX IF NOT EXISTS idx_data_access_log_created ON data_access_log(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_data_access_log_session ON data_access_log(session_id) WHERE session_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS redaction_review_log (
  review_id   BIGSERIAL PRIMARY KEY,
  message_id  BIGINT NOT NULL,
  reviewed_by INTEGER,
  action      TEXT NOT NULL CHECK (action IN ('approved', 'corrected')),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
COMMENT ON TABLE redaction_review_log IS
  'Append-only record of manual redaction verification (/redact tool): who approved or corrected each sampled message. No FK to messages so review history survives message deletion.';
CREATE INDEX IF NOT EXISTS idx_redaction_review_log_message ON redaction_review_log(message_id);

COMMIT;
