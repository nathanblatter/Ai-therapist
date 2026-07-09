-- Rollback for migration 028
ALTER TABLE users DROP COLUMN IF EXISTS preferred_theme;
