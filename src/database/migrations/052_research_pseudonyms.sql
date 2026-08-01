-- Migration 052 (ai-therapist-96): stable pseudonym mapping for the
-- de-identified research dataset export.
--
-- Design: a MAPPING TABLE, not a salted hash. Rationale: (a) human-readable
-- IDs (P003, S0142) for the codebook and papers; (b) no salt to manage/leak --
-- re-identification requires DB access, which is already the trust boundary;
-- (c) deterministic across runs by construction: a pseudonym is assigned once
-- (first export that sees the entity, in created_at order) and never changes.
-- The mapping table itself is NEVER included in any export artifact.

CREATE TABLE IF NOT EXISTS research_pseudonyms (
    pseudonym_id  SERIAL PRIMARY KEY,
    entity_type   VARCHAR(20) NOT NULL CHECK (entity_type IN ('participant', 'session')),
    -- users.userid::text for participants; therapy_sessions.session_id for sessions.
    entity_key    TEXT NOT NULL,
    -- P001, P002, ... / S0001, S0002, ... (zero-padded, assigned in entity
    -- created_at order at first assignment).
    pseudonym     VARCHAR(20) NOT NULL,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (entity_type, entity_key),
    UNIQUE (entity_type, pseudonym)
);

CREATE INDEX IF NOT EXISTS idx_research_pseudonyms_lookup
    ON research_pseudonyms(entity_type, entity_key);

COMMENT ON TABLE research_pseudonyms IS
  'ai-therapist-96: userid/session_id -> stable pseudonymous ID for dataset exports. This table is the re-identification key and must never leave the database (excluded from exports; included in encrypted backups only).';
COMMENT ON COLUMN research_pseudonyms.entity_key IS
  'users.userid::text (participant) or therapy_sessions.session_id (session)';
