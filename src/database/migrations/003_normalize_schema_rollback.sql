-- Rollback Migration: Normalize database schema to 3NF
-- Description: Drops therapy_sessions, session_configurations, messages, and user_sessions tables
-- Date: 2025-12-25
-- WARNING: This will delete ALL data in the new tables. conversation_logs will remain intact.

-- ============================================
-- Drop tables in reverse order (respecting foreign key constraints)
-- ============================================

-- Drop messages table (references therapy_sessions)
DROP TABLE IF EXISTS messages CASCADE;

-- Drop session_configurations table (references therapy_sessions)
DROP TABLE IF EXISTS session_configurations CASCADE;

-- Drop therapy_sessions table (references users)
DROP TABLE IF EXISTS therapy_sessions CASCADE;

-- Drop user_sessions table (standalone)
DROP TABLE IF EXISTS user_sessions CASCADE;

-- ============================================
-- Rollback Complete
-- ============================================
-- The database is now reverted to the pre-migration state
-- conversation_logs table remains unchanged
-- users table remains unchanged
