-- Rollback for 055_rag_rerank_decisions.sql
DROP INDEX IF EXISTS idx_rerank_decisions_tool_time;
DROP INDEX IF EXISTS idx_rerank_decisions_session;
DROP TABLE IF EXISTS rag_rerank_decisions;
