// Harness price table (ai-therapist-383): flex at half the Standard rate for
// flex-eligible models that requested it, and the cached-input rate for the
// cached share of input when the API reports it.
import { describe, it, expect } from 'vitest';
import { CostTracker, FLEX_PRICE_FACTOR, MODEL_PRICING, priceTokens } from './config.js';

const M = 1_000_000;

describe('priceTokens', () => {
  it('Standard by default', () => {
    expect(priceTokens('gpt-5', M, M)).toBeCloseTo(1.25 + 10, 9);
  });

  it('flex halves a flex-eligible model', () => {
    expect(FLEX_PRICE_FACTOR).toBe(0.5);
    expect(priceTokens('gpt-5', M, M, { flex: true })).toBeCloseTo((1.25 + 10) / 2, 9);
    expect(priceTokens('gpt-5-mini', M, M, { flex: true })).toBeCloseTo((0.25 + 2) / 2, 9);
  });

  it('flex does not apply to a model with no flex tier (gpt-4o-mini)', () => {
    expect(priceTokens('gpt-4o-mini', M, M, { flex: true })).toBeCloseTo(0.15 + 0.6, 9);
  });

  it('cached input is priced at the cached rate', () => {
    // 1M input of which 800k cached, gpt-5.2: 200k x 1.75 + 800k x 0.175
    expect(priceTokens('gpt-5.2', M, 0, { cachedInTok: 800_000 })).toBeCloseTo(0.2 * 1.75 + 0.8 * 0.175, 9);
  });

  it('cached count is clamped to the input count, and never negative', () => {
    expect(priceTokens('gpt-5.2', 1000, 0, { cachedInTok: 5000 })).toBeCloseTo((1000 / M) * 0.175, 12);
    expect(priceTokens('gpt-5.2', 1000, 0, { cachedInTok: -5 })).toBeCloseTo((1000 / M) * 1.75, 12);
  });

  it('a model without a cached rate gets no discount', () => {
    expect(MODEL_PRICING.default.cachedInPerM).toBeUndefined();
    expect(priceTokens('unknown-model', M, 0, { cachedInTok: M })).toBeCloseTo(MODEL_PRICING.default.inPerM, 9);
  });

  it('registry models carry their cached rate (gpt-5-nano via backendModels.ts)', () => {
    expect(priceTokens('gpt-5-nano', M, 0, { cachedInTok: M })).toBeCloseTo(0.005, 9);
  });
});

describe('CostTracker.add reads cached tokens from the usage block', () => {
  it('applies the cached rate to prompt_tokens_details.cached_tokens', () => {
    const t = new CostTracker();
    t.add('gpt-4o-mini', { prompt_tokens: M, completion_tokens: 0, prompt_tokens_details: { cached_tokens: M / 2 } });
    expect(t.usd).toBeCloseTo(0.5 * 0.15 + 0.5 * 0.075, 9);
  });

  it('no details block: full input rate, as before', () => {
    const t = new CostTracker();
    t.add('gpt-4o-mini', { prompt_tokens: M, completion_tokens: 0 });
    expect(t.usd).toBeCloseTo(0.15, 9);
  });
});
