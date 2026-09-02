-- Per-session affect trajectory (ai-therapist-86): valence/arousal per
-- participant turn, produced in the SAME insights LLM call that writes the
-- summary + SOAP note (no extra pipeline). JSONB array of
-- {turn, valence, arousal, label} — derived affect only, no verbatim content,
-- so it is summary-tier-safe.
BEGIN;

ALTER TABLE session_insights ADD COLUMN IF NOT EXISTS affect_curve JSONB;

COMMIT;
