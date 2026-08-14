// Listwise LLM reranking over pgvector candidates (ai-therapist-88). A small
// gpt-4o-mini JSON call reorders a widened candidate set to the top-N that most
// directly answer the query, with a HARD timeout that falls back to vector
// order. Every decision (fallbacks included) is logged for later eval. There is
// no cross-encoder infra in this stack, and one small JSON call fits the repo's
// established RAG-tool pattern.
import OpenAI from 'openai';
import { getOpenAIKey } from '../config/secrets.js';
import { recordLlmUsage, insertRerankDecision } from '../db/index.js';
import type { KnowledgeChunk } from '../db/knowledge.queries.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('rerank');

export const RERANK_MODEL = 'gpt-4o-mini';
export const RERANK_TIMEOUT_MS = 2500;

let openaiClient: OpenAI | null = null;
async function getClient(): Promise<OpenAI> {
  if (!openaiClient) {
    openaiClient = new OpenAI({ apiKey: await getOpenAIKey() });
  }
  return openaiClient;
}

const RERANK_PROMPT = (topN: number) =>
  `You rank retrieved passages for a mental-health support assistant. Given the query and the numbered candidates, pick the ${topN} passages that most directly and completely answer the query, best first. Prefer passages that answer the specific question over ones that merely share keywords. Return STRICT JSON only: {"ranking": [<candidate numbers, best first, exactly ${topN} of them>], "reasoning": "<one short sentence>"}`;

export interface RerankResult {
  chunks: KnowledgeChunk[];      // topN, rerank order (or vector order on fallback)
  usedFallback: boolean;
  latencyMs: number;
}

export interface RerankContext {
  sessionId: string | null;
  toolName: string;
  /** Admin test-retrieval playground: don't log to rag_rerank_decisions —
   *  test calls aren't session traffic and would pollute the eval stats. */
  skipDecisionLog?: boolean;
}

/**
 * Rerank vector candidates for a query. NEVER throws; on any error or
 * >RERANK_TIMEOUT_MS returns the first topN in vector order (usedFallback=true).
 * Logs one rag_rerank_decisions row per call (fallbacks included).
 */
export async function rerankChunks(
  query: string,
  candidates: KnowledgeChunk[],
  topN: number,
  ctx: RerankContext,
): Promise<RerankResult> {
  const start = Date.now();

  // Nothing to reorder: no API call, log a trivial fallback for stats parity.
  if (candidates.length <= topN) {
    const chunks = candidates.slice(0, topN);
    const result: RerankResult = { chunks, usedFallback: true, latencyMs: Date.now() - start };
    logDecision(ctx, query, candidates, chunks, result);
    return result;
  }

  try {
    const ranking = await withTimeout(callRerankModel(query, candidates, topN, ctx), RERANK_TIMEOUT_MS);
    const chunks = repairRanking(ranking, candidates, topN);
    const result: RerankResult = { chunks, usedFallback: false, latencyMs: Date.now() - start };
    logDecision(ctx, query, candidates, chunks, result);
    return result;
  } catch (err) {
    log.warn({ err, tool: ctx.toolName }, '[rerank] falling back to vector order');
    const chunks = candidates.slice(0, topN);
    const result: RerankResult = { chunks, usedFallback: true, latencyMs: Date.now() - start };
    logDecision(ctx, query, candidates, chunks, result);
    return result;
  }
}

/** Reject after ms, so a slow rerank can never hold up a tool call. */
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`rerank timed out after ${ms}ms`)), ms);
    p.then(v => { clearTimeout(t); resolve(v); }, e => { clearTimeout(t); reject(e); });
  });
}

/** Call the model and return the raw 1-based ranking array. */
async function callRerankModel(
  query: string,
  candidates: KnowledgeChunk[],
  topN: number,
  ctx: RerankContext,
): Promise<number[]> {
  const client = await getClient();
  const rendered = candidates
    .map((c, i) => `#${i + 1} [${c.title ?? 'untitled'}] ${c.content.slice(0, 400)}`)
    .join('\n');

  const response = await client.chat.completions.create({
    model: RERANK_MODEL,
    temperature: 0,
    max_tokens: 120,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: RERANK_PROMPT(topN) },
      { role: 'user', content: `Query:\n"${query}"\n\nCandidates:\n${rendered}` },
    ],
  });

  recordLlmUsage(
    ctx.sessionId, 'rerank', RERANK_MODEL,
    response.usage?.prompt_tokens ?? null, response.usage?.completion_tokens ?? null,
  ).catch(err => log.error({ err }, '[rerank] failed to record LLM usage (non-fatal)'));

  const parsed = JSON.parse(response.choices[0]?.message?.content ?? '{}') as { ranking?: unknown };
  if (!Array.isArray(parsed.ranking)) throw new Error('rerank response missing ranking array');
  return parsed.ranking.map(n => Number(n)).filter(n => Number.isFinite(n));
}

/**
 * Turn a raw 1-based ranking into exactly topN chunks: dedupe, drop
 * out-of-range indices, then pad from vector order for anything short.
 */
function repairRanking(ranking: number[], candidates: KnowledgeChunk[], topN: number): KnowledgeChunk[] {
  const seen = new Set<number>();
  const chosen: KnowledgeChunk[] = [];
  for (const oneBased of ranking) {
    const idx = oneBased - 1;
    if (idx < 0 || idx >= candidates.length || seen.has(idx)) continue;
    seen.add(idx);
    chosen.push(candidates[idx]);
    if (chosen.length >= topN) break;
  }
  // Pad from vector order (skipping already-chosen) if the model returned fewer
  // than topN valid indices.
  for (let i = 0; i < candidates.length && chosen.length < topN; i++) {
    if (!seen.has(i)) {
      seen.add(i);
      chosen.push(candidates[i]);
    }
  }
  return chosen;
}

/** Fire-and-forget decision log; never throws into the caller. */
function logDecision(
  ctx: RerankContext,
  query: string,
  candidates: KnowledgeChunk[],
  chosen: KnowledgeChunk[],
  result: RerankResult,
): void {
  if (ctx.skipDecisionLog) return;
  insertRerankDecision({
    sessionId: ctx.sessionId,
    toolName: ctx.toolName,
    query,
    candidates: candidates.map((c, i) => ({ chunk_id: c.chunk_id, vec_rank: i, similarity: c.similarity ?? null })),
    chosen: chosen.map(c => c.chunk_id),
    usedFallback: result.usedFallback,
    model: RERANK_MODEL,
    latencyMs: result.latencyMs,
  }).catch(err => log.error({ err }, '[rerank] failed to log decision (non-fatal)'));
}
