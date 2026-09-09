-- 092: assistant_audit — one row per admin-assistant turn (docs/
-- admin-assistant-spec.md). Records who asked what and which tools ran with
-- how many rows returned (never the payloads): the IRB-grade answer to "who
-- queried participant data through the assistant" and the usage/cost monitor.
CREATE TABLE assistant_audit (
  audit_id      BIGSERIAL PRIMARY KEY,
  user_id       INTEGER NOT NULL REFERENCES users(userid) ON DELETE CASCADE,
  role          TEXT NOT NULL,
  question      TEXT NOT NULL,
  tools         JSONB NOT NULL DEFAULT '[]'::jsonb, -- [{name, args, row_count}]
  model         TEXT NOT NULL,
  input_tokens  INTEGER,
  output_tokens INTEGER,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_assistant_audit_user ON assistant_audit (user_id, created_at DESC);
CREATE INDEX idx_assistant_audit_created ON assistant_audit (created_at DESC);
