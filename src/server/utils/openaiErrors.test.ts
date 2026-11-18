// OpenAI failure classification + the shared retry loop (ai-therapist-190,
// ai-therapist-170). The classification table mirrors OpenAI's error-code
// guide as read on 2026-11-16: billing/spend/usage 429s are terminal, rate
// limit / slow_down 429s and 503 server_is_overloaded carry Retry-After.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { APIError, APIConnectionError, APIConnectionTimeoutError } from 'openai';
import {
  classifyOpenAIError,
  classifyOpenAIResponse,
  parseRetryAfterMs,
  nextRetryDelayMs,
  withOpenAIRetry,
  CRISIS_RETRY_POLICY,
  BACKGROUND_RETRY_POLICY,
  type OpenAIErrorInfo,
} from './openaiErrors.js';

/** An error shaped the way the SDK builds one, via its own factory. */
function sdkError(status: number, error: Record<string, unknown>, headers: Record<string, string> = {}): unknown {
  return APIError.generate(status, { error }, undefined, new Headers(headers));
}

describe('classifyOpenAIError', () => {
  it.each([
    'credit_balance_exhausted',
    'organization_spend_limit_exceeded',
    'project_spend_limit_exceeded',
    'organization_usage_limit_exceeded',
    'insufficient_quota',
    'billing_hard_limit_reached',
  ])('treats 429 %s as quota exhaustion', (code) => {
    expect(classifyOpenAIError(sdkError(429, { code, message: 'limit reached' }))).toMatchObject({
      kind: 'quota',
      status: 429,
      code,
    });
  });

  it('treats a 429 whose type is insufficient_quota as quota even with an unknown code', () => {
    expect(classifyOpenAIError(sdkError(429, { code: 'some_new_billing_code', type: 'insufficient_quota' })).kind).toBe(
      'quota',
    );
  });

  it('treats slow_down and plain rate limits as retryable rate limiting, with Retry-After', () => {
    expect(
      classifyOpenAIError(sdkError(429, { code: 'slow_down', type: 'rate_limit_error' }, { 'retry-after': '2' })),
    ).toEqual({ kind: 'rate_limit', status: 429, code: 'slow_down', retryAfterMs: 2000 });
    expect(classifyOpenAIError(sdkError(429, { code: 'rate_limit_exceeded' })).kind).toBe('rate_limit');
    // A 429 with no body at all is a rate limit, not quota: quota needs a positive signal.
    expect(classifyOpenAIError(APIError.generate(429, undefined, undefined, new Headers())).kind).toBe('rate_limit');
  });

  it('treats 503 server_is_overloaded as overloaded, other 5xx as server_error', () => {
    expect(
      classifyOpenAIError(
        sdkError(503, { code: 'server_is_overloaded', type: 'service_unavailable_error' }, { 'retry-after': '1' }),
      ),
    ).toEqual({ kind: 'overloaded', status: 503, code: 'server_is_overloaded', retryAfterMs: 1000 });
    expect(classifyOpenAIError(sdkError(500, { message: 'boom' })).kind).toBe('server_error');
  });

  it('recognises the SDK timeout and connection errors without importing their classes', () => {
    expect(classifyOpenAIError(new APIConnectionTimeoutError()).kind).toBe('timeout');
    expect(classifyOpenAIError(new APIConnectionError({ message: undefined, cause: undefined })).kind).toBe(
      'connection',
    );
  });

  it('recognises fetch-level timeouts and network failures', () => {
    expect(classifyOpenAIError(new DOMException('The operation timed out', 'TimeoutError')).kind).toBe('timeout');
    expect(classifyOpenAIError(new TypeError('fetch failed')).kind).toBe('connection');
    expect(classifyOpenAIError(Object.assign(new Error('read'), { code: 'ECONNRESET' })).kind).toBe('connection');
  });

  it('never calls a client error, a refusal or a parse failure retryable', () => {
    expect(classifyOpenAIError(sdkError(400, { code: 'invalid_request_error' })).kind).toBe('other');
    expect(classifyOpenAIError(sdkError(401, { code: 'invalid_api_key' })).kind).toBe('other');
    expect(classifyOpenAIError(new Error('Risk assessor refused to answer')).kind).toBe('other');
    expect(classifyOpenAIError(new SyntaxError('Unexpected token')).kind).toBe('other');
    expect(classifyOpenAIError(undefined).kind).toBe('other');
  });

  it('reads headers given as a plain record (older SDK majors)', () => {
    const err = Object.assign(new Error('429'), { status: 429, code: 'slow_down', headers: { 'retry-after': '3' } });
    expect(classifyOpenAIError(err).retryAfterMs).toBe(3000);
  });
});

describe('classifyOpenAIResponse (raw fetch failures)', () => {
  it('reads the code and type out of the error body', () => {
    const body = JSON.stringify({ error: { code: 'organization_spend_limit_exceeded', type: 'insufficient_quota' } });
    expect(classifyOpenAIResponse(429, body).kind).toBe('quota');
    expect(classifyOpenAIResponse(429, JSON.stringify({ error: { code: 'slow_down' } })).kind).toBe('rate_limit');
  });

  it('falls back to the status when the body is not JSON', () => {
    expect(classifyOpenAIResponse(429, 'Too Many Requests').kind).toBe('rate_limit');
    expect(classifyOpenAIResponse(503, '<html>').kind).toBe('overloaded');
    expect(classifyOpenAIResponse(400, '').kind).toBe('other');
  });
});

