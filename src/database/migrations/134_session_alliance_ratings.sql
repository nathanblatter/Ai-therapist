-- Migration 134: linguistic working-alliance markers (ai-therapist-173).
-- Date: 2026-11-26
--
-- One row per (session, judge version): the Task / Bond / Goal ratings the
-- alliance judge (src/server/services/allianceMarkers.ts) gives a finished
-- session from its REDACTED transcript. A behavioural measure of the three
-- constructs the weekly WAI-SR self-report measures, to be compared with it
-- later (docs/alliance-markers-2026-11-26.md).
--
-- Holds numbers only: no transcript text, no rationale (the judge generates
-- none). Follows the other per-session derived tables (session_evals 034,
-- session_eval_judges 107, session_acoustic_features 095): the row belongs to
-- the session and goes when the session goes (ON DELETE CASCADE), which is
-- how session deletion and demo cleanup already reach those tables. Like
-- them, it has no rule of its own for withdrawal or account deletion: a
-- withdrawal stamps users.study_status and deletes nothing, and deleting an
-- account sets therapy_sessions.user_id to NULL, so the session and its
-- derived rows stay, no longer linked to a person. Organisation and caseload
-- scoping come from the session it joins.
--
-- "Not rateable" is its own outcome. A subscale the judge cannot rate has
-- <subscale>_rateable = FALSE and NULL score columns, never a low score. A
-- session under the length floor is status 'too_short' (no model call); a
-- judge call that failed is status 'errored' with every rating column NULL.
--
-- The job that writes this table is OFF unless system_config.alliance_markers
-- has enabled = true. The row is seeded disabled here.

BEGIN;

CREATE TABLE IF NOT EXISTS session_alliance_ratings (
    rating_id           BIGSERIAL PRIMARY KEY,
    session_id          TEXT NOT NULL REFERENCES therapy_sessions(session_id) ON DELETE CASCADE,
    -- ALLIANCE_JUDGE_VERSION at rating time; bumped whenever the rubric changes.
    judge_version       TEXT NOT NULL,
    status              TEXT NOT NULL CHECK (status IN ('rated', 'too_short', 'errored')),

    -- Per subscale: can it be rated, the probability behind that flag, the
    -- probability-weighted mean level (1..5), the most probable level, its
    -- probability, and the probability of each level (JSON array, weakest first).
    task_rateable       BOOLEAN,
    task_p_rateable     REAL,
    task_score          REAL,
    task_level          SMALLINT,
    task_confidence     REAL,
    task_distribution   JSONB,
    bond_rateable       BOOLEAN,
    bond_p_rateable     REAL,
    bond_score          REAL,
    bond_level          SMALLINT,
    bond_confidence     REAL,
    bond_distribution   JSONB,
    goal_rateable       BOOLEAN,
    goal_p_rateable     REAL,
    goal_score          REAL,
    goal_level          SMALLINT,
    goal_confidence     REAL,
    goal_distribution   JSONB,

    -- What the judge was given (counts only).
    participant_turns   INTEGER,
    participant_words   INTEGER,
    transcript_chars    INTEGER,
    transcript_truncated BOOLEAN NOT NULL DEFAULT FALSE,

    model               TEXT,
    tokens_in           INTEGER,
    tokens_out          INTEGER,
    -- Set only when status = 'errored'. An error message, never transcript text.
    error               TEXT,
    rated_at            TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    UNIQUE (session_id, judge_version),
    CHECK (task_level IS NULL OR task_level BETWEEN 1 AND 5),
    CHECK (bond_level IS NULL OR bond_level BETWEEN 1 AND 5),
    CHECK (goal_level IS NULL OR goal_level BETWEEN 1 AND 5),
    -- A score exists only for a subscale that was rateable.
    CHECK (task_score IS NULL OR task_rateable IS TRUE),
    CHECK (bond_score IS NULL OR bond_rateable IS TRUE),
    CHECK (goal_score IS NULL OR goal_rateable IS TRUE)
);

CREATE INDEX IF NOT EXISTS idx_session_alliance_ratings_version_status
    ON session_alliance_ratings (judge_version, status);

COMMENT ON TABLE session_alliance_ratings IS
    'Task / Bond / Goal working-alliance ratings of a finished session, judged from the redacted transcript (ai-therapist-173). Numbers only; no transcript text.';
COMMENT ON COLUMN session_alliance_ratings.status IS
    'rated (the judge answered; see the per-subscale rateable flags) | too_short (under the length floor, no model call) | errored (no answer; unknown, not a low score)';

-- The switch, seeded OFF. Never overwrites an existing row.
INSERT INTO system_config (config_key, config_value, description) VALUES
(
    'alliance_markers',
    '{"enabled": false}'::jsonb,
    'Linguistic working-alliance markers (ai-therapist-173): when enabled, each finished session is rated on Task / Bond / Goal from its redacted transcript once redaction is complete (allianceRating.service). Default off.'
)
ON CONFLICT (config_key) DO NOTHING;

COMMIT;
