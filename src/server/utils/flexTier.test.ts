// Flex tier must only ever apply to eligible models (an ineligible model
// 400s the request) and must never let a flex capacity shortage fail a job
// that would have succeeded on the default tier.
import { describe, it, expect, vi } from 'vitest';
import { isFlexEligible, flexParams, isFlexCapacityError, withFlex } from './flexTier.js';

describe('isFlexEligible', () => {
  it('accepts the documented eligible families', () => {
    for (const model of [
      'gpt-6-astra', 'gpt-5.6-luna', 'gpt-5.6-sol', 'gpt-5.5', 'gpt-5.4-mini',
      'gpt-5.2', 'gpt-5.1', 'gpt-5', 'gpt-5-mini', 'gpt-5-nano', 'o3', 'o4-mini',
    ]) {
      expect(isFlexEligible(model), model).toBe(true);
    }
  });

  it('rejects the documented ineligible models', () => {
    for (const model of [
      'gpt-4o-mini', 'gpt-4o', 'gpt-4.1', 'gpt-4.1-mini', 'o3-mini',
      'gpt-5-pro', 'gpt-5.2-pro', 'omni-moderation-latest', 'text-embedding-3-small',
      'gpt-realtime-2.1-mini', 'gpt-transcribe',
    ]) {
      expect(isFlexEligible(model), model).toBe(false);
    }
  });

  it('flexParams is empty for ineligible models so the spread is a no-op', () => {
    expect(flexParams('gpt-5')).toEqual({ service_tier: 'flex' });
    expect(flexParams('gpt-4o-mini')).toEqual({});
  });
});

describe('isFlexCapacityError', () => {
  const err = (status: number, message: string) => Object.assign(new Error(message), { status });

  it('treats a bare 429 as a flex capacity shortage', () => {
    expect(isFlexCapacityError(err(429, 'Resource Unavailable'))).toBe(true);
  });

  it('does not mistake a real rate limit for a capacity shortage', () => {
    expect(isFlexCapacityError(err(429, 'Rate limit reached for requests per min'))).toBe(false);
    expect(isFlexCapacityError(err(429, 'You exceeded your current quota'))).toBe(false);
  });

  it('ignores non-429 errors', () => {
    expect(isFlexCapacityError(err(500, 'Resource Unavailable'))).toBe(false);
    expect(isFlexCapacityError(new Error('boom'))).toBe(false);
  });
});

describe('withFlex', () => {
  it('passes the flex param for eligible models', async () => {
    const call = vi.fn().mockResolvedValue('ok');
    await expect(withFlex('gpt-5', call)).resolves.toBe('ok');
    expect(call).toHaveBeenCalledWith({ service_tier: 'flex' });
  });

  it('skips flex entirely for ineligible models (single call, no params)', async () => {
    const call = vi.fn().mockResolvedValue('ok');
    await withFlex('gpt-4o-mini', call);
    expect(call).toHaveBeenCalledTimes(1);
    expect(call).toHaveBeenCalledWith({});
  });

  it('retries on the default tier when flex has no capacity', async () => {
    const call = vi.fn()
      .mockRejectedValueOnce(Object.assign(new Error('Resource Unavailable'), { status: 429 }))
      .mockResolvedValueOnce('ok');
    await expect(withFlex('gpt-5', call)).resolves.toBe('ok');
    expect(call).toHaveBeenNthCalledWith(1, { service_tier: 'flex' });
    expect(call).toHaveBeenNthCalledWith(2, {});
  });

  it('propagates any other error without retrying', async () => {
    const call = vi.fn().mockRejectedValue(new Error('bad request'));
    await expect(withFlex('gpt-5', call)).rejects.toThrow('bad request');
    expect(call).toHaveBeenCalledTimes(1);
  });
});
