-- Migration 114 (eval program WP2, ai-therapist-196 / gap G2): the human
-- ground-truth engine.
-- Date: 2026-10-23
--
-- 1. eval_rating_queue: sessions sampled for human rating (stratified by
--    modality x risk band x ISO week, crisis-adjacent oversampled) or pushed
--    in from the judge-disagreement list / by hand. One row per session; a
--    configurable fraction is marked for a second rater so human-human kappa
--    can be reported next to human-judge kappa.
-- 2. crisis_event_adjudications: one verdict per (crisis event, adjudicator)
--    - confirmed | false_positive | unclear - the lightweight replacement for
--    the clinical_reviews table dropped in 035 and the ground truth WP3's
--    risk-score calibration joins on.
-- 3. system_config.evals.rating_second_rater_fraction (default 0.2), merged
--    into the row 110 seeded (or that predates 110) without touching any
--    other key; absent-row insert is ON CONFLICT-safe.
BEGIN;

CREATE TABLE IF NOT EXISTS eval_rating_queue (
    queue_id            BIGSERIAL PRIMARY KEY,
    session_id          TEXT NOT NULL REFERENCES therapy_sessions(session_id) ON DELETE CASCADE,
    -- "<modality>|<risk band>|<ISO week>", e.g. "voice|high|2026-W42".
    stratum             TEXT NOT NULL,
    source              TEXT NOT NULL CHECK (source IN ('stratified', 'disagreement', 'manual')),
    status              TEXT NOT NULL DEFAULT 'queued'
                        CHECK (status IN ('queued', 'in_progress', 'rated', 'skipped')),
    assigned_to         INTEGER REFERENCES users(userid) ON DELETE SET NULL,
    second_rater_id     INTEGER REFERENCES users(userid) ON DELETE SET NULL,
    -- Sampler decision: this session needs two independent ratings.
    needs_second_rater  BOOLEAN NOT NULL DEFAULT FALSE,
    crisis_adjacent     BOOLEAN NOT NULL DEFAULT FALSE,
    enqueued_at         TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    enqueued_by         INTEGER REFERENCES users(userid) ON DELETE SET NULL,
    claimed_at          TIMESTAMPTZ,
    rated_at            TIMESTAMPTZ,
    skipped_at          TIMESTAMPTZ,
    skipped_by          INTEGER REFERENCES users(userid) ON DELETE SET NULL,
    UNIQUE (session_id)
);

CREATE INDEX IF NOT EXISTS idx_eval_rating_queue_status
    ON eval_rating_queue(status, enqueued_at);
CREATE INDEX IF NOT EXISTS idx_eval_rating_queue_assigned
    ON eval_rating_queue(assigned_to);
CREATE INDEX IF NOT EXISTS idx_eval_rating_queue_second_rater
    ON eval_rating_queue(second_rater_id);

COMMENT ON TABLE eval_rating_queue IS
    'Sessions queued for blind human rating on the eval rubric; one row per session (eval program WP2)';
COMMENT ON COLUMN eval_rating_queue.stratum IS
    'modality|risk_band|ISO-week the sampler placed the session in (ratingSampler.service)';
COMMENT ON COLUMN eval_rating_queue.needs_second_rater IS
    'Sampler marked this session for two independent raters (evals.rating_second_rater_fraction)';
COMMENT ON COLUMN eval_rating_queue.status IS
    'queued -> in_progress (claimed) -> rated (every required rater submitted) | skipped';

CREATE TABLE IF NOT EXISTS crisis_event_adjudications (
    adjudication_id  BIGSERIAL PRIMARY KEY,
    crisis_event_id  BIGINT NOT NULL REFERENCES crisis_events(event_id) ON DELETE CASCADE,
    adjudicator_id   INTEGER NOT NULL REFERENCES users(userid) ON DELETE CASCADE,
    verdict          TEXT NOT NULL CHECK (verdict IN ('confirmed', 'false_positive', 'unclear')),
    note             TEXT,
    adjudicated_at   TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (crisis_event_id, adjudicator_id)
);

CREATE INDEX IF NOT EXISTS idx_crisis_event_adjudications_event
    ON crisis_event_adjudications(crisis_event_id);

COMMENT ON TABLE crisis_event_adjudications IS
    'Human verdict per crisis event per adjudicator: confirmed | false_positive | unclear (eval program WP2; WP3 ground truth)';
COMMENT ON COLUMN crisis_event_adjudications.note IS
    'Free text for the adjudicator; never exported (dataset export emits the verdict only)';

-- Config: merge the new key into the existing evals blob (110 seeded it with
-- ON CONFLICT DO NOTHING, and stage/prod rows that predate 110 hold only
-- harness_schedule), then insert the full default when no row exists at all.
UPDATE system_config
   SET config_value = config_value || '{"rating_second_rater_fraction": 0.2}'::jsonb
 WHERE config_key = 'evals'
   AND NOT (config_value ? 'rating_second_rater_fraction');

INSERT INTO system_config (config_key, config_value, description) VALUES (
    'evals',
    '{"auto_run_enabled": false, "judge_model": "gpt-4o-mini", "judge_models": ["gpt-4o-mini", "gpt-5-mini"], "self_consistency_runs": 1, "drift_window": 20, "drift_baseline": 100, "drift_threshold": 0.5, "drift_min_window": 10, "drift_page_enabled": false, "harness_schedule": {"enabled": false, "suite": "voice", "hour_utc": 9, "variations": 1}, "rating_second_rater_fraction": 0.2}'::jsonb,
    'Eval-system settings (drift monitoring, harness schedule): LLM-judge ensemble and auto-run gate (sessionEval, pairwiseEval), drift detector thresholds (evalDrift), nightly red-team harness schedule (harnessRunner), rating_second_rater_fraction for the human rating queue (ratingSampler)'
)
ON CONFLICT (config_key) DO NOTHING;

COMMIT;
