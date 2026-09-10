// Real OpenAI spend for the admin ops panel (ai-therapist-181).
//
// Requires an ADMIN API key, which is a different credential class from the
// project key the app runs on: admin keys can read org-wide billing but
// cannot call inference endpoints. It is read from OPENAI_ADMIN_KEY and used
// ONLY here, server-side. When the variable is absent the whole feature
// no-ops (`configured: false`) so the panel degrades to a hint instead of an
// error — the study can run perfectly well without it.
//
// API shape notes that bit during implementation:
// - /organization/costs supports bucket_width '1d' ONLY, and `limit` is a
//   number of buckets (1-180), not a number of rows.
// - There is no group_by=model on the costs endpoint; the model lives inside
//   the line_item string (e.g. "gpt-5.2, input_tokens").
// - Amounts arrive as {value, currency}, already in real dollars.
// - Data availability lags by an undocumented amount, so callers should
//   treat the most recent day as provisional.
import { createLogger } from '../utils/logger.js';

const log = createLogger('openai-costs');

const COSTS_URL = 'https://api.openai.com/v1/organization/costs';
const TIMEOUT_MS = 15_000;

export interface DailyCost {
  /** ISO date (UTC) for the bucket start. */
  date: string;
  amountUsd: number;
}

export interface CostsSummary {
  configured: boolean;
  totalUsd: number;
  days: DailyCost[];
  /** Spend per line item (model + token type), highest first. */
  byLineItem: Array<{ lineItem: string; amountUsd: number }>;
  fetchedAt: string;
}

const NOT_CONFIGURED: CostsSummary = {
  configured: false,
  totalUsd: 0,
  days: [],
  byLineItem: [],
  fetchedAt: new Date(0).toISOString(),
};

interface CostBucket {
  start_time?: number;
  results?: Array<{
    amount?: { value?: number; currency?: string };
    line_item?: string | null;
  }>;
}

// Small in-process cache: the panel polls, the data updates daily, and the
// endpoint is rate-limited more tightly than inference.
const CACHE_TTL_MS = 10 * 60 * 1000;
let cache: { at: number; days: number; value: CostsSummary } | null = null;

/** Whether an admin key is present (drives the panel's empty state). */
export function costsConfigured(): boolean {
  return Boolean(process.env.OPENAI_ADMIN_KEY);
}

/**
 * Daily OpenAI spend for the trailing `days` days, grouped by line item.
 * Never throws — returns `configured: false` on any failure so a billing
 * hiccup can never take down the ops dashboard.
 */
export async function getCostsSummary(days = 30): Promise<CostsSummary> {
  const adminKey = process.env.OPENAI_ADMIN_KEY;
  if (!adminKey) return NOT_CONFIGURED;

  const bounded = Math.min(Math.max(Math.round(days), 1), 180);
  if (cache && cache.days === bounded && Date.now() - cache.at < CACHE_TTL_MS) {
    return cache.value;
  }

  // start_time is required and is a Unix timestamp; align to a day boundary
  // so bucket starts are stable across polls.
  const startTime = Math.floor((Date.now() - bounded * 24 * 60 * 60 * 1000) / 1000);
  const url =
    `${COSTS_URL}?start_time=${startTime}&bucket_width=1d&limit=${bounded}&group_by=line_item`;

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    let response: Response;
    try {
      response = await fetch(url, {
        headers: { Authorization: `Bearer ${adminKey}` },
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      log.warn(
        { status: response.status },
        'OpenAI costs request failed (is OPENAI_ADMIN_KEY an *admin* key?)'
      );
      return NOT_CONFIGURED;
    }

    const body = (await response.json()) as { data?: CostBucket[] };
    const buckets = Array.isArray(body.data) ? body.data : [];

    const days_: DailyCost[] = [];
    const lineItems = new Map<string, number>();
    let totalUsd = 0;

    for (const bucket of buckets) {
      let bucketTotal = 0;
      for (const result of bucket.results ?? []) {
        const value = Number(result.amount?.value);
        if (!Number.isFinite(value)) continue;
        bucketTotal += value;
        const key = result.line_item ?? 'unattributed';
        lineItems.set(key, (lineItems.get(key) ?? 0) + value);
      }
      totalUsd += bucketTotal;
      days_.push({
        date: new Date((bucket.start_time ?? 0) * 1000).toISOString().slice(0, 10),
        amountUsd: round2(bucketTotal),
      });
    }

    const summary: CostsSummary = {
      configured: true,
      totalUsd: round2(totalUsd),
      days: days_,
      byLineItem: [...lineItems.entries()]
        .map(([lineItem, amountUsd]) => ({ lineItem, amountUsd: round2(amountUsd) }))
        .sort((a, b) => b.amountUsd - a.amountUsd)
        .slice(0, 20),
      fetchedAt: new Date().toISOString(),
    };

    cache = { at: Date.now(), days: bounded, value: summary };
    return summary;
  } catch (err) {
    log.warn({ err }, 'OpenAI costs request errored');
    return NOT_CONFIGURED;
  }
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}
