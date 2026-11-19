// Degraded-mode behaviour of the crisis detection path when OpenAI fails
// (ai-therapist-190, ai-therapist-170). The org runs under a hard spend cap:
// once it is hit EVERY OpenAI call returns a billing-class 429, including the
// risk assessor and the moderation screen. These tests pin, per failure mode
// and per call site, that:
//   - detection falls back to the keyword tier at minimum, and never scores
//     "no risk" for a message the keyword screen flagged;
//   - a failed call is recorded on the risk row, never passed off as a clean
//     assessment;
//   - a spend-limit rejection reaches the on-call, transient failures do not;
//   - the retry budget is the small crisis one (no SDK retries underneath, no
//     retry on quota, Retry-After honoured only when it is short).
// OpenAI, the DB and the pager are mocked; no network.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { warmCrisisPathImports } from '../testing/warmCrisisImports.js';

const { queryMock, createMock, moderationCreateMock, reportQuotaMock } = vi.hoisted(() => ({
  queryMock: vi.fn(),
  createMock: vi.fn(),
  moderationCreateMock: vi.fn(),
  reportQuotaMock: vi.fn(),
}));

vi.mock('../config/db.js', () => ({ pool: { query: queryMock, connect: vi.fn() } }));
vi.mock('../config/secrets.js', () => ({ getOpenAIKey: vi.fn().mockResolvedValue('test-key') }));
vi.mock('./adverseEvent.service.js', () => ({ draftAdverseEventFromCrisis: vi.fn() }));
vi.mock('./crisisAlert.service.js', () => ({
  reportOpenAIQuotaExhausted: reportQuotaMock,
  reportRiskAssessorOutage: vi.fn().mockResolvedValue(true),
  sendCrisisAlert: vi.fn(),
}));
vi.mock('openai', () => ({
  default: class {
    chat = { completions: { create: createMock } };
    moderations = { create: moderationCreateMock };
  },
}));

const { analyzeMessageRisk, analyzeStandaloneRisk } = await import('./crisisDetection.service.js');
// Loaded up front: the scorer imports these lazily, and since ai-therapist-369
// it starts reading the assessor's settings alongside its other reads, so a
// cold import would land while the fake clock is being advanced.
await import('./moderation.service.js');
await import('../utils/sessionHelpers.js');
await import('../utils/safetyIdentifier.js');

/** An error carrying the fields the SDK's APIError carries. */
function apiError(status: number, code: string, type?: string, headers: Record<string, string> = {}): Error {
  return Object.assign(new Error(`${status} ${code}`), { status, code, type, headers: new Headers(headers) });
}
function timeoutError(): Error {
  class APIConnectionTimeoutError extends Error {}
  return new APIConnectionTimeoutError('Request timed out.');
}

const QUOTA = () => apiError(429, 'organization_spend_limit_exceeded', 'insufficient_quota');
const RATE_LIMIT = () => apiError(429, 'rate_limit_exceeded', 'rate_limit_error');
const SLOW_DOWN = (retryAfter: string) => apiError(429, 'slow_down', 'rate_limit_error', { 'retry-after': retryAfter });
const OVERLOADED = () => apiError(503, 'server_is_overloaded', 'service_unavailable_error');

const llmResponse = (payload: Record<string, unknown>) => ({
  choices: [{ message: { content: JSON.stringify(payload) } }],
});
const GENUINE_HIGH = llmResponse({
  risk_score: 85,
  severity: 'high',
  context: 'genuine',
  factors: ['active ideation'],
  reasoning: 'States intent.',
});
const modResponse = (scores: Record<string, number>) => ({ results: [{ flagged: true, category_scores: scores }] });
const MOD_CLEAN = { results: [{ flagged: false, category_scores: {} }] };

let seq = 0;
const turn = (content: string) => ({ content, session_id: `sess-degraded-${++seq}`, message_id: 1 });

function historyFactors(): Record<string, unknown> {
  const insert = queryMock.mock.calls.find((c) => String(c[0]).includes('INSERT INTO risk_score_history'));
  expect(insert).toBeDefined();
  return JSON.parse(insert![1][4] as string);
}

/** Run to completion under fake timers, advancing through any retry wait. */
async function settle<T>(p: Promise<T>): Promise<T> {
  await vi.advanceTimersByTimeAsync(5000);
  return p;
}

// Load the crisis path's lazy imports now, so the first test to reach the
// assessor does not wait on real module loading under fake timers.
await warmCrisisPathImports();

