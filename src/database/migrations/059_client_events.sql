-- Migration 059: client-side error beacon (pass-3 telemetry).
-- Date: 2026-08-13
--
-- Browser-side failures (WebRTC negotiation, mic permission, data channel,
-- chat send) were previously invisible server-side. The client now POSTs a
-- small allowlisted event to /api/client-events; this table stores them for
-- the admin ops dashboard aggregation. detail is capped (~2KB) at the route.

BEGIN;

CREATE TABLE IF NOT EXISTS client_events (
  id BIGSERIAL PRIMARY KEY,
  session_id TEXT,
  user_id INTEGER,
  kind TEXT NOT NULL,
  detail JSONB,
  user_agent TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_client_events_kind_created
  ON client_events (kind, created_at);

COMMENT ON TABLE client_events IS 'Browser-reported failures (error beacon); allowlisted kinds only, no free-form content';
COMMENT ON COLUMN client_events.kind IS 'Allowlisted event kind (js_error, webrtc_failed, mic_permission_denied, ...)';

COMMIT;
