-- Migration 005: Add language column to session_configurations
-- This allows tracking what language users prefer for their therapy sessions

ALTER TABLE session_configurations
ADD COLUMN language VARCHAR(10) DEFAULT 'en';

COMMENT ON COLUMN session_configurations.language IS 'Language code for the session (e.g., en, es, fr, de)';
