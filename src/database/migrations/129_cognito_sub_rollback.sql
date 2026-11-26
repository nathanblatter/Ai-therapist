-- Rollback for 129_cognito_sub.sql. The pool's accounts are not touched;
-- delete them in the Cognito console if the migration is abandoned.

DROP INDEX IF EXISTS idx_users_cognito_sub;
ALTER TABLE users DROP COLUMN IF EXISTS cognito_sub;
