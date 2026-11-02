-- 120: outbound_mail — audit of email sent by staff from the admin app
-- (ai-therapist-283, phase 2).
--
-- Every message a researcher composes in the Mail view is recorded here
-- before it is handed to the email-api gateway, with the gateway's verdict
-- (sent / queued / failed) written back. The sender row is kept even if the
-- account is later deleted (sent_by goes null; from_address stays), because
-- this is the study's correspondence record.
--
-- Bodies are staff-authored text to external parties (OpenAI, the PI, the
-- IRB). The compose path refuses anything that looks like participant
-- content (session ids); it is still the author's responsibility to keep
-- participant data out of email, and the Mail view says so.

CREATE TABLE IF NOT EXISTS outbound_mail (
  mail_id        BIGSERIAL PRIMARY KEY,
  sent_by        INTEGER REFERENCES users(userid) ON DELETE SET NULL,
  from_address   TEXT NOT NULL,
  to_addresses   TEXT[] NOT NULL,
  cc_addresses   TEXT[] NOT NULL DEFAULT '{}',
  reply_to       TEXT,
  in_reply_to    TEXT,
  subject        TEXT NOT NULL,
  body_text      TEXT NOT NULL,
  status         TEXT NOT NULL CHECK (status IN ('sent', 'queued', 'failed')),
  gateway_id     TEXT,
  error          TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_outbound_mail_sender_time ON outbound_mail (sent_by, created_at DESC);

COMMENT ON TABLE outbound_mail IS 'Staff email sent from the admin Mail view (ai-therapist-283 phase 2); the study correspondence record.';
