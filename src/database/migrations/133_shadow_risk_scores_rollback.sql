-- Rollback for 133_shadow_risk_scores.sql. Drops the shadow scorer's record;
-- nothing else reads it.
DROP TABLE IF EXISTS shadow_risk_scores;
