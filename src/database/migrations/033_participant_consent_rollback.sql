-- Rollback for 033_participant_consent.sql

DROP INDEX IF EXISTS idx_participant_consents_session_id;
DROP INDEX IF EXISTS idx_participant_consents_user_id;
DROP TABLE IF EXISTS participant_consents;
