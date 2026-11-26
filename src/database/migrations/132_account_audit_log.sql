-- ai-therapist-411: a durable record of who changed which account, and how.
--
-- Access-control changes must be auditable (the reason caseload_audit_log
-- exists, migration 066). Until now account changes were only log lines: who
-- created or deleted an account, changed its role, reset its password or its
-- authenticator app lived in container logs that rotate. Append-only. No
-- foreign keys: the rows must survive the accounts they are about.
--
-- Never holds a password, a token or an email address: `detail` carries only
-- what changed (the role before and after, the username before and after,
-- whether an email was set or cleared, who the change was made through).
CREATE TABLE IF NOT EXISTS account_audit_log (
  audit_id        SERIAL PRIMARY KEY,
  action          TEXT NOT NULL CHECK (action IN (
                    'account_created', 'account_deleted', 'role_changed', 'password_changed',
                    'username_changed', 'email_changed', 'authenticator_reset')),
  target_user_id  INTEGER,
  target_username TEXT,
  organization_id INTEGER,
  actor_user_id   INTEGER,
  actor_username  TEXT,
  detail          JSONB,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_account_audit_created ON account_audit_log (created_at);
CREATE INDEX IF NOT EXISTS idx_account_audit_target ON account_audit_log (target_user_id);

COMMENT ON TABLE account_audit_log IS 'Append-only audit of account changes made through the app (who created, deleted, re-roled, re-passworded or reset which account, when).';
