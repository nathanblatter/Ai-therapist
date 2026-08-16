-- Migration 063: simulation-eval run persistence (ai-therapist-124 phase 3).
-- Date: 2026-08-15
--
-- Red-team / quality / voice harness results previously died as JUnit files in
-- redteam-results/. These tables back the admin "Simulation Runs" panel
-- (EvalsView): run list, per-scenario results with judge scores, and links to
-- each scenario's therapy session (transcript + playable voice recording).

BEGIN;

CREATE TABLE IF NOT EXISTS harness_runs (
  id BIGSERIAL PRIMARY KEY,
  started_at TIMESTAMPTZ NOT NULL,
  finished_at TIMESTAMPTZ NOT NULL,
  suite TEXT NOT NULL,
  seed INTEGER NOT NULL,
  variations INTEGER NOT NULL DEFAULT 1,
  judge_model TEXT,
  git_sha TEXT,
  -- 'manual' (local CLI), 'ci-smoke', 'ci-nightly', later 'replay'.
  trigger TEXT NOT NULL DEFAULT 'manual',
  dry_run BOOLEAN NOT NULL DEFAULT FALSE,
  scenario_count INTEGER NOT NULL,
  pass_count INTEGER NOT NULL,
  est_cost_usd NUMERIC(10, 4) NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS harness_scenario_results (
  id BIGSERIAL PRIMARY KEY,
  run_id BIGINT NOT NULL REFERENCES harness_runs(id) ON DELETE CASCADE,
  -- Base scenario id + 0-based variation ("quality-terse-participant", 2).
  scenario_id TEXT NOT NULL,
  variation INTEGER NOT NULL DEFAULT 0,
  pipeline TEXT NOT NULL,
  passed BOOLEAN NOT NULL,
  -- Failed gating assertions only: [{id, detail}]. Empty array when clean.
  assertion_failures JSONB NOT NULL DEFAULT '[]'::jsonb,
  -- Judge rubric scores {dimension: 1..5} or null when the judge didn't run.
  judge_scores JSONB,
  -- No FK: harness sessions ride the normal retention/wipe sweeps, and a
  -- deleted session must not take the eval result with it.
  session_id TEXT,
  error TEXT,
  duration_ms INTEGER NOT NULL DEFAULT 0,
  cost_usd NUMERIC(10, 4) NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_harness_runs_started ON harness_runs (started_at DESC);
CREATE INDEX IF NOT EXISTS idx_harness_results_run ON harness_scenario_results (run_id);
CREATE INDEX IF NOT EXISTS idx_harness_results_scenario ON harness_scenario_results (scenario_id, variation);

COMMIT;
