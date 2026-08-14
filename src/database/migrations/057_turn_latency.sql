-- Migration 057 (telemetry pass 3): real per-turn response latency.
-- Date: 2026-08-13
--
-- The dashboard's old "response time" metric diffed consecutive message
-- created_at timestamps — but realtime messages arrive via the client's
-- batched 15s flush, so it measured flush cadence, not latency. This table
-- stores ground-truth turn timing captured server-side:
--   realtime: sideband events (input_audio_transcription.completed ->
--             first output delta -> response.done)
--   chat:     wall time of the full sendMessage tool loop (non-streaming,
--             so ttfa == total)
-- ttfa_ms = time to first audio/output; total_ms = user turn end -> response done.

CREATE TABLE IF NOT EXISTS turn_latency (
  id               BIGSERIAL PRIMARY KEY,
  session_id       TEXT REFERENCES therapy_sessions(session_id) ON DELETE CASCADE,
  turn_index       INTEGER,
  user_done_at     TIMESTAMPTZ,
  first_output_at  TIMESTAMPTZ,
  response_done_at TIMESTAMPTZ,
  ttfa_ms          INTEGER,
  total_ms         INTEGER,
  channel          TEXT CHECK (channel IN ('realtime', 'chat')),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_turn_latency_session ON turn_latency(session_id);
CREATE INDEX IF NOT EXISTS idx_turn_latency_created ON turn_latency(created_at DESC);

COMMENT ON TABLE turn_latency IS 'Ground-truth per-turn response latency (TTFA + total), captured from sideband events (realtime) and sendMessage wall time (chat)';
