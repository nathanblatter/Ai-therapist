-- Migration: Drop human_handoffs and clinical_reviews tables (unused features)
-- Created: 2026-07-30
-- Description: Remove tables for the sunset human-handoff and clinical-review features
-- These tables were part of the crisis management system but are no longer actively used

DROP TABLE IF EXISTS clinical_reviews CASCADE;
DROP TABLE IF EXISTS human_handoffs CASCADE;

-- Note: Both tables are now removed. If needed in the future, reference migration 011
-- to see their original schema (011_add_crisis_management.sql).
