-- Migration 053 (ai-therapist-97 + ai-therapist-98):
--   1. data_deletion_log -- auditable record of every retention-driven deletion
--      (mirrors content_wipe_log from migration 020).
--   2. protocol_deviations -- study-ops deviation log (manual CRUD + auto-flags).
--   3. system_config seeds: data_retention, study_protocol.

-- 1. Auditable deletion log. One row per deleted artifact (recording object,
-- session row set, user row), grouped by run_id per enforcement pass.
CREATE TABLE IF NOT EXISTS data_deletion_log (
    deletion_id   BIGSERIAL PRIMARY KEY,
    run_id        UUID NOT NULL,
    executed_at   TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    artifact_type VARCHAR(30) NOT NULL CHECK (artifact_type IN (
                    'recording_object',      -- MinIO WAV deleted + recording_* columns nulled
                    'session_content',       -- messages.content_redacted etc. hard-deleted
                    'user_account'           -- wiped-user hard delete after grace
                  )),
    -- What was deleted, WITHOUT PII: object key, session pseudonym or raw
    -- session_id (session_id is not PII), userid (numeric).
    artifact_ref  TEXT NOT NULL,
    session_id    TEXT,          -- no FK: row may outlive the session
    user_id       INTEGER,       -- no FK: row may outlive the user
    reason        VARCHAR(50) NOT NULL CHECK (reason IN (
                    'recording_retention', 'wiped_user_grace', 'manual_admin')),
    policy_snapshot JSONB NOT NULL,  -- the data_retention config at run time
    triggered_by  VARCHAR(50) NOT NULL CHECK (triggered_by IN ('scheduler', 'manual')),
    triggered_by_user VARCHAR(255),
    success       BOOLEAN NOT NULL DEFAULT TRUE,
    error_message TEXT
);

CREATE INDEX IF NOT EXISTS idx_data_deletion_log_run ON data_deletion_log(run_id);
CREATE INDEX IF NOT EXISTS idx_data_deletion_log_time ON data_deletion_log(executed_at DESC);

COMMENT ON TABLE data_deletion_log IS
  'ai-therapist-97: audit trail of retention-driven deletions (recordings, wiped users). Mirrors content_wipe_log.';

-- 2. Protocol deviation log (ai-therapist-98). Manual entries by researchers
-- plus rows auto-inserted by the anomaly scan (source = 'auto').
CREATE TABLE IF NOT EXISTS protocol_deviations (
    deviation_id  SERIAL PRIMARY KEY,
    occurred_at   TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    source        VARCHAR(10) NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'auto')),
    category      VARCHAR(40) NOT NULL CHECK (category IN (
                    'config_change_mid_study',  -- auto: system_config/model/prompt changed inside study window
                    'arm_imbalance',            -- auto: proactive_offering arms drifted past threshold
                    'session_limit_exceeded',   -- auto: participant exceeded protocol session count
                    'consent_version_change',   -- auto: >1 consent_version among in-study consents
                    'technical_failure',        -- manual
                    'enrollment', 'procedure', 'other')),   -- manual
    severity      VARCHAR(10) NOT NULL DEFAULT 'minor' CHECK (severity IN ('minor', 'major')),
    session_id    TEXT REFERENCES therapy_sessions(session_id) ON DELETE SET NULL,
    -- Free text written by researchers: must not contain participant PII by
    -- convention (surfaced in the UI as a reminder).
    description   TEXT NOT NULL,
    -- Auto rows: machine details (e.g. {"config_key":"ai_model","old":...,"new":...}).
    details       JSONB,
    -- Dedup key for auto-flagged anomalies so the scan is idempotent.
    auto_key      TEXT UNIQUE,
    status        VARCHAR(15) NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'acknowledged', 'resolved', 'dismissed')),
    created_by    VARCHAR(255),         -- admin username; 'system' for auto
    resolved_by   VARCHAR(255),
    resolved_at   TIMESTAMPTZ,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_protocol_deviations_status ON protocol_deviations(status, occurred_at DESC);

COMMENT ON TABLE protocol_deviations IS
  'ai-therapist-98: study protocol deviation log -- manual researcher entries + idempotent auto-flagged anomalies (auto_key dedups).';

-- 3. Config seeds.
INSERT INTO system_config (config_key, config_value, description) VALUES
(
    'data_retention',
    '{
        "enabled": false,
        "recordings_retention_days": 90,
        "wiped_user_grace_days": 14,
        "run_time": "03:30",
        "last_run_at": null,
        "last_run_deletions": 0
    }'::jsonb,
    'ai-therapist-97: retention windows enforced nightly by dataRetention.service (recordings age-out; wiped-user grace). Ships disabled; enable deliberately.'
),
(
    'study_protocol',
    '{
        "enrollment_target": 40,
        "expected_sessions_per_participant": 4,
        "study_start": null,
        "study_end": null,
        "arm_imbalance_threshold": 0.15
    }'::jsonb,
    'ai-therapist-98: study-ops dashboard targets -- enrollment target, per-participant session expectation, study window (ISO dates), allowed proactive_offering arm imbalance fraction.'
)
ON CONFLICT (config_key) DO NOTHING;
