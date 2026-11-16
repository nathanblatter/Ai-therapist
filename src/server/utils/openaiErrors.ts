// OpenAI failure classification + the one shared retry loop (ai-therapist-190,
// ai-therapist-170).
//
// Why this exists: a 429 from OpenAI means two opposite things.
//   - Rate limiting ("Rate limit reached", code `slow_down`): transient. Wait
//     for Retry-After and try again.
//   - Billing / spend / usage ceiling (codes below; `error.type` can still be
//     `insufficient_quota`): permanent until a human raises the limit.
//     OpenAI's error-code guide is explicit that retrying these "won't restore
//     API access". Under a hard monthly cap EVERY call returns this, including
//     the crisis risk assessor, the moderation screen and the voice session
//     mint - so it must be recognised, never retried, and surfaced to a human.
// 503 `server_is_overloaded` is transient and also carries Retry-After.
// Semantics verified against developers.openai.com/api/docs/guides/error-codes
// on 2026-11-16.
//
// SDK coupling (the openai package is being bumped 5 -> 7 in parallel): this
// module deliberately does NOT import the SDK's error classes. It duck-types
// the fields every APIError has carried across major versions (`status`,
// `code`, `type`, `headers`) and recognises connection/timeout errors by
// constructor name and message. `headers` is read through `.get()` when it is
// a Headers object (v5+) and as a plain record otherwise (v4).

export type OpenAIErrorKind =
  /** 429 billing / spend / usage ceiling. Retrying is pointless. */
  | 'quota'
  /** 429 rate limit, including `slow_down`. Retry after Retry-After. */
  | 'rate_limit'
  /** 503, including `server_is_overloaded`. Retry after Retry-After. */
  | 'overloaded'
  /** Any other 5xx. */
  | 'server_error'
  /** The request timed out client-side (no response). */
  | 'timeout'
  /** The connection failed before a response arrived. */
  | 'connection'
  /** Everything else (4xx, refusals, parse errors). Never retried. */
  | 'other';

export interface OpenAIErrorInfo {
  kind: OpenAIErrorKind;
  status: number | null;
  code: string | null;
  /** Server-requested wait, when a Retry-After / retry-after-ms header was sent. */
  retryAfterMs: number | null;
}

// `error.code` values that mean "a billing, spend or usage ceiling was hit".
// The first four are the codes the error-code guide documents today;
// `insufficient_quota` is the older code (and still the documented
// `error.type` for the whole family); `billing_hard_limit_reached` is the
// legacy hard-limit code. Listing an extra code here is harmless: it only
// stops a retry.
const QUOTA_CODES = new Set([
  'credit_balance_exhausted',
  'organization_spend_limit_exceeded',
  'project_spend_limit_exceeded',
  'organization_usage_limit_exceeded',
  'insufficient_quota',
  'billing_hard_limit_reached',
]);

/** True when a 429's code/type marks a billing, spend or usage ceiling. */
export function isQuotaError(code: unknown, type: unknown): boolean {
  return (typeof code === 'string' && QUOTA_CODES.has(code)) || type === 'insufficient_quota';
}

function readHeader(headers: unknown, name: string): string | null {
  if (!headers || typeof headers !== 'object') return null;
  const get = (headers as { get?: unknown }).get;
  if (typeof get === 'function') {
    const value = (get as (n: string) => unknown).call(headers, name);
    return typeof value === 'string' ? value : null;
  }
  const value = (headers as Record<string, unknown>)[name];
  return typeof value === 'string' ? value : null;
}

/** Retry-After (seconds or HTTP date) / retry-after-ms as milliseconds, or null. */
export function parseRetryAfterMs(headers: unknown, now: number = Date.now()): number | null {
  const ms = readHeader(headers, 'retry-after-ms');
  if (ms) {
    const parsed = Number.parseFloat(ms);
    if (Number.isFinite(parsed) && parsed >= 0) return parsed;
  }
  const raw = readHeader(headers, 'retry-after');
  if (!raw) return null;
  const seconds = Number.parseFloat(raw);
  if (Number.isFinite(seconds)) return seconds >= 0 ? seconds * 1000 : null;
  const date = Date.parse(raw);
  return Number.isFinite(date) ? Math.max(0, date - now) : null;
}

/** Classify an HTTP-level failure from its status and error fields. */
export function classifyOpenAIStatus(status: number, code: unknown, type: unknown, headers?: unknown): OpenAIErrorInfo {
  const info = {
    status,
    code: typeof code === 'string' ? code : null,
    retryAfterMs: parseRetryAfterMs(headers),
  };
  if (status === 429) return { ...info, kind: isQuotaError(code, type) ? 'quota' : 'rate_limit' };
  if (status === 503) return { ...info, kind: 'overloaded' };
  if (status >= 500) return { ...info, kind: 'server_error' };
  return { ...info, kind: 'other' };
}

/** Classify a raw fetch failure body (`{ error: { code, type } }` JSON text). */
export function classifyOpenAIResponse(status: number, bodyText: string, headers?: unknown): OpenAIErrorInfo {
  let error: { code?: unknown; type?: unknown } | undefined;
  try {
    error = (JSON.parse(bodyText) as { error?: { code?: unknown; type?: unknown } } | null)?.error;
  } catch {
    /* non-JSON body: classify on status alone */
  }
  return classifyOpenAIStatus(status, error?.code, error?.type, headers);
}