beforeEach(() => {
  vi.useFakeTimers();
  queryMock.mockReset().mockResolvedValue({ rows: [] });
  createMock.mockReset();
  moderationCreateMock.mockReset().mockResolvedValue(MOD_CLEAN);
  reportQuotaMock.mockReset().mockResolvedValue(undefined);
});
afterEach(() => {
  vi.useRealTimers();
});

describe('hard spend cap: every OpenAI call returns a billing 429', () => {
  beforeEach(() => {
    createMock.mockRejectedValue(QUOTA());
    moderationCreateMock.mockRejectedValue(QUOTA());
  });

  it('still scores explicit ideation high from the keyword tier', async () => {
    const r = await settle(analyzeMessageRisk(turn('I want to end my life'), []));
    expect(r.riskScore).toBe(75);
    expect(r.severity).toBe('high');
    expect(r.factors).toContain('end my life');
  });

  it('still scores passive ideation medium (the flagging threshold) from the keyword tier', async () => {
    const r = await settle(analyzeMessageRisk(turn("I just don't want to be here anymore"), []));
    expect(r.riskScore).toBe(50);
    expect(r.severity).toBe('medium');
  });

  it('does not retry the assessor or moderation: one attempt each, no waiting', async () => {
    await settle(analyzeMessageRisk(turn('I want to end my life'), []));
    expect(createMock).toHaveBeenCalledTimes(1);
    expect(moderationCreateMock).toHaveBeenCalledTimes(1);
  });

  it('pages the on-call about the spend limit from both the assessor and the moderation screen', async () => {
    await settle(analyzeMessageRisk(turn('I want to end my life'), []));
    expect(reportQuotaMock).toHaveBeenCalledWith('risk_assessor', 'organization_spend_limit_exceeded');
    expect(reportQuotaMock).toHaveBeenCalledWith('moderation', 'organization_spend_limit_exceeded');
  });

  it('pages on a keyword-free message too: the moderation screen runs on every turn', async () => {
    const r = await settle(analyzeMessageRisk(turn('tell me about breathing exercises'), []));
    expect(r.riskScore).toBe(0);
    expect(reportQuotaMock).toHaveBeenCalledWith('moderation', 'organization_spend_limit_exceeded');
  });

  it('records on the risk row that both screens were down, not a clean assessment', async () => {
    await settle(analyzeMessageRisk(turn('I want to end my life'), []));
    expect(historyFactors()).toMatchObject({
      method: 'keyword_fallback',
      keyword_score: 75,
      llm_error: 'quota',
      moderation_unavailable: true,
    });
    expect(historyFactors()).not.toHaveProperty('llm_score');
  });

  it('marks a keyword-free score of 0 as moderation-unavailable rather than screened-clean', async () => {
    await settle(analyzeMessageRisk(turn('tell me about breathing exercises'), []));
    expect(historyFactors()).toMatchObject({ method: 'keyword_only', moderation_unavailable: true });
  });

  it('keeps retrying a failed periodic sweep on every following message', async () => {
    const sessionId = 'sess-degraded-sweep';
    const quiet = (i: number) => ({ content: `ordinary message ${i}`, session_id: sessionId, message_id: i });
    for (let i = 1; i <= 7; i++) await settle(analyzeMessageRisk(quiet(i), []));
    expect(createMock).not.toHaveBeenCalled();
    // 8th message: sweep due, assessor rejected. Not counted as a completed sweep.
    await settle(analyzeMessageRisk(quiet(8), []));
    expect(createMock).toHaveBeenCalledTimes(1);
    const factors = queryMock.mock.calls
      .filter((c) => String(c[0]).includes('INSERT INTO risk_score_history'))
      .map((c) => JSON.parse(c[1][4] as string) as Record<string, unknown>);
    expect(factors[7]).toMatchObject({ method: 'keyword_fallback', llm_error: 'quota' });
    // 9th message: the sweep is attempted again, and succeeds once the cap is lifted.
    createMock.mockResolvedValue(GENUINE_HIGH);
    const r = await settle(analyzeMessageRisk(quiet(9), []));
    expect(createMock).toHaveBeenCalledTimes(2);
    expect(r.riskScore).toBe(85);
  });

  it('async messages: a keyword hit keeps its keyword-tier verdict', async () => {
    const r = await settle(analyzeStandaloneRisk('I want to end my life'));
    expect(r).toMatchObject({ riskScore: 75, severity: 'high', method: 'keyword_fallback' });
    expect(r.indeterminate).toBeUndefined();
    expect(createMock).toHaveBeenCalledTimes(1);
    expect(reportQuotaMock).toHaveBeenCalledWith('risk_assessor', 'organization_spend_limit_exceeded');
  });

  it('async messages: a keyword-free message is INDETERMINATE (re-scanned later), never clear', async () => {
    const r = await settle(analyzeStandaloneRisk('I bought a gun yesterday and wrote letters to everyone'));
    expect(r).toMatchObject({ method: 'llm_unavailable', indeterminate: true });
    expect(reportQuotaMock).toHaveBeenCalledWith('risk_assessor', 'organization_spend_limit_exceeded');
  });
});