describe('parseRetryAfterMs', () => {
  it('prefers retry-after-ms, then seconds, then an HTTP date', () => {
    expect(parseRetryAfterMs(new Headers({ 'retry-after-ms': '250', 'retry-after': '9' }))).toBe(250);
    expect(parseRetryAfterMs(new Headers({ 'retry-after': '1.5' }))).toBe(1500);
    const now = Date.parse('2026-11-16T00:00:00Z');
    expect(parseRetryAfterMs(new Headers({ 'retry-after': 'Mon, 16 Nov 2026 00:00:05 GMT' }), now)).toBe(5000);
  });

  it('returns null when there is no usable header', () => {
    expect(parseRetryAfterMs(new Headers())).toBeNull();
    expect(parseRetryAfterMs(undefined)).toBeNull();
    expect(parseRetryAfterMs(new Headers({ 'retry-after': 'soon' }))).toBeNull();
    expect(parseRetryAfterMs(new Headers({ 'retry-after': '-1' }))).toBeNull();
  });
});

describe('nextRetryDelayMs', () => {
  const info = (kind: OpenAIErrorInfo['kind'], retryAfterMs: number | null = null): OpenAIErrorInfo => ({
    kind,
    status: null,
    code: null,
    retryAfterMs,
  });

  it('never retries quota exhaustion, under any policy', () => {
    expect(nextRetryDelayMs(info('quota'), 0, 0, CRISIS_RETRY_POLICY)).toBeNull();
    expect(nextRetryDelayMs(info('quota', 100), 0, 0, BACKGROUND_RETRY_POLICY)).toBeNull();
  });

  it('honours Retry-After exactly when it fits the budget', () => {
    expect(nextRetryDelayMs(info('rate_limit', 1200), 0, 0, CRISIS_RETRY_POLICY)).toBe(1200);
    expect(nextRetryDelayMs(info('overloaded', 20_000), 0, 0, BACKGROUND_RETRY_POLICY)).toBe(20_000);
  });

  it('gives up at once when Retry-After exceeds the budget instead of retrying early', () => {
    expect(nextRetryDelayMs(info('rate_limit', 5000), 0, 0, CRISIS_RETRY_POLICY)).toBeNull();
    expect(nextRetryDelayMs(info('overloaded', 31_000), 0, 0, BACKGROUND_RETRY_POLICY)).toBeNull();
  });

  it('backs off exponentially without a header, within the total-wait cap', () => {
    expect(nextRetryDelayMs(info('server_error'), 0, 0, BACKGROUND_RETRY_POLICY)).toBe(500);
    expect(nextRetryDelayMs(info('server_error'), 1, 500, BACKGROUND_RETRY_POLICY)).toBe(1000);
    expect(nextRetryDelayMs(info('rate_limit', 30_000), 1, 30_000, BACKGROUND_RETRY_POLICY)).toBe(30_000);
    expect(nextRetryDelayMs(info('rate_limit', 30_000), 1, 30_001, BACKGROUND_RETRY_POLICY)).toBeNull();
  });

  it('stops at the attempt cap', () => {
    expect(nextRetryDelayMs(info('rate_limit'), 1, 0, CRISIS_RETRY_POLICY)).toBeNull();
    expect(nextRetryDelayMs(info('rate_limit'), 2, 0, BACKGROUND_RETRY_POLICY)).toBeNull();
  });

  it('retries a timeout only where the policy says it is worth it', () => {
    expect(nextRetryDelayMs(info('timeout'), 0, 0, CRISIS_RETRY_POLICY)).toBeNull();
    expect(nextRetryDelayMs(info('timeout'), 0, 0, BACKGROUND_RETRY_POLICY)).toBe(500);
  });

  it('never retries an unclassified failure', () => {
    expect(nextRetryDelayMs(info('other'), 0, 0, BACKGROUND_RETRY_POLICY)).toBeNull();
  });
});

describe('the crisis retry budget', () => {
  it('is one retry after at most two seconds', () => {
    expect(CRISIS_RETRY_POLICY).toEqual({
      maxAttempts: 2,
      maxDelayMs: 2000,
      maxTotalDelayMs: 2000,
      retryTimeouts: false,
    });
  });
});

describe('withOpenAIRetry', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('waits out Retry-After on slow_down, then returns the retry result', async () => {
    const call = vi
      .fn()
      .mockRejectedValueOnce(sdkError(429, { code: 'slow_down' }, { 'retry-after': '1' }))
      .mockResolvedValueOnce('ok');
    const p = withOpenAIRetry(call, CRISIS_RETRY_POLICY);
    await vi.advanceTimersByTimeAsync(999);
    expect(call).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await expect(p).resolves.toBe('ok');
    expect(call).toHaveBeenCalledTimes(2);
  });

  it('rethrows a quota rejection immediately, unchanged, without waiting', async () => {
    const quota = sdkError(429, { code: 'organization_spend_limit_exceeded', type: 'insufficient_quota' });
    const call = vi.fn().mockRejectedValue(quota);
    await expect(withOpenAIRetry(call, BACKGROUND_RETRY_POLICY)).rejects.toBe(quota);
    expect(call).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('gives up after the attempt cap and rethrows the last error', async () => {
    const overloaded = sdkError(503, { code: 'server_is_overloaded' });
    const call = vi.fn().mockRejectedValue(overloaded);
    const p = withOpenAIRetry(call, CRISIS_RETRY_POLICY).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(500);
    expect(await p).toBe(overloaded);
    expect(call).toHaveBeenCalledTimes(2);
  });

  it('does not retry at all when the server asks for longer than the budget', async () => {
    const call = vi.fn().mockRejectedValue(sdkError(429, { code: 'slow_down' }, { 'retry-after': '30' }));
    await expect(withOpenAIRetry(call, CRISIS_RETRY_POLICY)).rejects.toBeDefined();
    expect(call).toHaveBeenCalledTimes(1);
  });
});
