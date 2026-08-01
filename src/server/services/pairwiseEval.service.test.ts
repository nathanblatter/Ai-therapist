import { describe, it, expect, vi, beforeEach } from 'vitest';

const {
  createMock,
  getSessionMessagesMock,
  getSessionConfigMock,
  insertEvalPairMock,
} = vi.hoisted(() => ({
  createMock: vi.fn(),
  getSessionMessagesMock: vi.fn(),
  getSessionConfigMock: vi.fn(),
  insertEvalPairMock: vi.fn(),
}));

vi.mock('openai', () => ({
  default: class {
    chat = { completions: { create: createMock } };
  },
}));
vi.mock('../config/secrets.js', () => ({ getOpenAIKey: vi.fn().mockResolvedValue('sk-test') }));
vi.mock('../db/index.js', () => ({
  getSessionMessages: getSessionMessagesMock,
  getSessionConfig: getSessionConfigMock,
  insertEvalPair: insertEvalPairMock,
  getPairCandidates: vi.fn(),
  getPairedSessionIds: vi.fn(),
}));
vi.mock('../utils/sessionHelpers.js', () => ({
  getSystemConfig: vi.fn().mockResolvedValue({}),
  DEFAULT_MODALITY_PRESETS: { cbt: { label: 'CBT', addition: '\nUse CBT.' } },
}));

import { matchPairs, mergeVerdicts, judgePair, type PairwiseRunOptions } from './pairwiseEval.service.js';
import type { PairCandidateRow } from '../db/index.js';

void ({} as PairwiseRunOptions);

function cand(id: string, arm: string, modality: string | null, band: 'short' | 'medium' | 'long', ts: number): PairCandidateRow {
  return { session_id: id, modality, duration_band: band, arm, created_at: new Date(ts) };
}

beforeEach(() => {
  vi.clearAllMocks();
  getSessionMessagesMock.mockResolvedValue([
    { role: 'user', content: 'hi', content_redacted: null },
    { role: 'assistant', content: 'hello', content_redacted: null },
  ]);
  getSessionConfigMock.mockResolvedValue({ modality: 'cbt' });
  insertEvalPairMock.mockImplementation(async (row: Record<string, unknown>) => ({ pair_id: 1, created_at: new Date(), ...row }));
});

describe('mergeVerdicts', () => {
  it('follows the merge table', () => {
    expect(mergeVerdicts('a', 'a')).toBe('a');
    expect(mergeVerdicts('b', 'b')).toBe('b');
    expect(mergeVerdicts('tie', 'tie')).toBe('tie');
    expect(mergeVerdicts('a', 'tie')).toBe('a');
    expect(mergeVerdicts('tie', 'b')).toBe('b');
    expect(mergeVerdicts('a', 'b')).toBe('inconsistent');
    expect(mergeVerdicts('b', 'a')).toBe('inconsistent');
  });
});

describe('matchPairs', () => {
  it('greedily zips newest-with-newest across arms within a stratum, canonical order, no reuse', () => {
    const candidates = [
      cand('s3', 'gpt-4o', 'cbt', 'short', 3000),
      cand('s1', 'gpt-4o', 'cbt', 'short', 1000),
      cand('s4', 'gpt-5', 'cbt', 'short', 4000),
      cand('s2', 'gpt-5', 'cbt', 'short', 2000),
    ];
    const pairs = matchPairs(candidates, 20);
    expect(pairs).toHaveLength(2);
    // newest of each arm: gpt-4o s3(3000) vs gpt-5 s4(4000); then s1 vs s2
    const ids = pairs.map(p => [p.a.session_id, p.b.session_id].sort()).map(x => x.join(','));
    expect(ids).toContain('s3,s4');
    expect(ids).toContain('s1,s2');
    // canonical order a < b
    for (const p of pairs) expect(p.a.session_id < p.b.session_id).toBe(true);
    // no session reused
    const used = pairs.flatMap(p => [p.a.session_id, p.b.session_id]);
    expect(new Set(used).size).toBe(used.length);
  });

  it('does not pair across different strata', () => {
    const candidates = [
      cand('a1', 'x', 'cbt', 'short', 1000),
      cand('a2', 'y', 'cbt', 'long', 2000), // different band → no pair
    ];
    expect(matchPairs(candidates, 20)).toHaveLength(0);
  });

  it('respects the limit', () => {
    const candidates = [
      cand('a1', 'x', null, 'short', 1000),
      cand('a2', 'y', null, 'short', 2000),
      cand('b1', 'x', null, 'medium', 1000),
      cand('b2', 'y', null, 'medium', 2000),
    ];
    expect(matchPairs(candidates, 1)).toHaveLength(1);
  });
});

describe('judgePair', () => {
  const a = cand('sA', 'gpt-4o', 'cbt', 'short', 1000);
  const b = cand('sB', 'gpt-5', 'cbt', 'short', 2000);

  it('maps winner per ordering into canonical terms and merges', async () => {
    // Call 1 (A first): winner '1' -> verdict_ab='a'.
    // Call 2 (B first): winner '1' -> verdict_ba='b'. merge('a','b')='inconsistent'.
    createMock
      .mockResolvedValueOnce({ choices: [{ message: { content: JSON.stringify({ winner: '1', rationale: 'r1' }) } }] })
      .mockResolvedValueOnce({ choices: [{ message: { content: JSON.stringify({ winner: '1', rationale: 'r2' }) } }] });

    const row = await judgePair(a, b, 'ai_model', 'gpt-4o-mini');
    const stored = insertEvalPairMock.mock.calls[0][0];
    expect(stored.verdict_ab).toBe('a');
    expect(stored.verdict_ba).toBe('b');
    expect(stored.final_verdict).toBe('inconsistent');
    expect(row.final_verdict).toBe('inconsistent');
  });

  it('a consistent A-winner across both orderings -> final a', async () => {
    // Call 1 (A first): '1' -> 'a'. Call 2 (B first): '2' -> 'a'.
    createMock
      .mockResolvedValueOnce({ choices: [{ message: { content: JSON.stringify({ winner: '1', rationale: 'x' }) } }] })
      .mockResolvedValueOnce({ choices: [{ message: { content: JSON.stringify({ winner: '2', rationale: 'y' }) } }] });
    await judgePair(a, b, 'ai_model', 'gpt-4o-mini');
    const stored = insertEvalPairMock.mock.calls[0][0];
    expect(stored.verdict_ab).toBe('a');
    expect(stored.verdict_ba).toBe('a');
    expect(stored.final_verdict).toBe('a');
  });

  it('throws on an invalid winner', async () => {
    createMock.mockResolvedValueOnce({ choices: [{ message: { content: JSON.stringify({ winner: '3' }) } }] });
    await expect(judgePair(a, b, 'ai_model', 'gpt-4o-mini')).rejects.toThrow(/invalid winner/);
  });
});
