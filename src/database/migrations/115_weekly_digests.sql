-- Migration 115: weekly PI digest persistence (eval spec WP7)
-- Date: 2026-10-23
--
-- Numbered 115 because 114 is reserved by the eval rating-queue branch (WP2)
-- that is landing alongside this one; the two are independent.
--
-- One row per generated digest: the rendered markdown plus the structured
-- numbers it was rendered from, so a digest forwarded to the PI can always be
-- reproduced exactly as sent. Rows are aggregates only (counts, means,
-- kappas); they never carry participant identifiers, session ids, usernames
-- or transcript text. generated_by is 'scheduler' for the weekly tick or the
-- admin username who clicked Generate / ran the CLI (auditability of the
-- generator, not of any participant).
BEGIN;

CREATE TABLE IF NOT EXISTS weekly_digests (
  id            BIGSERIAL PRIMARY KEY,
  org_id        INTEGER NOT NULL REFERENCES organizations(org_id) ON DELETE CASCADE,
  week_ending   DATE NOT NULL,
  markdown      TEXT NOT NULL,
  data          JSONB NOT NULL,
  generated_at  TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  generated_by  TEXT NOT NULL
);

-- List view: newest week first per org; the scheduler's debounce looks up the
-- latest scheduler-generated row per org through the same index.
CREATE INDEX IF NOT EXISTS idx_weekly_digests_org_week
  ON weekly_digests (org_id, week_ending DESC, generated_at DESC);

COMMIT;
