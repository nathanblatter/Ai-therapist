-- Rollback for migration 071: drop trigger, function, table.

BEGIN;

DROP TRIGGER IF EXISTS trg_care_notes_immutable ON care_notes;
DROP FUNCTION IF EXISTS care_notes_block_signed_update();
DROP TABLE IF EXISTS care_notes;

COMMIT;
