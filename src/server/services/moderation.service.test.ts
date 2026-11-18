// Moderation screen failure reporting (ai-therapist-190). The screen is a
// supplementary signal that must never throw - but "could not run" has to be
// distinguishable from "ran and found nothing", and a spend-limit rejection
// has to reach the on-call. OpenAI and the pager are mocked.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { moderationCreateMock, reportQuotaMock } = vi.hoisted(() => ({
  moderationCreateMock: vi.fn(),
  reportQuotaMock: vi.fn(),
}));

vi.mock('../config/secrets.js', () => ({ getOpenAIKey: vi.fn().mockResolvedValue('test-key') }));
vi.mock('./crisisAlert.service.js', () => ({ reportOpenAIQuotaExhausted: reportQuotaMock }));
vi.mock('openai', () => ({
  default: class {
    moderations = { create: moderationCreateMock };
  },
}));

const { getSelfHarmScreen, getSelfHarmScores } = await import('./moderation.service.js');

function apiError(status: number, code: string, type?: string): Error {
  return Object.assign(new Error(`${status} ${code}`), { status, code, type, headers: new Headers() });
}

beforeEach(() => {
  moderationCreateMock.mockReset();
  reportQuotaMock.mockReset().mockResolvedValue(undefined);
});

describe('getSelfHarmScreen', () => {
  it('returns scores and failed=false when the screen ran', async () => {
    moderationCreateMock.mockResolvedValue({
      results: [{ flagged: true, category_scores: { 'self-harm/intent': 0.7, 'self-harm': 0.2 } }],
    });
    expect(await getSelfHarmScreen('some text')).toEqual({
      scores: { flagged: true, selfHarm: 0.2, selfHarmIntent: 0.7, selfHarmInstructions: 0 },
      failed: false,
    });
  });

  it('a healthy screen is one call, with the SDK retries switched off', async () => {
    moderationCreateMock.mockResolvedValue({ results: [{ flagged: false, category_scores: {} }] });
    await getSelfHarmScreen('some text');
    expect(moderationCreateMock).toHaveBeenCalledTimes(1);
    expect(moderationCreateMock.mock.calls[0][1]).toEqual({ maxRetries: 0 });
  });

  it('empty text is not a failure and makes no call', async () => {
    expect(await getSelfHarmScreen('   ')).toEqual({ scores: null, failed: false });
    expect(moderationCreateMock).not.toHaveBeenCalled();
  });

  it('spend-limit 429: failed, kind quota, and the on-call is told', async () => {
    moderationCreateMock.mockRejectedValue(apiError(429, 'project_spend_limit_exceeded', 'insufficient_quota'));
    expect(await getSelfHarmScreen('some text')).toEqual({ scores: null, failed: true, errorKind: 'quota' });
    await vi.waitFor(() => expect(reportQuotaMock).toHaveBeenCalledWith('moderation', 'project_spend_limit_exceeded'));
  });

  it.each([
    ['429 slow_down', apiError(429, 'slow_down', 'rate_limit_error'), 'rate_limit'],
    ['503 server_is_overloaded', apiError(503, 'server_is_overloaded'), 'overloaded'],
    ['timeout', new Error('Request timed out.'), 'timeout'],
  ])("%s on the 'fast' budget: one attempt, failed with its kind, no spend-limit page", async (_label, err, kind) => {
    moderationCreateMock.mockRejectedValue(err);
    expect(await getSelfHarmScreen('some text', 'fast')).toEqual({ scores: null, failed: true, errorKind: kind });
    expect(moderationCreateMock).toHaveBeenCalledTimes(1);
    expect(reportQuotaMock).not.toHaveBeenCalled();
  });

  describe("the default 'patient' budget", () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it.each([
      ['429 slow_down', apiError(429, 'slow_down', 'rate_limit_error'), 'rate_limit'],
      ['503 server_is_overloaded', apiError(503, 'server_is_overloaded'), 'overloaded'],
      ['timeout', new Error('Request timed out.'), 'timeout'],
    ])('%s that persists: three attempts, then failed with its kind, no page', async (_label, err, kind) => {
      moderationCreateMock.mockRejectedValue(err);
      const p = getSelfHarmScreen('some text');
      await vi.advanceTimersByTimeAsync(130_000);
      expect(await p).toEqual({ scores: null, failed: true, errorKind: kind });
      expect(moderationCreateMock).toHaveBeenCalledTimes(3);
      expect(reportQuotaMock).not.toHaveBeenCalled();
    });

    it('a transient failure that clears is not a failure at all', async () => {
      moderationCreateMock
        .mockRejectedValueOnce(apiError(503, 'server_is_overloaded'))
        .mockResolvedValueOnce({ results: [{ flagged: true, category_scores: { 'self-harm/intent': 0.7 } }] });
      const p = getSelfHarmScreen('some text');
      await vi.advanceTimersByTimeAsync(130_000);
      expect(await p).toMatchObject({ scores: { selfHarmIntent: 0.7 }, failed: false });
      // Each attempt still has the SDK's own retries switched off.
      expect(moderationCreateMock.mock.calls.map((c) => c[1])).toEqual([{ maxRetries: 0 }, { maxRetries: 0 }]);
    });

    it('a spend-limit 429 is not retried', async () => {
      moderationCreateMock.mockRejectedValue(apiError(429, 'project_spend_limit_exceeded', 'insufficient_quota'));
      expect(await getSelfHarmScreen('some text')).toMatchObject({ failed: true, errorKind: 'quota' });
      expect(moderationCreateMock).toHaveBeenCalledTimes(1);
    });
  });

  it('a response with no result is a failure, not a clean screen', async () => {
    moderationCreateMock.mockResolvedValue({ results: [] });
    expect(await getSelfHarmScreen('some text')).toMatchObject({ scores: null, failed: true });
  });
});

describe('getSelfHarmScores (unchanged contract)', () => {
  it('still returns null on any failure and never throws', async () => {
    moderationCreateMock.mockRejectedValue(apiError(429, 'insufficient_quota'));
    expect(await getSelfHarmScores('some text')).toBeNull();
  });
});
