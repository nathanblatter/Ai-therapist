-- Migration 126: config_evaluations (red-team runs tied to a configuration).
-- Date: 2026-11-18
--
-- The IRB red-team attachment promises the suite is re-run on any prompt or
-- model change. Prompts and model settings live in system_config and are
-- edited in the admin UI without a deploy, so the deploy-gated smoke suite
-- never sees them. This table records which "evaluated configuration"
-- (src/server/utils/evaluatedConfig.ts: the system_config subset that changes
-- what the AI says or which model says it) a red-team run evaluated, keyed by
-- the sha256 fingerprint of that subset.
--
-- When the environment's current fingerprint has no row with status 'passed',
-- the System Config and System Prompts admin screens show a drift notice.
-- Nothing here blocks a config save or a session.
--
-- Rows are written by the redteam-config workflow through the token-gated
-- /api/redteam/config-eval endpoints: a 'running' row when it claims a
-- fingerprint, then passed/failed/error with totals when the run finishes.
-- Holds aggregates and a link to the CI run only: no transcript text, no
-- participant identifiers. config_changed_by is a staff username copied from
-- system_config.updated_by (the existing config audit columns).
BEGIN;

CREATE TABLE IF NOT EXISTS config_evaluations (
  id                  BIGSERIAL PRIMARY KEY,
  fingerprint         TEXT NOT NULL CHECK (fingerprint ~ '^[0-9a-f]{64}$'),
  config_version      INTEGER NOT NULL,
  suite               TEXT NOT NULL,
  status              TEXT NOT NULL DEFAULT 'running'
                        CHECK (status IN ('running', 'passed', 'failed', 'error')),
  git_sha             TEXT,
  started_at          TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  finished_at         TIMESTAMPTZ,
  scenarios_total     INTEGER,
  scenarios_passed    INTEGER,
  scenarios_failed    INTEGER,
  -- Non-gating assertion failures (tracked known gaps) across the run.
  known_gaps          INTEGER,
  est_cost_usd        NUMERIC(10, 4),
  -- Where the full results live (the GitHub Actions run with the artifact).
  result_url          TEXT,
  -- Who or what started it: 'github-actions:schedule', 'github-actions:workflow_dispatch:<actor>', ...
  triggered_by        TEXT NOT NULL,
  -- Provenance of the configuration at claim time (latest edit to an evaluated key).
  config_changed_at   TIMESTAMPTZ,
  config_changed_by   TEXT,
  error               TEXT
);

CREATE INDEX IF NOT EXISTS idx_config_evaluations_fingerprint
  ON config_evaluations (fingerprint, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_config_evaluations_started
  ON config_evaluations (started_at DESC);

COMMENT ON TABLE config_evaluations IS
  'Red-team runs against an environment''s evaluated system_config subset, keyed by fingerprint; drives the admin drift notice. Aggregates only.';
COMMENT ON COLUMN config_evaluations.fingerprint IS
  'sha256 of the canonicalised evaluated configuration (src/server/utils/evaluatedConfig.ts)';

COMMIT;
