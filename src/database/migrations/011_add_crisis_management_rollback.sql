BEGIN;

-- ============================================
-- Drop risk_score_history table
-- ============================================
DROP TABLE IF EXISTS risk_score_history CASCADE;

-- ============================================
-- Drop clinical_reviews table
-- ============================================
DROP TABLE IF EXISTS clinical_reviews CASCADE;

-- ============================================
-- Drop human_handoffs table
-- ============================================
DROP TABLE IF EXISTS human_handoffs CASCADE;

-- ============================================
-- Drop intervention_actions table
-- ============================================
DROP TABLE IF EXISTS intervention_actions CASCADE;

-- ============================================
-- Drop crisis_events table
-- ============================================
DROP TABLE IF EXISTS crisis_events CASCADE;

-- ============================================
-- Remove crisis fields from therapy_sessions table
-- ============================================
ALTER TABLE therapy_sessions
DROP COLUMN IF EXISTS crisis_flagged,
DROP COLUMN IF EXISTS crisis_severity,
DROP COLUMN IF EXISTS crisis_risk_score,
DROP COLUMN IF EXISTS crisis_flagged_at,
DROP COLUMN IF EXISTS crisis_flagged_by,
DROP COLUMN IF EXISTS crisis_unflagged_at,
DROP COLUMN IF EXISTS crisis_unflagged_by,
DROP COLUMN IF EXISTS monitoring_frequency;

COMMIT;
