// ai-therapist-226: the counterfactual harness must never score or cost a
// candidate that produced no text — a silently failing backend otherwise
// looks like the cheapest, tersest model in the sweep.
import { describe, it, expect, vi } from 'vitest';

vi.mock('openai', () => ({ default: class {} }));
vi.mock('../config/db.js', () => ({ pool: { query: vi.fn(), connect: vi.fn(), on: vi.fn() } }));
vi.mock('../config/secrets.js', () => ({ getOpenAIKey: vi.fn().mockResolvedValue('sk-test') }));
vi.mock('../db/index.js', () => ({ getSessionMessages: vi.fn(), getSessionConfig: vi.fn() }));
vi.mock('../db/counterfactual.queries.js', () => ({
  createCounterfactualRun: vi.fn(),
  recordCounterfactualResponse: vi.fn(),
  recordCounterfactualJudgement: vi.fn(),
  finishCounterfactualRun: vi.fn(),
  getCounterfactualRun: vi.fn(),
}));
vi.mock('../utils/backendModels.js', () => ({
  resolveCandidates: vi.fn(),
  estimateCandidateCostUsd: vi.fn(),
}));

import { candidateError } from './counterfactualEval.service.js';

describe('candidateError', () => {
  it('passes a real error through unchanged', () => {
    expect(candidateError('fork rejected: HTTP 404', '')).toBe('fork rejected: HTTP 404');
    expect(candidateError('timed out', 'partial text')).toBe('timed out');
  });

  it('turns empty or whitespace-only output into an error', () => {
    expect(candidateError(null, '')).toBe('candidate produced no backend text');
    expect(candidateError(null, '   \n')).toBe('candidate produced no backend text');
    expect(candidateError(undefined, null)).toBe('candidate produced no backend text');
  });

  it('is null for a candidate that actually said something', () => {
    expect(candidateError(null, 'I hear you.')).toBeNull();
  });
});
