-- Tool-calling wave 2: collaborative safety plans, participant-approved
-- memories, and validated-scale responses.

-- Safety plan built collaboratively in-session via the create_safety_plan
-- tool. Per-session (anonymous participants have no user row); user_id set
-- when known so a returning user's latest plan can be found.
CREATE TABLE IF NOT EXISTS safety_plans (
  plan_id SERIAL PRIMARY KEY,
  session_id TEXT REFERENCES therapy_sessions(session_id) ON DELETE CASCADE,
  user_id INTEGER REFERENCES users(userid) ON DELETE CASCADE,
  plan JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_safety_plans_session ON safety_plans(session_id);
CREATE INDEX IF NOT EXISTS idx_safety_plans_user ON safety_plans(user_id, created_at DESC);

-- Facts a logged-in participant explicitly asked the AI to remember
-- (remember_this tool). Injected into future sessions' memory block,
-- still gated by users.memory_enabled.
CREATE TABLE IF NOT EXISTS user_memories (
  memory_id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(userid) ON DELETE CASCADE,
  fact TEXT NOT NULL,
  session_id TEXT REFERENCES therapy_sessions(session_id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_user_memories_user ON user_memories(user_id, created_at DESC);

-- Brief validated-instrument responses (administer_scale tool; PHQ-2/GAD-2,
-- public domain). Answers are the raw item scores; score is their sum.
CREATE TABLE IF NOT EXISTS scale_responses (
  response_id SERIAL PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES therapy_sessions(session_id) ON DELETE CASCADE,
  scale VARCHAR(20) NOT NULL,
  answers JSONB NOT NULL,
  score INTEGER NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_scale_responses_session ON scale_responses(session_id);
CREATE INDEX IF NOT EXISTS idx_scale_responses_scale_time ON scale_responses(scale, created_at DESC);
