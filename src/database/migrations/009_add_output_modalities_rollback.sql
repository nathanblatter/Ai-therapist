-- Rollback for 009_add_output_modalities.sql
-- Removes the output_modalities key that 009 seeded into the `features`
-- system_config row and restores the 007 column comment.
--
-- Note: 009 seeded ["audio"]; the row may since have been edited through the
-- admin config UI (stage currently holds ["audio","text"]). Re-applying 009
-- resets the key to ["audio"], not to whatever was there before this rollback.

UPDATE system_config
SET config_value = config_value - 'output_modalities'
WHERE config_key = 'features';

COMMENT ON COLUMN system_config.config_value IS 'JSON value for the configuration';
