-- Migration 096: de-identified admin usage telemetry.
-- Date: 2026-09-09
--
-- Product-UX telemetry for the admin app (Nathan decision 2026-09-09):
-- aggressive on usage patterns, structurally incapable of profiling a
-- specific staff member. The de-identification is enforced by SCHEMA, not
-- policy: no user_id, no username, no IP, no user agent. usage_session_id
-- is a random per-tab-load id, so flows within one sitting can be sequenced
-- but sittings cannot be joined into a per-person history. Event payloads
-- carry view/overlay names and templated API paths only — never participant,
-- session, or user identifiers.
--
-- This is deliberately SEPARATE from data_access_log (091), which is
-- identified BY DESIGN for accountability. Different tables, different
-- purposes; do not join them.

BEGIN;

CREATE TABLE IF NOT EXISTS admin_usage_events (
  id BIGSERIAL PRIMARY KEY,
  usage_session_id TEXT NOT NULL,
  seq INTEGER,
  role TEXT,
  kind TEXT NOT NULL,
  detail JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_admin_usage_events_kind_created
  ON admin_usage_events (kind, created_at);
CREATE INDEX IF NOT EXISTS idx_admin_usage_events_session_seq
  ON admin_usage_events (usage_session_id, seq);

COMMENT ON TABLE admin_usage_events IS 'De-identified admin-app usage telemetry: no user identity columns by design; usage_session_id rotates per tab load';
COMMENT ON COLUMN admin_usage_events.role IS 'Coarse role cohort only (therapist/researcher/caseworker); never a user reference';
COMMENT ON COLUMN admin_usage_events.detail IS 'View/overlay names, templated API paths, durations, error text — resource ids are stripped client- and server-side';

-- Gate flag. Staff-facing product telemetry, so unlike the participant
-- streams (095) it defaults ON; the toggle exists for consistency and for
-- turning it off without a deploy.
UPDATE system_config
SET config_value = jsonb_build_object(
      'telemetry_admin_usage', COALESCE(config_value->'telemetry_admin_usage', 'true'::jsonb)
    ) || config_value
WHERE config_key = 'features';

COMMIT;
