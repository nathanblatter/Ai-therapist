-- Migration: Normalize database schema to 3NF
-- Description: Creates therapy_sessions, session_configurations, messages, and user_sessions tables
-- Date: 2025-12-25
-- NOTE: This migration does NOT migrate existing conversation_logs data

-- Enable UUID extension if not already enabled
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ============================================
-- Table: therapy_sessions
-- Purpose: Track therapy sessions with user association
-- ============================================
CREATE TABLE IF NOT EXISTS therapy_sessions (
    session_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id INTEGER REFERENCES users(userid) ON DELETE SET NULL,
    session_name VARCHAR(255),
    status VARCHAR(20) DEFAULT 'active' CHECK (status IN ('active', 'ended', 'archived')),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    ended_at TIMESTAMP
);

-- Indexes for therapy_sessions
CREATE INDEX idx_sessions_user_id ON therapy_sessions(user_id);
CREATE INDEX idx_sessions_status ON therapy_sessions(status);
CREATE INDEX idx_sessions_created_at ON therapy_sessions(created_at DESC);

COMMENT ON TABLE therapy_sessions IS 'Stores therapy session metadata with optional user association';
COMMENT ON COLUMN therapy_sessions.user_id IS 'FK to users table, NULL for anonymous sessions';
COMMENT ON COLUMN therapy_sessions.session_name IS 'Auto-generated friendly name summarizing session content';
COMMENT ON COLUMN therapy_sessions.status IS 'Session lifecycle: active, ended, archived';

-- ============================================
-- Table: session_configurations
-- Purpose: Store OpenAI session configuration per therapy session
-- ============================================
CREATE TABLE IF NOT EXISTS session_configurations (
    config_id SERIAL PRIMARY KEY,
    session_id UUID NOT NULL REFERENCES therapy_sessions(session_id) ON DELETE CASCADE,
    voice VARCHAR(50) DEFAULT 'alloy',
    modalities TEXT[] DEFAULT ARRAY['text', 'audio'],
    instructions TEXT,
    turn_detection JSONB,
    tools JSONB,
    temperature DECIMAL(3,2) DEFAULT 0.8,
    max_response_output_tokens INTEGER DEFAULT 4096,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(session_id)
);

-- Index for session_configurations
CREATE INDEX idx_config_session_id ON session_configurations(session_id);

COMMENT ON TABLE session_configurations IS 'OpenAI Realtime API configuration per therapy session';
COMMENT ON COLUMN session_configurations.voice IS 'OpenAI voice: alloy, echo, fable, onyx, nova, shimmer';
COMMENT ON COLUMN session_configurations.modalities IS 'Array of modalities: text and/or audio';
COMMENT ON COLUMN session_configurations.tools IS 'JSON array of OpenAI function tools';

-- ============================================
-- Table: messages
-- Purpose: Store conversation messages (replaces conversation_logs)
-- ============================================
CREATE TABLE IF NOT EXISTS messages (
    message_id BIGSERIAL PRIMARY KEY,
    session_id UUID NOT NULL REFERENCES therapy_sessions(session_id) ON DELETE CASCADE,
    role VARCHAR(20) NOT NULL CHECK (role IN ('user', 'assistant', 'system')),
    message_type VARCHAR(50) NOT NULL,
    content TEXT,
    content_redacted TEXT,
    metadata JSONB,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Indexes for messages
CREATE INDEX idx_messages_session_id ON messages(session_id);
CREATE INDEX idx_messages_created_at ON messages(created_at);
CREATE INDEX idx_messages_role ON messages(role);

COMMENT ON TABLE messages IS 'Stores therapy session messages with original and redacted content';
COMMENT ON COLUMN messages.content IS 'Original message content (may contain PHI)';
COMMENT ON COLUMN messages.content_redacted IS 'HIPAA-compliant redacted message content';
COMMENT ON COLUMN messages.metadata IS 'Additional message metadata (formerly extras column)';

-- ============================================
-- Table: user_sessions
-- Purpose: Persist Express.js sessions to database (for connect-pg-simple)
-- ============================================
CREATE TABLE IF NOT EXISTS user_sessions (
    sid VARCHAR PRIMARY KEY,
    sess JSONB NOT NULL,
    expire TIMESTAMP NOT NULL
);

-- Index for user_sessions
CREATE INDEX idx_user_sessions_expire ON user_sessions(expire);

COMMENT ON TABLE user_sessions IS 'Stores Express session data for persistent authentication';

-- ============================================
-- Migration Complete
-- ============================================
-- NOTE: conversation_logs table remains unchanged and can be used for historical data
-- New sessions will use the messages table going forward
