-- Rollback for 033_add_model_to_session_config.sql

ALTER TABLE session_configurations
    DROP COLUMN IF EXISTS ai_model,
    DROP COLUMN IF EXISTS transcription_model;
