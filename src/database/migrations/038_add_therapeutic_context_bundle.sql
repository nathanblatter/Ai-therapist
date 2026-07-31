-- Therapeutic context bundle (flightdeck ai-therapist-47/48/50/52):
-- rolling per-user case profile, therapist "notes for next session", and the
-- admin-gated risk-history sharing flag. Screener trend, mood trajectory,
-- safety-plan and thought-record recall (ai-therapist-48/67/69/72) read
-- existing tables (scale_responses, tool_invocations, safety_plans, messages)
-- and need no new schema.
--
-- NOTE: numbered 033 in this worktree; other agents are adding migrations in
-- parallel and this may be renumbered when a lead integrates all branches.

-- Rolling clinical case profile, updated (merged, not appended) after each
-- ended session by the same insights LLM call that produces the memory
-- summary + SOAP note (see services/sessionInsights.service.ts). Injected
-- into promptContext.buildMemoryBlock for returning consented users.
CREATE TABLE IF NOT EXISTS user_case_profiles (
  user_id INTEGER PRIMARY KEY REFERENCES users(userid) ON DELETE CASCADE,
  profile JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Therapist-authored free-text guidance for the participant's NEXT session,
-- entered from the SOAP review workflow (SessionInsightsPanel). Injected into
-- that user's next session prompt as private clinician guidance.
ALTER TABLE session_insights ADD COLUMN IF NOT EXISTS notes_for_next_session TEXT;
ALTER TABLE session_insights ADD COLUMN IF NOT EXISTS notes_author VARCHAR(255);
ALTER TABLE session_insights ADD COLUMN IF NOT EXISTS notes_created_at TIMESTAMPTZ;

-- Per-user gate for injecting prior-crisis context into future sessions.
-- Sensitive wording — default OFF until a therapist explicitly reviews and
-- enables it for a given participant (see routes/admin/insights.routes.ts).
ALTER TABLE users ADD COLUMN IF NOT EXISTS risk_context_share_enabled BOOLEAN NOT NULL DEFAULT FALSE;
