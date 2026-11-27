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
-- none). transcript_fingerprint is an MD5 digest over the ids and redacted
-- text of the messages the judge was given, kept so a rating can be told
-- apart from the session's transcript as it is now ("stale", see below); it
-- is a digest of the whole transcript, not text.
--
-- Follows the other per-session derived tables (session_evals 034,
-- session_eval_judges 107, session_acoustic_features 095): the row belongs to
-- the session and goes when the session goes (ON DELETE CASCADE), which is
-- how session deletion and demo cleanup already reach those tables.
-- Organisation and caseload scoping come from the session it joins.
--
-- Who is rated is decided by the job, not this table
-- (ALLIANCE_ELIGIBLE_SESSION_SQL in src/server/db/allianceRatings.queries.ts):
-- only ended sessions of enrolled study participants (a participant account
-- that is not sandbox and has not withdrawn). Sessions of staff accounts,
-- anonymous sessions and sessions of a withdrawn participant are never
-- rated. A withdrawal stamps users.study_status and deletes nothing: a
-- rating stored before the withdrawal stays, like every other derived row,
-- and the session is not rated again.
--
-- "Not rateable" is its own outcome. A subscale the judge cannot rate has
-- <subscale>_rateable = FALSE and NULL score columns, never a low score. A
-- session under the length floor is status 'too_short' (no model call, so no
-- probabilities either); a judge call that failed is status 'errored' with
-- every rating column NULL. The CHECK constraints below hold each status to
-- that shape.
--
-- Stale: a rating describes the transcript the judge was given. When the
-- session's readable transcript changes afterwards (a late message is
-- redacted, a message is re-redacted or corrected, a leak review releases or
-- withholds a message) the stored fingerprint no longer matches and the row
-- is stale until the job rates the session again (same judge version, the
-- row is replaced).
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

    -- Per subscale: can it be rated, the probability behind that flag (0..1),
    -- the probability-weighted mean level (1..5), the most probable level
    -- (1..5), its probability (0..1), and the probability of each level (JSON
    -- array of five, weakest first).
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

    -- What the judge was given (counts and a digest only).
    participant_turns   INTEGER,
    participant_words   INTEGER,
    transcript_chars    INTEGER,
    transcript_truncated BOOLEAN NOT NULL DEFAULT FALSE,
    -- Messages the judge was given (both speakers), and the MD5 digest of
    -- their ids and redacted text in order ('empty' for none). Compared with
    -- the session's transcript as it is now to tell a stale rating.
    transcript_messages INTEGER NOT NULL CHECK (transcript_messages >= 0),
    transcript_fingerprint TEXT NOT NULL,

    model               TEXT,
    tokens_in           INTEGER,
    tokens_out          INTEGER,
    -- Set when, and only when, status = 'errored'. An error message, never
    -- transcript text.
    error               TEXT,
    rated_at            TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    UNIQUE (session_id, judge_version),
    CONSTRAINT alliance_task_ranges CHECK (
        (task_p_rateable IS NULL OR task_p_rateable BETWEEN 0 AND 1)
        AND (task_score IS NULL OR task_score BETWEEN 1 AND 5)
        AND (task_level IS NULL OR task_level BETWEEN 1 AND 5)
        AND (task_confidence IS NULL OR task_confidence BETWEEN 0 AND 1)
    ),
    -- Score, level, confidence and distribution exist together, and only for
    -- a subscale that was rateable.
    CONSTRAINT alliance_task_rateable_shape CHECK (
        (task_rateable IS TRUE
            AND task_score IS NOT NULL AND task_level IS NOT NULL
            AND task_confidence IS NOT NULL AND task_distribution IS NOT NULL)
        OR (task_rateable IS NOT TRUE
            AND task_score IS NULL AND task_level IS NULL
            AND task_confidence IS NULL AND task_distribution IS NULL)
    ),
    -- The distribution is the probability of each of the five levels.
    CONSTRAINT alliance_task_distribution_shape CHECK (
        task_distribution IS NULL
        OR CASE WHEN jsonb_typeof(task_distribution) = 'array'
                THEN jsonb_array_length(task_distribution) = 5
                ELSE FALSE END
    ),
    CONSTRAINT alliance_bond_ranges CHECK (
        (bond_p_rateable IS NULL OR bond_p_rateable BETWEEN 0 AND 1)
        AND (bond_score IS NULL OR bond_score BETWEEN 1 AND 5)
        AND (bond_level IS NULL OR bond_level BETWEEN 1 AND 5)
        AND (bond_confidence IS NULL OR bond_confidence BETWEEN 0 AND 1)
    ),
    -- Score, level, confidence and distribution exist together, and only for
    -- a subscale that was rateable.
    CONSTRAINT alliance_bond_rateable_shape CHECK (
        (bond_rateable IS TRUE
            AND bond_score IS NOT NULL AND bond_level IS NOT NULL
            AND bond_confidence IS NOT NULL AND bond_distribution IS NOT NULL)
        OR (bond_rateable IS NOT TRUE
            AND bond_score IS NULL AND bond_level IS NULL
            AND bond_confidence IS NULL AND bond_distribution IS NULL)
    ),
    -- The distribution is the probability of each of the five levels.
    CONSTRAINT alliance_bond_distribution_shape CHECK (
        bond_distribution IS NULL
        OR CASE WHEN jsonb_typeof(bond_distribution) = 'array'
                THEN jsonb_array_length(bond_distribution) = 5
                ELSE FALSE END
    ),
    CONSTRAINT alliance_goal_ranges CHECK (
        (goal_p_rateable IS NULL OR goal_p_rateable BETWEEN 0 AND 1)
        AND (goal_score IS NULL OR goal_score BETWEEN 1 AND 5)
        AND (goal_level IS NULL OR goal_level BETWEEN 1 AND 5)
        AND (goal_confidence IS NULL OR goal_confidence BETWEEN 0 AND 1)
    ),
    -- Score, level, confidence and distribution exist together, and only for
    -- a subscale that was rateable.
    CONSTRAINT alliance_goal_rateable_shape CHECK (
        (goal_rateable IS TRUE
            AND goal_score IS NOT NULL AND goal_level IS NOT NULL
            AND goal_confidence IS NOT NULL AND goal_distribution IS NOT NULL)
        OR (goal_rateable IS NOT TRUE
            AND goal_score IS NULL AND goal_level IS NULL
            AND goal_confidence IS NULL AND goal_distribution IS NULL)
    ),
    -- The distribution is the probability of each of the five levels.
    CONSTRAINT alliance_goal_distribution_shape CHECK (
        goal_distribution IS NULL
        OR CASE WHEN jsonb_typeof(goal_distribution) = 'array'
                THEN jsonb_array_length(goal_distribution) = 5
                ELSE FALSE END
    ),
    -- Each status has one shape:
    --   rated      every subscale has a rateable flag and its probability;
    --   too_short  nothing is rateable and there are no probabilities (no
    --              model call was made, so none exist);
    --   errored    no flag, no probability, no score: unknown.
    CONSTRAINT alliance_status_shape CHECK (
        (status = 'rated'
            AND task_rateable IS NOT NULL AND task_p_rateable IS NOT NULL
            AND bond_rateable IS NOT NULL AND bond_p_rateable IS NOT NULL
            AND goal_rateable IS NOT NULL AND goal_p_rateable IS NOT NULL)
        OR (status = 'too_short'
            AND task_rateable IS FALSE AND task_p_rateable IS NULL
            AND bond_rateable IS FALSE AND bond_p_rateable IS NULL
            AND goal_rateable IS FALSE AND goal_p_rateable IS NULL)
        OR (status = 'errored'
            AND task_rateable IS NULL AND task_p_rateable IS NULL
            AND bond_rateable IS NULL AND bond_p_rateable IS NULL
            AND goal_rateable IS NULL AND goal_p_rateable IS NULL)
    ),
    CONSTRAINT alliance_error_only_when_errored CHECK ((status = 'errored') = (error IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS idx_session_alliance_ratings_version_status
    ON session_alliance_ratings (judge_version, status);

COMMENT ON TABLE session_alliance_ratings IS
    'Task / Bond / Goal working-alliance ratings of a finished session, judged from the redacted transcript (ai-therapist-173). Numbers only; no transcript text.';
COMMENT ON COLUMN session_alliance_ratings.status IS
    'rated (the judge answered; see the per-subscale rateable flags) | too_short (under the length floor, no model call) | errored (no answer; unknown, not a low score)';
COMMENT ON COLUMN session_alliance_ratings.transcript_fingerprint IS
    'MD5 digest over the ids and redacted text of the messages the judge was given. A row whose digest differs from the session''s readable transcript now is stale.';

-- The switch, seeded OFF. Never overwrites an existing row.
INSERT INTO system_config (config_key, config_value, description) VALUES
(
    'alliance_markers',
    '{"enabled": false}'::jsonb,
    'Linguistic working-alliance markers (ai-therapist-173): when enabled, each finished session is rated on Task / Bond / Goal from its redacted transcript once redaction is complete (allianceRating.service). Default off.'
)
ON CONFLICT (config_key) DO NOTHING;

COMMIT;