describe('transient assessor failures: retried once inside a small budget', () => {
  it('runs the live assessor with a 10s timeout and the SDK retries switched off', async () => {
    createMock.mockResolvedValue(GENUINE_HIGH);
    await settle(analyzeMessageRisk(turn('I want to end my life'), []));
    expect(createMock.mock.calls[0][1]).toEqual({ timeout: 10_000, maxRetries: 0 });
    expect(moderationCreateMock.mock.calls[0][1]).toEqual({ maxRetries: 0 });
  });

  it('slow_down with a short Retry-After: waits it out, retries once, uses the LLM verdict', async () => {
    createMock.mockRejectedValueOnce(SLOW_DOWN('1')).mockResolvedValueOnce(GENUINE_HIGH);
    const p = analyzeMessageRisk(turn('I want to end my life'), []);
    await vi.advanceTimersByTimeAsync(900);
    expect(createMock).toHaveBeenCalledTimes(1);
    const r = await settle(p);
    expect(createMock).toHaveBeenCalledTimes(2);
    expect(r.riskScore).toBe(85);
    expect(historyFactors()).toMatchObject({ method: 'llm_assessed', llm_score: 85 });
    expect(historyFactors()).not.toHaveProperty('llm_error');
    expect(reportQuotaMock).not.toHaveBeenCalled();
  });

  it('slow_down with a long Retry-After: no retry, the keyword fallback fires immediately', async () => {
    createMock.mockRejectedValue(SLOW_DOWN('30'));
    const r = await analyzeMessageRisk(turn('I want to end my life'), []);
    expect(createMock).toHaveBeenCalledTimes(1);
    expect(r.riskScore).toBe(75);
    expect(historyFactors()).toMatchObject({ method: 'keyword_fallback', llm_error: 'rate_limit' });
  });

  it.each([
    ['429 rate limit', RATE_LIMIT, 'rate_limit'],
    ['503 server_is_overloaded', OVERLOADED, 'overloaded'],
  ])('%s that persists: two attempts, then the keyword tier stands', async (_label, makeError, kind) => {
    createMock.mockRejectedValue(makeError());
    const r = await settle(analyzeMessageRisk(turn('I want to end my life'), []));
    expect(createMock).toHaveBeenCalledTimes(2);
    expect(r.riskScore).toBe(75);
    expect(r.severity).toBe('high');
    expect(historyFactors()).toMatchObject({ method: 'keyword_fallback', llm_error: kind });
    // Transient trouble is logged and recorded, but it is not a spend-limit page.
    expect(reportQuotaMock).not.toHaveBeenCalled();
  });

  it('503 that clears on the retry: the LLM verdict is used', async () => {
    createMock.mockRejectedValueOnce(OVERLOADED()).mockResolvedValueOnce(GENUINE_HIGH);
    const r = await settle(analyzeMessageRisk(turn('I want to end my life'), []));
    expect(createMock).toHaveBeenCalledTimes(2);
    expect(r.riskScore).toBe(85);
  });

  it('timeout: not retried (it already spent the budget), the keyword tier stands', async () => {
    createMock.mockRejectedValue(timeoutError());
    const r = await analyzeMessageRisk(turn('I want to end my life'), []);
    expect(createMock).toHaveBeenCalledTimes(1);
    expect(r.riskScore).toBe(75);
    expect(historyFactors()).toMatchObject({ method: 'keyword_fallback', llm_error: 'timeout' });
    expect(reportQuotaMock).not.toHaveBeenCalled();
  });

  it('async messages use the same budgets: high tier, 503 twice, then the keyword verdict', async () => {
    createMock.mockRejectedValue(OVERLOADED());
    const r = await settle(analyzeStandaloneRisk('I want to end my life'));
    expect(createMock).toHaveBeenCalledTimes(2);
    expect(r).toMatchObject({ riskScore: 75, severity: 'high', method: 'keyword_fallback' });
  });
});

