-- Rollback Migration: Change session_id back to UUID
-- Description: Revert session_id from TEXT back to UUID
-- Date: 2025-12-25
-- WARNING: This will fail if there are non-UUID session_id values in the database

BEGIN;

-- Drop foreign key constraints
ALTER TABLE messages DROP CONSTRAINT IF EXISTS messages_session_id_fkey;
ALTER TABLE session_configurations DROP CONSTRAINT IF EXISTS session_configurations_session_id_fkey;

-- Change session_id column type from TEXT back to UUID
ALTER TABLE therapy_sessions ALTER COLUMN session_id DROP DEFAULT;
ALTER TABLE therapy_sessions ALTER COLUMN session_id TYPE UUID USING session_id::UUID;
ALTER TABLE therapy_sessions ALTER COLUMN session_id SET DEFAULT gen_random_uuid();

-- Update foreign key columns in related tables
ALTER TABLE messages ALTER COLUMN session_id TYPE UUID USING session_id::UUID;
ALTER TABLE session_configurations ALTER COLUMN session_id TYPE UUID USING session_id::UUID;

-- Recreate foreign key constraints
ALTER TABLE messages
    ADD CONSTRAINT messages_session_id_fkey
    FOREIGN KEY (session_id) REFERENCES therapy_sessions(session_id) ON DELETE CASCADE;

ALTER TABLE session_configurations
    ADD CONSTRAINT session_configurations_session_id_fkey
    FOREIGN KEY (session_id) REFERENCES therapy_sessions(session_id) ON DELETE CASCADE;

COMMIT;
