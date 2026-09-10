// Flex service tier for latency-insensitive post-session work
// (ai-therapist-180). Flex prices at Batch rates — 50% of standard — and
// stacks with prompt caching, in exchange for slower, best-effort capacity.
//
// Rules of use:
// - NEVER on the live participant path (chat turns, realtime, crisis
//   assessment). Only post-session jobs: redaction, insights, SOAP, evals.
// - Flex is beta with limited model availability, and gpt-4o-mini is NOT
//   eligible. Eligible: gpt-6-astra, gpt-5.6-*, gpt-5.5, gpt-5.4 family,
//   gpt-5.2, gpt-5.1, gpt-5/mini/nano, o3, o4-mini.
// - Flex can return 429 "Resource Unavailable" when there is no spare
//   capacity. That request is NOT billed; the correct response is to retry
//   on the default tier rather than fail the job.
// - Requests take longer, so callers should raise their client timeout.

/** Model families OpenAI lists as flex-eligible. */
const FLEX_ELIGIBLE = /^(gpt-6|gpt-5\.6|gpt-5\.5|gpt-5\.4|gpt-5\.2|gpt-5\.1|gpt-5(-|$)|o3(-|$)|o4-mini)/;

// Explicitly ineligible despite matching a family prefix above: the -pro
// variants, and o3-mini (o3 itself IS eligible — the hyphen makes it an easy
// false positive).
const FLEX_EXCLUDED = /-pro(-|$)|^o3-mini/;

export function isFlexEligible(model: string): boolean {
  return FLEX_ELIGIBLE.test(model) && !FLEX_EXCLUDED.test(model);
}

/** `{ service_tier: 'flex' }` when the model supports it, else `{}`. */
export function flexParams(model: string): Record<string, string> {
  return isFlexEligible(model) ? { service_tier: 'flex' } : {};
}

/** True for the 429 that means "no flex capacity right now" (unbilled). */
export function isFlexCapacityError(err: unknown): boolean {
  const status = (err as { status?: number })?.status;
  if (status !== 429) return false;
  const message = err instanceof Error ? err.message : String(err);
  // A genuine rate-limit says so; the flex capacity signal does not.
  return !/rate limit|requests per|tokens per|quota/i.test(message);
}

/**
 * Run `call` on the flex tier, transparently retrying on the default tier if
 * flex has no capacity. `call` receives the extra params to spread into the
 * request. Any other error propagates unchanged.
 */
export async function withFlex<T>(
  model: string,
  call: (extraParams: Record<string, string>) => Promise<T>,
): Promise<T> {
  const params = flexParams(model);
  if (Object.keys(params).length === 0) return call({});
  try {
    return await call(params);
  } catch (err) {
    if (!isFlexCapacityError(err)) throw err;
    return call({});
  }
}
