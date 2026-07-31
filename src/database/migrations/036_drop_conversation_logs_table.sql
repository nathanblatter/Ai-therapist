-- Migration: Drop conversation_logs table (unused, superseded by messages table)
-- Created: 2026-07-30
-- Description: Remove the legacy conversation_logs table
-- This table is no longer used — it was replaced by the messages table in migration 003.
-- No code references it, and all new message storage uses the messages table.

DROP TABLE IF EXISTS conversation_logs CASCADE;

-- Note: This table was legacy and no longer used. The messages table (created in 003_normalize_schema.sql)
-- is the current message storage mechanism.
