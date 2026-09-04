-- 089: survey reminder ledger + Qualtrics contact map (Qualtrics ops).
--
-- The app drives weekly-survey email nudges through Qualtrics as the mailer
-- (qualtricsReminders.service.ts): the schedule service knows each
-- participant's study week, the ledger guarantees at most one invite and one
-- 48h follow-up per (participant, survey, week), and contacts live in an
-- app-managed XM Directory mailing list keyed here so we never search the
-- directory at send time. Contact email comes from the baseline survey's
-- BEMAIL answer (already in qualtrics_responses.answers) — no new email
-- column on users, no second copy of the address in the app DB.

BEGIN;

CREATE TABLE survey_reminders (
  reminder_id  BIGSERIAL PRIMARY KEY,
  user_id      INTEGER NOT NULL REFERENCES users(userid) ON DELETE CASCADE,
  survey_role  TEXT NOT NULL,
  -- study week for weekly check-ins; 0 for one-shot surveys (exit, week12)
  week         INTEGER NOT NULL DEFAULT 0,
  kind         TEXT NOT NULL CHECK (kind IN ('invite', 'followup')),
  sent_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  distribution_id TEXT,
  UNIQUE (user_id, survey_role, week, kind)
);

CREATE INDEX idx_survey_reminders_user ON survey_reminders(user_id);

CREATE TABLE qualtrics_contacts (
  user_id    INTEGER PRIMARY KEY REFERENCES users(userid) ON DELETE CASCADE,
  contact_id TEXT NOT NULL,
  email      TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMIT;
