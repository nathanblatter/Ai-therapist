-- Migration 028: participant-selectable UI theme, persisted alongside the
-- existing voice/language preferences on the users table.
-- Values are validated in the API layer against the client theme list
-- (default | sage | ocean | dusk | dark); NULL means "use the default".

ALTER TABLE users ADD COLUMN IF NOT EXISTS preferred_theme VARCHAR(32);

COMMENT ON COLUMN users.preferred_theme IS 'UI theme preset chosen by the user (default/sage/ocean/dusk/dark); NULL = default';
