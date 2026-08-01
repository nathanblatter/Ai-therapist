import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { KnowledgeChunk } from '../db/knowledge.queries.js';

const { createMock, recordLlmUsageMock, insertRerankDecisionMock } = vi.hoisted(() => ({
  createMock: vi.fn(),
  recordLlmUsageMock: vi.fn().mockResolvedValue(undefined),
  insertRerankDecisionMock: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../config/secrets.js', () => ({ getOpenAIKey: vi.fn().mockResolvedValue('test-key') }));
vi.mock('openai', () => ({
  default: class {
    chat = { completions: { create: createMock } };
  },
}));
vi.mock('../db/index.js', () => ({
  recordLlmUsage: recordLlmUsageMock,
  insertRerankDecision: insertRerankDecisionMock,
}));

const { rerankChunks, RERANK_MODEL } = await import('./rerank.service.js');

function chunk(id: number): KnowledgeChunk {
  return {
    chunk_id: id, title: `t${id}`, content: `content ${id}`, source: 's', source_url: null,
    topic: null, kind: 'psychoeducation', modality: null, metadata: null, similarity: 1 - id / 100,
  };
}
const CANDIDATES = [1, 2, 3, 4, 5, 6, 7, 8].map(chunk);
const CTX = { sessionId: 'sess-1', toolName: 'retrieve_psychoeducation' };

function rankResponse(ranking: number[]) {
  return { choices: [{ message: { content: JSON.stringify({ ranking, reasoning: 'r' }) } }], usage: { prompt_tokens: 100, completion_tokens: 20 } };
}

beforeEach(() => vi.clearAllMocks());

describe('rerankChunks', () => {
  it('reorders to the model ranking and returns topN (1-based → chunks)', async () => {
    createMock.mockResolvedValue(rankResponse([5, 2, 8]));
    const r = await rerankChunks('q', CANDIDATES, 3, CTX);
    expect(r.usedFallback).toBe(false);
    expect(r.chunks.map(c => c.chunk_id)).toEqual([5, 2, 8]);
    expect(recordLlmUsageMock).toHaveBeenCalledWith('sess-1', 'rerank', RERANK_MODEL, 100, 20);
  });

  it('dedupes and drops out-of-range indices, padding from vector order', async () => {
    // 99 is out of range, 2 repeats; only 2 valid → pad with vector-order 1,3.
    createMock.mockResolvedValue(rankResponse([2, 2, 99, 4]));
    const r = await rerankChunks('q', CANDIDATES, 3, CTX);
    expect(r.chunks.map(c => c.chunk_id)).toEqual([2, 4, 1]);
  });

  it('short-circuits (no API call) when candidates <= topN', async () => {
    const r = await rerankChunks('q', CANDIDATES.slice(0, 2), 3, CTX);
    expect(r.usedFallback).toBe(true);
    expect(createMock).not.toHaveBeenCalled();
    expect(r.chunks.map(c => c.chunk_id)).toEqual([1, 2]);
  });

  it('falls back to vector order on model error', async () => {
    createMock.mockRejectedValue(new Error('model down'));
    const r = await rerankChunks('q', CANDIDATES, 3, CTX);
    expect(r.usedFallback).toBe(true);
    expect(r.chunks.map(c => c.chunk_id)).toEqual([1, 2, 3]);
  });

  it('falls back to vector order when the response has no ranking array', async () => {
    createMock.mockResolvedValue({ choices: [{ message: { content: '{"reasoning":"x"}' } }], usage: {} });
    const r = await rerankChunks('q', CANDIDATES, 3, CTX);
    expect(r.usedFallback).toBe(true);
    expect(r.chunks.map(c => c.chunk_id)).toEqual([1, 2, 3]);
  });

  it('logs one decision row per call (fallbacks included)', async () => {
    createMock.mockResolvedValue(rankResponse([3, 1, 2]));
    await rerankChunks('q', CANDIDATES, 3, CTX);
    expect(insertRerankDecisionMock).toHaveBeenCalledTimes(1);
    const decision = insertRerankDecisionMock.mock.calls[0][0];
    expect(decision.toolName).toBe('retrieve_psychoeducation');
    expect(decision.chosen).toEqual([3, 1, 2]);
    expect(decision.candidates).toHaveLength(8);
    expect(decision.candidates[0]).toMatchObject({ chunk_id: 1, vec_rank: 0 });
    expect(decision.usedFallback).toBe(false);
  });
});
