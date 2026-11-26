-- 129_cognito_sub.sql — link local accounts to the study's Amazon Cognito user
-- pool (ai-therapist-387). Prod sign-in moves to Cognito, in the study's own
-- AWS account; the app keeps its users table for RBAC, org scoping and foreign
-- keys and remembers each row's Cognito subject (the token's `sub`). Filled on
-- the first Cognito sign-in that matches by username, and by
-- accounts.service.ts for accounts created afterwards. The password column
-- stays (legacy login when Cognito is not configured: local dev, tests, CI).
-- Independent of 106 (Squawk ids), which prod never applied.

ALTER TABLE users ADD COLUMN IF NOT EXISTS cognito_sub text;
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_cognito_sub ON users (cognito_sub) WHERE cognito_sub IS NOT NULL;
