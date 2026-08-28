-- Migration 071: care_notes — therapist progress notes and caseworker case
-- notes in one table (note_type discriminator). The draft->sign lifecycle,
-- immutability trigger, sign-hash, amendment chain, and visibility filtering
-- are identical machinery for both types; only content shape differs.
-- (caseworker portal, docs/caseworker-portal.md section 1)
-- Date: 2026-08-27

BEGIN;

CREATE TABLE IF NOT EXISTS care_notes (
  note_id        BIGSERIAL PRIMARY KEY,
  org_id         INTEGER NOT NULL REFERENCES organizations(org_id),
  client_id      INTEGER NOT NULL REFERENCES users(userid) ON DELETE CASCADE,
  author_id      INTEGER REFERENCES users(userid) ON DELETE SET NULL,
  author_name    TEXT NOT NULL,                -- snapshot; signed docs must not lose authorship
  author_role    TEXT NOT NULL CHECK (author_role IN ('therapist','caseworker')),
  note_type      TEXT NOT NULL CHECK (note_type IN ('progress','case')),
  case_note_kind TEXT CHECK (case_note_kind IN ('contact','referral','coordination','safety_check','other')),
  session_id     TEXT REFERENCES therapy_sessions(session_id) ON DELETE SET NULL,
  seed_source    TEXT CHECK (seed_source IN ('ai_soap')),
  seed_model     TEXT,
  content        JSONB NOT NULL,   -- progress: {subjective,objective,assessment,plan}; case: {narrative, contact_method?, referral_to?, outcome?}
  status         TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','signed','amended')),
  shared_with_care_team BOOLEAN NOT NULL DEFAULT false,
  signed_at      TIMESTAMPTZ,
  sign_hash      TEXT,             -- sha256 of canonical JSON at sign time
  amends_note_id BIGINT REFERENCES care_notes(note_id) ON DELETE RESTRICT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (note_type = 'case' OR case_note_kind IS NULL),
  CHECK (author_role = 'therapist' OR note_type = 'case')    -- caseworkers author case notes only
);
CREATE INDEX IF NOT EXISTS idx_care_notes_client ON care_notes (client_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_care_notes_author_drafts ON care_notes (author_id) WHERE status = 'draft';
CREATE UNIQUE INDEX IF NOT EXISTS idx_care_notes_session_progress ON care_notes (session_id)
  WHERE note_type = 'progress' AND session_id IS NOT NULL AND status <> 'amended';

CREATE OR REPLACE FUNCTION care_notes_block_signed_update() RETURNS trigger AS $$
BEGIN
  IF OLD.status <> 'draft' AND NEW.content IS DISTINCT FROM OLD.content THEN
    RAISE EXCEPTION 'signed care_notes are immutable; amend instead';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS trg_care_notes_immutable ON care_notes;
CREATE TRIGGER trg_care_notes_immutable BEFORE UPDATE ON care_notes
  FOR EACH ROW EXECUTE FUNCTION care_notes_block_signed_update();

COMMENT ON TABLE care_notes IS
  'Clinical documentation: therapist progress notes + caseworker case notes. draft -> signed (immutable, sign_hash) -> amended via linked amendment drafts.';

COMMIT;
