-- ai-therapist-83 / ai-therapist-261: the shadow risk scorer's record.
--
-- One row per participant turn the shadow scorer was asked about
-- (server/services/shadowRiskScorer.service.ts): what the production crisis
-- pipeline scored for the turn at that moment, and what the OpenAI Decisions
-- API answered about the same turn. The scorer never acts on these rows and
-- nothing in the crisis pipeline reads them; they exist to be compared.
--
-- Holds NO message text: probabilities, band names, question names, token
-- counts and a short fixed-vocabulary error code only. So the nightly content
-- wipe (messages.content) has nothing to remove here.
--
-- Follows risk_score_history (migration 011) for the rest:
--   session_id  ON DELETE CASCADE   rows go when the session is deleted
--   message_id  ON DELETE SET NULL  a deleted message leaves the scores
-- and both foreign keys are indexed (migration 111's rule). There is no
-- organisation column: scope is derived from the session's owner, as it is
-- for risk_score_history.
--
-- status:
--   scored   every question was answered; shadow_severity is set
--   errored  the call failed, timed out, was dropped, or at least one
--            question was refused. "Unknown", never "none": shadow_severity
--            may still be set when the severity question itself was answered,
--            and is NOT to be read as an answer for the turn.
CREATE TABLE IF NOT EXISTS shadow_risk_scores (
  shadow_id              BIGSERIAL PRIMARY KEY,
  session_id             TEXT NOT NULL REFERENCES therapy_sessions(session_id) ON DELETE CASCADE,
  message_id             BIGINT REFERENCES messages(message_id) ON DELETE SET NULL,
  turn_source            VARCHAR(10) NOT NULL DEFAULT 'message' CHECK (turn_source IN ('message', 'checkin')),
  production_score       INTEGER NOT NULL CHECK (production_score >= 0 AND production_score <= 100),
  production_severity    VARCHAR(10) NOT NULL CHECK (production_severity IN ('none', 'low', 'medium', 'high')),
  status                 VARCHAR(10) NOT NULL CHECK (status IN ('scored', 'errored')),
  shadow_severity        VARCHAR(10) CHECK (shadow_severity IN ('none', 'low', 'medium', 'high')),
  severity_probabilities JSONB,
  predicates             JSONB,
  refused_questions      TEXT[] NOT NULL DEFAULT '{}',
  error_code             VARCHAR(40),
  model                  VARCHAR(100) NOT NULL,
  question_set_version   INTEGER NOT NULL,
  tokens_in              INTEGER,
  tokens_out             INTEGER,
  latency_ms             INTEGER,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT shadow_risk_scores_scored_has_severity
    CHECK (status <> 'scored' OR (shadow_severity IS NOT NULL AND error_code IS NULL)),
  CONSTRAINT shadow_risk_scores_errored_has_code
    CHECK (status <> 'errored' OR error_code IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS idx_shadow_risk_scores_session_id ON shadow_risk_scores (session_id);
CREATE INDEX IF NOT EXISTS idx_shadow_risk_scores_message_id ON shadow_risk_scores (message_id);
CREATE INDEX IF NOT EXISTS idx_shadow_risk_scores_created_at ON shadow_risk_scores (created_at DESC);

COMMENT ON TABLE shadow_risk_scores IS 'Shadow risk scorer (ai-therapist-83): per participant turn, the production crisis score and the Decisions API answers about the same turn. Never read by the crisis pipeline. Holds no message text.';
COMMENT ON COLUMN shadow_risk_scores.severity_probabilities IS 'Probability of each band, {"none","low","medium","high"}, 0..1; NULL when the severity question was not answered.';
COMMENT ON COLUMN shadow_risk_scores.predicates IS 'Probability, 0..1, per answered yes/no question (own_suicidal_intent, passive_ideation, plan_or_means, self_harm_without_intent, means_inquiry, harm_to_others, third_party_crisis, figure_of_speech).';
COMMENT ON COLUMN shadow_risk_scores.error_code IS 'Fixed vocabulary, never response or message text: refused, timeout, http_<status>, malformed, no_key, busy, error.';
