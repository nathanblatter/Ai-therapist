-- Migration 128: memory_suppressions ("forget that", ai-therapist-341).
-- Date: 2026-11-19
--
-- (127 is taken by the open prompt migration in PR #74.)
--
-- A participant can ask the assistant to forget, erase or not remember
-- something they said. The assistant cannot delete anything: the conversation
-- is research data, and removal is something the participant asks the
-- research team for (consent form, "Participation"). What the assistant can
-- promise is that it will not bring the thing up again, and until now that
-- promise was false: the automatic post-session summary carried the
-- disclosure into the next session's prompt (3 of 3 red-team runs).
--
-- One row per request. Nothing in the study record is deleted or edited by a
-- row here; it only controls what is carried into session MEMORY:
--
--   topic                  a short neutral description of what not to carry
--                          forward, written by the model (forget_this tool)
--                          or by the post-session summarizer when the model
--                          did not call the tool. No names or identifiers.
--   applied_at             set by the post-session job once it has checked
--                          every stored memory item older than the request
--                          (remembered facts, earlier summaries) against the
--                          topic. While NULL, memory reads hide everything
--                          older than the request (fail closed;
--                          utils/memoryScreen.ts). The case profile is left
--                          out of memory whenever any row exists, and is
--                          never edited.
--   suppressed_memory_ids  user_memories rows that job found to mention the
--                          topic; they stay stored and are no longer read
--                          into memory.
--
-- The code treats a missing table as "no suppressions" (and forget_this then
-- tells the model the request could not be recorded), so deploying before
-- this migration is applied degrades honestly instead of breaking memory.
BEGIN;

CREATE TABLE IF NOT EXISTS memory_suppressions (
  suppression_id        BIGSERIAL PRIMARY KEY,
  user_id               INTEGER NOT NULL REFERENCES users(userid) ON DELETE CASCADE,
  session_id            TEXT REFERENCES therapy_sessions(session_id) ON DELETE SET NULL,
  topic                 TEXT NOT NULL,
  source                TEXT NOT NULL DEFAULT 'tool' CHECK (source IN ('tool', 'summary')),
  suppressed_memory_ids INTEGER[] NOT NULL DEFAULT '{}',
  created_at            TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  applied_at            TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_memory_suppressions_user
  ON memory_suppressions (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_memory_suppressions_session
  ON memory_suppressions (session_id);

COMMENT ON TABLE memory_suppressions IS
  'Participant requests that the assistant not carry something into session memory ("forget that"). Controls memory only; no study record is deleted.';
COMMENT ON COLUMN memory_suppressions.applied_at IS
  'When the post-session job finished checking older stored memory against the topic; NULL = memory reads hide everything older than created_at';

COMMIT;
