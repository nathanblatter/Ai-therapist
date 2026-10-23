-- Migration 108: organization scoping for the adverse-event register
-- (ai-therapist-228, security).
-- Date: 2026-10-22
--
-- adverse_event_reports (048) carried no organization column, so every
-- therapist/researcher read returned every organization's reports. Add a
-- nullable organization_id and backfill it from the participant:
--   1. user_id -> users.organization_id (every user has an org since 069, so
--      every IRB-study participant resolves to the irb-study org);
--   2. rows whose user_id was nulled (participant deleted) but whose session
--      link survives: session -> owner -> org;
--   3. anything left (anonymous sessions, fully orphaned provenance) stays
--      NULL. NULL means "unattributed, in IRB-study custody": the read
--      queries show NULL rows only to callers whose org is the irb-study org.
-- New rows resolve organization_id at insert time (insertAdverseEventDraft).
-- ON DELETE RESTRICT: an IRB record must never silently lose attribution.
-- Sandbox orgs never own AE rows (drafting is suppressed for sandbox
-- sessions/clients), so sandbox teardown is unaffected.

BEGIN;

ALTER TABLE adverse_event_reports
  ADD COLUMN IF NOT EXISTS organization_id INTEGER
  REFERENCES organizations(org_id) ON DELETE RESTRICT;

UPDATE adverse_event_reports r
   SET organization_id = u.organization_id
  FROM users u
 WHERE u.userid = r.user_id
   AND r.organization_id IS NULL;

UPDATE adverse_event_reports r
   SET organization_id = u.organization_id
  FROM therapy_sessions ts
  JOIN users u ON u.userid = ts.user_id
 WHERE ts.session_id = r.session_id
   AND r.organization_id IS NULL;

CREATE INDEX IF NOT EXISTS idx_ae_reports_org ON adverse_event_reports(organization_id);

COMMENT ON COLUMN adverse_event_reports.organization_id IS
  'Owning organization (participant''s org at draft time). NULL = unattributed, visible only to the irb-study org (migration 108).';

COMMIT;
