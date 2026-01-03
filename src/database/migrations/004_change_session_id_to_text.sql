-- Migration: Change session_id from UUID to TEXT
-- Description: Support external session IDs (e.g., GPT realtime session IDs)
-- Date: 2025-12-25

BEGIN;

-- Drop foreign key constraints that reference session_id
ALTER TABLE messages DROP CONSTRAINT IF EXISTS messages_session_id_fkey;
ALTER TABLE session_configurations DROP CONSTRAINT IF EXISTS session_configurations_session_id_fkey;

-- Change session_id column type from UUID to TEXT
ALTER TABLE therapy_sessions ALTER COLUMN session_id DROP DEFAULT;
ALTER TABLE therapy_sessions ALTER COLUMN session_id TYPE TEXT USING session_id::TEXT;
ALTER TABLE therapy_sessions ALTER COLUMN session_id SET DEFAULT gen_random_uuid()::TEXT;

-- Update foreign key columns in related tables
ALTER TABLE messages ALTER COLUMN session_id TYPE TEXT USING session_id::TEXT;
ALTER TABLE session_configurations ALTER COLUMN session_id TYPE TEXT USING session_id::TEXT;

-- Recreate foreign key constraints
ALTER TABLE messages
    ADD CONSTRAINT messages_session_id_fkey
    FOREIGN KEY (session_id) REFERENCES therapy_sessions(session_id) ON DELETE CASCADE;

ALTER TABLE session_configurations
    ADD CONSTRAINT session_configurations_session_id_fkey
    FOREIGN KEY (session_id) REFERENCES therapy_sessions(session_id) ON DELETE CASCADE;

COMMIT;
