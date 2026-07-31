-- Migration: Add theme column to session_configurations
-- Created: 2026-07-30
-- Description: Record the active UI theme used at session start for research/audit purposes
-- Theme values: 'default', 'sage', 'ocean', 'dusk', 'dark' (from src/client/shared/theme.ts)

ALTER TABLE session_configurations
  ADD COLUMN theme VARCHAR(20) DEFAULT 'default',
  ADD CONSTRAINT valid_theme CHECK (theme IN ('default', 'sage', 'ocean', 'dusk', 'dark'));

COMMENT ON COLUMN session_configurations.theme IS 'UI theme active when session started, for research conditions';
