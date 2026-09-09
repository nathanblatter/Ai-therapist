-- Rollback 092: drop the assistant audit trail (irreversible — export first
-- if the usage history matters).
DROP TABLE IF EXISTS assistant_audit;