describe('moderation wake-up when the assessor is down', () => {
  it.each([
    ['429 spend limit', QUOTA],
    ['503 server_is_overloaded', OVERLOADED],
    ['timeout', timeoutError],
  ])('assessor %s: a keyword-free message moderation flagged keeps the moderation score', async (_label, makeError) => {
    moderationCreateMock.mockResolvedValue(modResponse({ 'self-harm/intent': 0.7 }));
    createMock.mockRejectedValue(makeError());
    const r = await settle(analyzeMessageRisk(turn('unusual phrasing with no screen keywords at all'), []));
    expect(r.riskScore).toBe(70);
    // High since the cutoff moved from 75 to 65 (2026-11-18): with the
    // assessor down, a moderation self-harm score of 65 to 74 now pages.
    expect(r.severity).toBe('high');
    expect(historyFactors()).toMatchObject({ method: 'keyword_fallback', moderation_score: 70 });
    expect(historyFactors()).not.toHaveProperty('moderation_unavailable');
  });
});

describe('moderation screen failures', () => {
  it.each([
    ['429 rate limit', RATE_LIMIT],
    ['503 server_is_overloaded', OVERLOADED],
    ['timeout', timeoutError],
  ])('%s: one attempt, no page, the keyword + LLM path is unaffected', async (_label, makeError) => {
    moderationCreateMock.mockRejectedValue(makeError());
    createMock.mockResolvedValue(GENUINE_HIGH);
    const r = await settle(analyzeMessageRisk(turn('I want to end my life'), []));
    expect(moderationCreateMock).toHaveBeenCalledTimes(1);
    expect(r.riskScore).toBe(85);
    expect(historyFactors()).toMatchObject({ method: 'llm_assessed', moderation_unavailable: true });
    expect(reportQuotaMock).not.toHaveBeenCalled();
  });

  it('a healthy moderation screen leaves no degraded marker on the row', async () => {
    createMock.mockResolvedValue(GENUINE_HIGH);
    await settle(analyzeMessageRisk(turn('I want to end my life'), []));
    expect(historyFactors()).not.toHaveProperty('moderation_unavailable');
    expect(historyFactors()).not.toHaveProperty('llm_error');
  });
});

