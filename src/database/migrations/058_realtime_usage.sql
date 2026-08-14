-- Migration 058 (telemetry pass 3): realtime voice token metering.
-- Date: 2026-08-13
--
-- Realtime voice cost was previously only estimated by wall-clock session
-- minutes. OpenAI Realtime emits response.done with response.usage (input/
-- output token counts including an audio/text/cached breakdown); the sideband
-- now records one row per completed response so realtime spend can be priced
-- with real gpt-realtime token rates (see REALTIME_RATES_PER_MILLION in
-- src/server/db/costTracking.queries.ts).

CREATE TABLE IF NOT EXISTS realtime_usage (
  id                  BIGSERIAL PRIMARY KEY,
  session_id          TEXT REFERENCES therapy_sessions(session_id) ON DELETE CASCADE,
  response_id         TEXT,
  input_tokens        INTEGER,
  output_tokens       INTEGER,
  input_audio_tokens  INTEGER,
  output_audio_tokens INTEGER,
  cached_tokens       INTEGER,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_realtime_usage_session ON realtime_usage(session_id);

COMMENT ON TABLE realtime_usage IS 'Per-response token usage from OpenAI Realtime response.done events (audio/text/cached split), for metered realtime cost tracking';