/** Classify anything thrown by an OpenAI SDK call or a fetch to the API. */
export function classifyOpenAIError(err: unknown): OpenAIErrorInfo {
  const e = (err ?? {}) as {
    status?: unknown;
    code?: unknown;
    type?: unknown;
    headers?: unknown;
    name?: unknown;
    message?: unknown;
    constructor?: { name?: unknown };
  };
  if (typeof e.status === 'number') return classifyOpenAIStatus(e.status, e.code, e.type, e.headers);

  const none = { status: null, code: typeof e.code === 'string' ? e.code : null, retryAfterMs: null };
  const names = `${typeof e.name === 'string' ? e.name : ''} ${typeof e.constructor?.name === 'string' ? e.constructor.name : ''}`;
  const message = typeof e.message === 'string' ? e.message : '';
  // SDK: APIConnectionTimeoutError ("Request timed out."). fetch + AbortSignal.timeout: TimeoutError / AbortError.
  if (/Timeout|AbortError/.test(names) || /timed out|timeout/i.test(message)) return { ...none, kind: 'timeout' };
  // SDK: APIConnectionError ("Connection error."). fetch: TypeError "fetch failed" / ECONN* codes.
  if (
    /APIConnectionError/.test(names) ||
    /connection error|fetch failed|socket hang up|network/i.test(message) ||
    (typeof e.code === 'string' && /^(ECONN|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|EPIPE|UND_ERR)/.test(e.code))
  ) {
    return { ...none, kind: 'connection' };
  }
  return { ...none, kind: 'other' };
}

// ============================================
// RETRY
// ============================================

export interface OpenAIRetryPolicy {
  /** Total attempts including the first. */
  maxAttempts: number;
  /** Longest single wait. A Retry-After beyond this ends the retries at once:
   *  retrying sooner than the server asked just earns another rejection. */
  maxDelayMs: number;
  /** Cap on the sum of all waits. */
  maxTotalDelayMs: number;
  /** Whether a client-side timeout is worth another attempt. */
  retryTimeouts: boolean;
}

/**
 * Crisis path (risk assessor): ONE retry, after at most 2 seconds, and never
 * after a timeout. The fallback here is the keyword-tier score, which is
 * already computed - so waiting only delays the flag/page it would produce.
 * With the assessor's 10s per-attempt timeout the worst case before the
 * fallback fires is ~12s (a fast rejection, a 2s wait, then a full timeout);
 * a quota rejection falls back after a single round trip.
 */
export const CRISIS_RETRY_POLICY: OpenAIRetryPolicy = {
  maxAttempts: 2,
  maxDelayMs: 2_000,
  maxTotalDelayMs: 2_000,
  retryTimeouts: false,
};

/** Background jobs (embeddings sweeps and the like): patient but bounded. */
export const BACKGROUND_RETRY_POLICY: OpenAIRetryPolicy = {
  maxAttempts: 3,
  maxDelayMs: 30_000,
  maxTotalDelayMs: 60_000,
  retryTimeouts: true,
};

const RETRYABLE_KINDS = new Set<OpenAIErrorKind>(['rate_limit', 'overloaded', 'server_error', 'connection']);

/**
 * The wait before retry number `retryIndex` (0-based), or null when the
 * failure must not be retried under `policy`. Quota exhaustion is never
 * retried. Retry-After is honoured exactly when the server sends one;
 * otherwise 0.5s, 1s, 2s... exponential backoff.
 */
export function nextRetryDelayMs(
  info: OpenAIErrorInfo,
  retryIndex: number,
  waitedMs: number,
  policy: OpenAIRetryPolicy,
): number | null {
  if (retryIndex + 1 >= policy.maxAttempts) return null;
  const retryable = RETRYABLE_KINDS.has(info.kind) || (info.kind === 'timeout' && policy.retryTimeouts);
  if (!retryable) return null;
  if (info.retryAfterMs !== null && info.retryAfterMs > policy.maxDelayMs) return null;
  const delay = info.retryAfterMs ?? Math.min(500 * 2 ** retryIndex, policy.maxDelayMs);
  return waitedMs + delay > policy.maxTotalDelayMs ? null : delay;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Run an OpenAI call under `policy`. This is meant to be the ONLY retry layer
 * around `call`: pass `maxRetries: 0` to the SDK request, otherwise the SDK's
 * own default (2 retries on every 429 including quota, honouring Retry-After
 * up to 60s) stacks underneath. Rethrows the last error unchanged.
 */
export async function withOpenAIRetry<T>(call: () => Promise<T>, policy: OpenAIRetryPolicy): Promise<T> {
  let waitedMs = 0;
  for (let retryIndex = 0; ; retryIndex++) {
    try {
      return await call();
    } catch (err) {
      const delay = nextRetryDelayMs(classifyOpenAIError(err), retryIndex, waitedMs, policy);
      if (delay === null) throw err;
      waitedMs += delay;
      await sleep(delay);
    }
  }
}
