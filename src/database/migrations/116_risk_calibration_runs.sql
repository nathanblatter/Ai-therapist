-- Migration 116 (eval program WP3, ai-therapist-175 / gap G3): risk-score
-- calibration runs.
-- Date: 2026-10-23
--
-- One row per calibration run of the crisis risk-score pipeline
-- (riskCalibration.service.ts / runRiskCalibration.ts). A run joins
-- risk_score_history x crisis_events x crisis_event_adjudications, scores
-- every signal layer (keyword tier, LLM assessor, moderation categories,
-- trajectory bonus, composite) against the adjudicated ground truth, and
-- re-scores a stratified sample of unflagged messages offline for a miss-rate
-- estimate. `report` holds only aggregates (counts, rates, kappas, thresholds)
-- and the sampled message ids of the miss-rate sample: never transcript text,
-- participant identifiers or usernames.
--
-- recommended_thresholds is ADVISORY ONLY. Nothing reads it back into the live
-- pipeline; threshold changes remain a human decision made in code.
BEGIN;

CREATE TABLE IF NOT EXISTS risk_calibration_runs (
  run_id                  BIGSERIAL PRIMARY KEY,
  org_id                  INTEGER NOT NULL REFERENCES organizations(org_id) ON DELETE CASCADE,
  started_at              TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  finished_at             TIMESTAMPTZ,
  params                  JSONB NOT NULL,
  report                  JSONB NOT NULL,
  recommended_thresholds  JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_by              TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_risk_calibration_runs_org_started
  ON risk_calibration_runs (org_id, started_at DESC);

COMMENT ON TABLE risk_calibration_runs IS
  'Risk-score calibration reports per org (eval program WP3); aggregates only, recommendations advisory';
COMMENT ON COLUMN risk_calibration_runs.recommended_thresholds IS
  'Per-layer F1-maximising thresholds from the labelled sample; ADVISORY - never applied automatically';

COMMIT;
