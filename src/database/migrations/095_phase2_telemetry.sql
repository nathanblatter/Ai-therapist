-- Migration 095: Phase 2 research telemetry (flag-gated, default OFF).
-- Date: 2026-09-09
--
-- Implements the telemetry streams declared in the Phase 2 IRB application
-- draft (docs/irb-phase2-longitudinal-application.md, Data Collection):
-- participant-side interaction timing, interface engagement events, and
-- derived acoustic features from the participant-only recording track.
--
-- IRB CONSTRAINT: Phase 2 is NOT approved yet. Every stream is gated behind
-- a system_config features flag seeded false here and enforced SERVER-SIDE
-- at the ingest route / extraction job; none may be enabled until the
-- approved protocol authorizes it. Phase 1 (2025-519) authorizes chat text
-- and timestamps only.

BEGIN;

-- Client-reported engagement events (batched beacon, allowlisted kinds).
-- Mirrors client_events (059): loose session/user references, JSONB detail
-- capped at the route, no free-form content.
CREATE TABLE IF NOT EXISTS engagement_events (
  id BIGSERIAL PRIMARY KEY,
  session_id TEXT,
  user_id INTEGER,
  kind TEXT NOT NULL,
  detail JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_engagement_events_kind_created
  ON engagement_events (kind, created_at);
CREATE INDEX IF NOT EXISTS idx_engagement_events_session
  ON engagement_events (session_id);

COMMENT ON TABLE engagement_events IS 'Phase 2 engagement telemetry (allowlisted kinds, flag-gated, default off); no conversation content';
COMMENT ON COLUMN engagement_events.kind IS 'Allowlisted event kind (turn_timing, visibility_change, scroll_back, tool_open, checkin_skip, ...)';

-- Derived acoustic features from the participant-only track (migration 086).
-- Computed post-session by acousticFeatures.service when the flag is on;
-- holds only derived numeric measures, never audio.
CREATE TABLE IF NOT EXISTS session_acoustic_features (
  session_id TEXT PRIMARY KEY REFERENCES therapy_sessions(session_id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'complete',
  features JSONB,
  computed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE session_acoustic_features IS 'Derived acoustic measures (pitch, energy, pauses) from participant track; flag-gated, default off';

-- Seed the three gate flags into the features config row, default false,
-- without clobbering values that already exist.
UPDATE system_config
SET config_value = jsonb_build_object(
      'telemetry_interaction_timing', COALESCE(config_value->'telemetry_interaction_timing', 'false'::jsonb),
      'telemetry_engagement_events',  COALESCE(config_value->'telemetry_engagement_events',  'false'::jsonb),
      'telemetry_acoustic_features',  COALESCE(config_value->'telemetry_acoustic_features',  'false'::jsonb)
    ) || config_value
WHERE config_key = 'features';

-- Session-rhythm view (habit metrics: inter-session gaps, duration, start
-- hour). Purely derived from timestamps therapy_sessions already stores —
-- creates no new collection, so it is not flag-gated.
CREATE OR REPLACE VIEW participant_session_rhythm AS
SELECT
  user_id,
  session_id,
  created_at AS started_at,
  ended_at,
  EXTRACT(EPOCH FROM (ended_at - created_at)) AS duration_seconds,
  EXTRACT(EPOCH FROM (created_at - LAG(ended_at) OVER (PARTITION BY user_id ORDER BY created_at))) AS seconds_since_prev_session,
  EXTRACT(HOUR FROM created_at)::int AS start_hour
FROM therapy_sessions
WHERE user_id IS NOT NULL;

COMMIT;