// Review follow-up. The short crisis budget is only safe where the keyword
// fallback already produces the full response (the high tier: flag + page).
// Everywhere else the assessor or the moderation screen is what gets a turn
// to the score that flags, so one transient failure must be waited out, as
// the SDK default did before, and not converted into a lower score.
describe('transient failures where the keyword fallback is not enough', () => {
  const LOW_TIER = 'I feel hopeless, there is no way out';
  const MEDIUM_TIER = "I just don't want to be here anymore";
  const KEYWORD_FREE = 'unusual phrasing with no screen keywords at all';

  /** Advance past every wait the patient budget allows. */
  async function settleLong<T>(p: Promise<T>): Promise<T> {
    await vi.advanceTimersByTimeAsync(130_000);
    return p;
  }

  it('keyword-free turn: a moderation rate limit is retried, so the screen still wakes the assessor', async () => {
    moderationCreateMock
      .mockRejectedValueOnce(SLOW_DOWN('5'))
      .mockResolvedValueOnce(modResponse({ 'self-harm/intent': 0.7 }));
    createMock.mockResolvedValue(GENUINE_HIGH);
    const r = await settleLong(analyzeMessageRisk(turn(KEYWORD_FREE), []));
    expect(moderationCreateMock).toHaveBeenCalledTimes(2);
    expect(r.riskScore).toBe(85);
    expect(historyFactors()).toMatchObject({ method: 'llm_moderation_wake', moderation_score: 70 });
    expect(historyFactors()).not.toHaveProperty('moderation_unavailable');
  });

  it.each([
    ['503', OVERLOADED],
    ['timeout', timeoutError],
  ])('keyword-free turn: a moderation %s is retried too', async (_label, makeError) => {
    moderationCreateMock
      .mockRejectedValueOnce(makeError())
      .mockRejectedValueOnce(makeError())
      .mockResolvedValueOnce(modResponse({ 'self-harm/intent': 0.7 }));
    createMock.mockResolvedValue(GENUINE_HIGH);
    const r = await settleLong(analyzeMessageRisk(turn(KEYWORD_FREE), []));
    expect(moderationCreateMock).toHaveBeenCalledTimes(3);
    expect(r.riskScore).toBe(85);
  });

  it('low keyword tier: a slow_down with a 5s Retry-After is waited out instead of scoring 15', async () => {
    createMock.mockRejectedValueOnce(SLOW_DOWN('5')).mockResolvedValueOnce(GENUINE_HIGH);
    const p = analyzeMessageRisk(turn(LOW_TIER), []);
    await vi.advanceTimersByTimeAsync(4900);
    expect(createMock).toHaveBeenCalledTimes(1);
    const r = await settleLong(p);
    expect(createMock).toHaveBeenCalledTimes(2);
    expect(r.riskScore).toBe(85);
    expect(r.severity).toBe('high');
    expect(historyFactors()).toMatchObject({ method: 'llm_assessed', keyword_score: 15, llm_score: 85 });
  });

  it('low keyword tier: two transient failures in a row still reach the assessor on the third attempt', async () => {
    createMock
      .mockRejectedValueOnce(OVERLOADED())
      .mockRejectedValueOnce(RATE_LIMIT())
      .mockResolvedValueOnce(GENUINE_HIGH);
    const r = await settleLong(analyzeMessageRisk(turn(LOW_TIER), []));
    expect(createMock).toHaveBeenCalledTimes(3);
    expect(r.riskScore).toBe(85);
  });

  it('medium keyword tier: a timeout is retried, so a high verdict is not capped at the medium fallback', async () => {
    createMock.mockRejectedValueOnce(timeoutError()).mockResolvedValueOnce(GENUINE_HIGH);
    const r = await settleLong(analyzeMessageRisk(turn(MEDIUM_TIER), []));
    expect(createMock).toHaveBeenCalledTimes(2);
    expect(r.severity).toBe('high');
  });

  it('periodic sweep: a transient failure is retried within the same turn', async () => {
    const sessionId = 'sess-degraded-sweep-transient';
    const quiet = (i: number) => ({ content: `ordinary message ${i}`, session_id: sessionId, message_id: i });
    for (let i = 1; i <= 7; i++) await settleLong(analyzeMessageRisk(quiet(i), []));
    createMock.mockRejectedValueOnce(SLOW_DOWN('10')).mockResolvedValueOnce(GENUINE_HIGH);
    const r = await settleLong(analyzeMessageRisk(quiet(8), []));
    expect(createMock).toHaveBeenCalledTimes(2);
    expect(r.riskScore).toBe(85);
  });

  it('async messages: a low-tier message is not recorded at its keyword score after one rate limit', async () => {
    createMock.mockRejectedValueOnce(SLOW_DOWN('5')).mockResolvedValueOnce(GENUINE_HIGH);
    const r = await settleLong(analyzeStandaloneRisk(LOW_TIER));
    expect(createMock).toHaveBeenCalledTimes(2);
    expect(r).toMatchObject({ riskScore: 85, severity: 'high', method: 'llm_assessed' });
  });

  it('stays bounded: three attempts, then the screen-tier score with the failure recorded', async () => {
    createMock.mockRejectedValue(OVERLOADED());
    moderationCreateMock.mockRejectedValue(OVERLOADED());
    const r = await settleLong(analyzeMessageRisk(turn(LOW_TIER), []));
    expect(createMock).toHaveBeenCalledTimes(3);
    expect(moderationCreateMock).toHaveBeenCalledTimes(3);
    expect(r.riskScore).toBe(15);
    expect(historyFactors()).toMatchObject({
      method: 'keyword_fallback',
      llm_error: 'overloaded',
      moderation_unavailable: true,
    });
  });

  it('a Retry-After beyond a minute is not waited for', async () => {
    createMock.mockRejectedValue(SLOW_DOWN('300'));
    const r = await analyzeMessageRisk(turn(LOW_TIER), []);
    expect(createMock).toHaveBeenCalledTimes(1);
    expect(r.riskScore).toBe(15);
  });

  it('a spend-cap rejection is still never retried, whatever the tier', async () => {
    createMock.mockRejectedValue(QUOTA());
    moderationCreateMock.mockRejectedValue(QUOTA());
    await analyzeMessageRisk(turn(LOW_TIER), []);
    await analyzeMessageRisk(turn(KEYWORD_FREE), []);
    expect(createMock).toHaveBeenCalledTimes(1);
    expect(moderationCreateMock).toHaveBeenCalledTimes(2);
  });

  it('high keyword tier keeps the short budget: its fallback already flags and pages', async () => {
    createMock.mockRejectedValue(SLOW_DOWN('5'));
    moderationCreateMock.mockRejectedValue(OVERLOADED());
    const r = await analyzeMessageRisk(turn('I want to end my life'), []);
    expect(createMock).toHaveBeenCalledTimes(1);
    expect(moderationCreateMock).toHaveBeenCalledTimes(1);
    expect(r.riskScore).toBe(75);
  });
});
