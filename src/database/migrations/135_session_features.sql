-- Migration 135: structured per-session features (ai-therapist-172).
-- Date: 2026-11-27
--
-- One row per (session, feature-set version): what the session-features
-- judge (src/server/services/sessionFeatures.ts) coded a finished session as,
-- from its REDACTED transcript: topics, coping strategies, help-seeking,
-- follow-through on between-session work, rupture and repair, reported
-- change. Per-week covariates for the Phase 2 mixed-effects models
-- (docs/session-features-2026-11-27.md).
--
-- Storage shape: the variables are ONE JSON object per row (`features`),
-- keyed by variable name, not one column per variable. The codebook is
-- expected to change (variables added, reworded, retired) and each change is
-- a new feature_set_version; with a column per variable every such change
-- would be a migration and old rows would carry NULLs that cannot be told
-- apart from "not asked". The export turns the object into one column per
-- variable, so analysts never read the JSON. No generated columns and no GIN
-- index: nothing in the app filters by a single variable, the export reads
-- whole rows, and the table is one row per session (thousands, not millions).
--
-- Each entry of `features` is one of (sessionFeatures.ts, FeatureValue):
--   {"kind": "predicate", "p": 0.93, "present": true | false | null}
--   {"kind": "choice", "value": "completed" | null, "confidence": 0.81, "p": {"completed": 0.81, ...}}
--   {"kind": "unknown", "reason": "refused" | "missing" | "malformed"}
-- A null `present` or `value` is "uncertain" (the probability did not clear
-- the threshold either way); "unknown" is a variable the model gave no usable
-- answer for. Neither is ever stored as false, zero or the first option.
--
-- Holds numbers, booleans and codebook option names only: no transcript text,
-- no rationale (the judge generates none). transcript_fingerprint is an MD5
-- digest over the ids and redacted text of the messages the judge was given,
-- kept so a row can be told apart from the session's transcript as it is now
-- ("stale"); it is a digest of the whole transcript, not text.
--
-- Foreign key and deletion exactly as session_alliance_ratings (134) and the
-- other per-session derived tables (034, 095, 107): the row belongs to the
-- session and goes when the session goes (ON DELETE CASCADE), which is how
-- session deletion and demo cleanup already reach those tables. Organisation
-- and caseload scoping come from the session it joins.
--
-- Who is coded is decided by the job, not this table
-- (JUDGE_ELIGIBLE_SESSION_SQL in src/server/db/sessionJudge.queries.ts, the
-- same rule as the alliance ratings): only ended sessions of enrolled study
-- participants. A withdrawal stamps users.study_status and deletes nothing: a
-- row stored before the withdrawal stays, and the session is not coded again.
--
-- Statuses, each held to one shape by the CHECK constraints below:
--   extracted  the judge answered: `features` is a non-empty JSON object;
--   too_short  under the length floor, no model call: no features at all
--              (NULL, not a row of "absent");
--   errored    the call failed or nothing in the answer was usable: no
--              features, and the error text. Unknown, never "absent".
--
-- The job that writes this table is OFF unless system_config.session_features
-- has enabled = true. The row is seeded disabled here.

BEGIN;

CREATE TABLE IF NOT EXISTS session_features (
    feature_row_id      BIGSERIAL PRIMARY KEY,
    session_id          TEXT NOT NULL REFERENCES therapy_sessions(session_id) ON DELETE CASCADE,
    -- SESSION_FEATURE_SET_VERSION at extraction time; bumped whenever the
    -- codebook changes.
    feature_set_version TEXT NOT NULL,
    status              TEXT NOT NULL CHECK (status IN ('extracted', 'too_short', 'errored')),

    -- Variable name -> answer (see the header). NULL unless status = 'extracted'.
    features            JSONB,
    -- How many variables of this row are {"kind": "unknown"}.
    unknown_count       INTEGER,

    -- What the judge was given (counts and a digest only).
    participant_turns   INTEGER,
    participant_words   INTEGER,
    transcript_chars    INTEGER,
    transcript_truncated BOOLEAN NOT NULL DEFAULT FALSE,
    -- Messages the judge was given (both speakers), and the MD5 digest of
    -- their ids and redacted text in order ('empty' for none). Compared with
    -- the session's transcript as it is now to tell a stale row.
    transcript_messages INTEGER NOT NULL CHECK (transcript_messages >= 0),
    transcript_fingerprint TEXT NOT NULL,

    model               TEXT,
    tokens_in           INTEGER,
    tokens_out          INTEGER,
    -- Set when, and only when, status = 'errored'. An error message, never
    -- transcript text.
    error               TEXT,
    extracted_at        TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    UNIQUE (session_id, feature_set_version),
    -- Each status has one shape (see the header).
    CONSTRAINT session_features_status_shape CHECK (
        (status = 'extracted'
            AND features IS NOT NULL
            AND unknown_count IS NOT NULL AND unknown_count >= 0
            AND model IS NOT NULL)
        OR (status = 'too_short'
            AND features IS NULL AND unknown_count IS NULL
            AND model IS NULL AND tokens_in IS NULL AND tokens_out IS NULL)
        OR (status = 'errored'
            AND features IS NULL AND unknown_count IS NULL)
    ),
    -- The features are a non-empty object of variables.
    CONSTRAINT session_features_object CHECK (
        features IS NULL
        OR CASE WHEN jsonb_typeof(features) = 'object' THEN features <> '{}'::jsonb ELSE FALSE END
    ),
    CONSTRAINT session_features_error_only_when_errored CHECK ((status = 'errored') = (error IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS idx_session_features_version_status
    ON session_features (feature_set_version, status);

COMMENT ON TABLE session_features IS
    'Per-session coded variables (topics, coping, help-seeking, follow-through, rupture and repair, reported change), judged from the redacted transcript (ai-therapist-172). Probabilities, booleans and codebook option names only; no transcript text.';
COMMENT ON COLUMN session_features.status IS
    'extracted (the judge answered; see features) | too_short (under the length floor, no model call, no features) | errored (no answer; unknown, never "absent")';
COMMENT ON COLUMN session_features.features IS
    'JSON object: variable name -> {kind: predicate, p, present} | {kind: choice, value, confidence, p} | {kind: unknown, reason}. A null present/value is "uncertain"; unknown is "no usable answer". Neither means absent.';
COMMENT ON COLUMN session_features.transcript_fingerprint IS
    'MD5 digest over the ids and redacted text of the messages the judge was given. A row whose digest differs from the session''s readable transcript now is stale.';

-- The switch, seeded OFF. Never overwrites an existing row.
INSERT INTO system_config (config_key, config_value, description) VALUES
(
    'session_features',
    '{"enabled": false}'::jsonb,
    'Structured per-session features (ai-therapist-172): when enabled, each finished session of an enrolled participant is coded on the session-features codebook from its redacted transcript once redaction and its leak check are complete (sessionFeatures.service). Default off.'
)
ON CONFLICT (config_key) DO NOTHING;

COMMIT;
