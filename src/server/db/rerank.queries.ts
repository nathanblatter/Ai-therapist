// Data-access for RAG rerank decision logging (ai-therapist-88, migration 055).
// One row per listwise LLM rerank call (fallbacks included) so movement /
// fallback-rate / latency can be judged before building a real rerank eval.
import { pool } from '../config/db.js';

export interface RerankCandidateLog {
  chunk_id: number;
  vec_rank: number;
  similarity: number | null;
}

export interface InsertRerankDecisionInput {
  sessionId: string | null;
  toolName: string;
  query: string;
  candidates: RerankCandidateLog[];
  chosen: number[];
  usedFallback: boolean;
  model: string | null;
  latencyMs: number | null;
}

/** Log one rerank decision. Best-effort — callers fire-and-forget. */
export async function insertRerankDecision(input: InsertRerankDecisionInput): Promise<void> {
  await pool.query(
    `INSERT INTO rag_rerank_decisions
       (session_id, tool_name, query, candidates, chosen, used_fallback, model, latency_ms)
     VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6, $7, $8)`,
    [
      input.sessionId, input.toolName, input.query,
      JSON.stringify(input.candidates), JSON.stringify(input.chosen),
      input.usedFallback, input.model, input.latencyMs,
    ],
  );
}

export interface RerankDecisionRow {
  decision_id: number;
  session_id: string | null;
  tool_name: string;
  query: string;
  candidates: RerankCandidateLog[];
  chosen: number[];
  used_fallback: boolean;
  model: string | null;
  latency_ms: number | null;
  created_at: Date;
}

/** Recent rerank decisions, newest first, optionally filtered by tool. */
export async function listRerankDecisions(filter: { toolName?: string | null; limit?: number }): Promise<RerankDecisionRow[]> {
  const limit = Math.min(Math.max(filter.limit ?? 100, 1), 500);
  const toolName = filter.toolName && filter.toolName !== 'all' ? filter.toolName : null;
  const result = await pool.query<RerankDecisionRow>(
    `SELECT * FROM rag_rerank_decisions
     WHERE ($1::text IS NULL OR tool_name = $1)
     ORDER BY created_at DESC
     LIMIT $2`,
    [toolName, limit],
  );
  return result.rows;
}

export interface RerankStats {
  total: number;
  fallback_rate: number;      // 0..1
  movement_rate: number;      // fraction where chosen[0] !== the vec-rank-0 chunk
  p95_latency_ms: number | null;
}

/** Aggregate movement / fallback / p95-latency stats over recent decisions,
 *  optionally filtered by tool. Enough to judge whether reranking earns its
 *  latency before investing in a fuller eval. */
export async function getRerankStats(filter: { toolName?: string | null; limit?: number }): Promise<RerankStats> {
  const rows = await listRerankDecisions({ toolName: filter.toolName, limit: filter.limit ?? 500 });
  const total = rows.length;
  if (total === 0) return { total: 0, fallback_rate: 0, movement_rate: 0, p95_latency_ms: null };

  let fallbacks = 0;
  let moved = 0;
  const latencies: number[] = [];
  for (const r of rows) {
    if (r.used_fallback) fallbacks++;
    // The vector-order top chunk is the candidate with vec_rank 0.
    const vecTop = r.candidates.find(c => c.vec_rank === 0)?.chunk_id;
    if (vecTop != null && r.chosen.length > 0 && r.chosen[0] !== vecTop) moved++;
    if (typeof r.latency_ms === 'number') latencies.push(r.latency_ms);
  }
  latencies.sort((a, b) => a - b);
  const p95 = latencies.length > 0 ? latencies[Math.min(latencies.length - 1, Math.floor(latencies.length * 0.95))] : null;

  return {
    total,
    fallback_rate: fallbacks / total,
    movement_rate: moved / total,
    p95_latency_ms: p95,
  };
}
