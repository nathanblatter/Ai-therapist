// Assembles the admin cost dashboard (ai-therapist-181).
//
// Two sources, deliberately kept distinct because they have different
// authority:
//   - OpenAI /v1/organization/costs  -> REAL DOLLARS, but only per model.
//   - our session_llm_usage / realtime_usage -> what we spent them ON, in
//     tokens, but no prices.
// The dashboard shows the real dollars as fact, and apportions them across
// product subsystems as a clearly-labelled ESTIMATE. We never multiply tokens
// by a hardcoded price list: those drift silently and would quietly contradict
// the billing page.
import {
  getUsageByPurpose,
  getRealtimeUsageTotals,
  getSessionVolume,
  type SessionVolume,
} from '../db/index.js';
import { getCostsSummary, type CostsSummary } from './openaiCosts.service.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('cost-dashboard');

/** Product subsystems, in fixed order — the dashboard assigns colours by this
 *  order so a subsystem keeps its hue across every chart. */
export const SUBSYSTEMS = ['redaction', 'chat', 'realtime', 'crisis', 'insights', 'other'] as const;
export type Subsystem = (typeof SUBSYSTEMS)[number];

/** Map an OpenAI line item ("gpt-5-2025-08-07, output") to the model family we
 *  can reason about. Returns null for anything unrecognised. */
export function modelFamilyOf(lineItem: string): string | null {
  const model = lineItem.split(',')[0]?.trim().toLowerCase();
  if (!model) return null;
  if (model.startsWith('gpt-realtime')) return 'realtime';
  if (model.startsWith('gpt-5.2')) return 'gpt-5.2';
  // The GPT-Live delegated reasoning backend. It is the voice pipeline's
  // brain, so its spend belongs to the realtime subsystem rather than to a
  // generic text bucket — attributing it elsewhere would make voice look
  // cheaper than it is.
  if (model.startsWith('gpt-5.6')) return 'live-backend';
  if (/^gpt-5(-|$)/.test(model)) return 'gpt-5';
  if (model.startsWith('gpt-4o-mini-transcribe') || model.startsWith('gpt-transcribe')
      || model.startsWith('gpt-live-transcribe')) return 'transcribe';
  // Must follow the gpt-live-transcribe check above: that is a transcription
  // model, not the full-duplex voice model, and startsWith('gpt-live') would
  // otherwise swallow it.
  if (model.startsWith('gpt-live')) return 'live-voice';
  if (model.startsWith('gpt-4o-mini')) return 'gpt-4o-mini';
  if (model.startsWith('text-embedding')) return 'embeddings';
  if (model.startsWith('omni-moderation')) return 'moderation';
  return null;
}

/** Which subsystems can spend on a given model family. */
const FAMILY_TO_SUBSYSTEMS: Record<string, Subsystem[]> = {
  'gpt-5': ['redaction'],
  'gpt-5.2': ['chat'],
  // 'other' carries rerank + eligibility, which also run on gpt-4o-mini. Without
  // it their token volume was excluded from the denominator, so their spend was
  // silently apportioned to crisis and insights and inflated both.
  'gpt-4o-mini': ['crisis', 'insights', 'other'],
  realtime: ['realtime'],
  transcribe: ['realtime'],
  // GPT-Live: the voice layer is billed per second and the delegated backend
  // per token, but both are the voice product from the study's point of view.
  'live-voice': ['realtime'],
  'live-backend': ['realtime'],
  moderation: ['crisis'],
  embeddings: ['other'],
};

export interface SubsystemCost {
  subsystem: Subsystem;
  amountUsd: number;
  /** Share of total spend, 0-1. */
  share: number;
  /** True when the split within a shared model was inferred, not measured. */
  estimated: boolean;
}

export interface CostDashboard {
  configured: boolean;
  days: number;
  /** Authoritative: real dollars from OpenAI. */
  totalUsd: number;
  daily: Array<{ date: string; amountUsd: number }>;
  byLineItem: Array<{ lineItem: string; amountUsd: number }>;
  /** Estimated: real dollars apportioned to product subsystems. */
  bySubsystem: SubsystemCost[];
  /** Purposes whose token counts are missing, so their share is call-weighted. */
  attributionCaveats: string[];
  volume: SessionVolume;
  unit: {
    usdPerSession: number | null;
    usdPerEndedSession: number | null;
    usdPerDay: number;
  };
  budget: {
    monthlyCapUsd: number;
    /** Spend so far in the current calendar month. */
    monthToDateUsd: number;
    /** Straight-line projection for the full month at the current daily rate. */
    projectedMonthUsd: number;
    capRisk: 'ok' | 'warning' | 'critical';
  };
  fetchedAt: string;
}

/** The org spend cap. Not discoverable via the costs API, so it is configured
 *  here; a hard cap 429s EVERY call including crisis detection, which is why
 *  the dashboard surfaces it as a safety signal rather than a billing note. */
const MONTHLY_CAP_USD = Number(process.env.OPENAI_MONTHLY_CAP_USD || 120);

/**
 * Apportion each model family's real dollars across the subsystems that used
 * it, weighted by measured token volume where available and by call count
 * where token counts are missing.
 */
function attribute(
  costs: CostsSummary,
  usage: Awaited<ReturnType<typeof getUsageByPurpose>>,
  realtimeResponses: number
): { bySubsystem: SubsystemCost[]; caveats: string[] } {
  const caveats: string[] = [];

  // Weight per (family, subsystem).
  const weights = new Map<string, Map<Subsystem, number>>();
  const addWeight = (family: string, sub: Subsystem, w: number) => {
    if (w <= 0) return;
    if (!weights.has(family)) weights.set(family, new Map());
    const m = weights.get(family)!;
    m.set(sub, (m.get(sub) ?? 0) + w);
  };

  for (const row of usage) {
    const family = row.model ? modelFamilyOf(row.model) : null;
    if (!family) continue;
    const sub = (SUBSYSTEMS as readonly string[]).includes(row.purpose)
      ? (row.purpose as Subsystem)
      : 'other';
    if (row.tokensMissing) {
      // No token counts recorded — fall back to call count and say so.
      caveats.push(`${row.purpose}: token counts not recorded (${row.calls} calls); share estimated from call volume`);
      addWeight(family, sub, row.calls);
    } else {
      addWeight(family, sub, row.tokensIn + row.tokensOut);
    }
  }
  if (realtimeResponses > 0) addWeight('realtime', 'realtime', realtimeResponses);
  // GPT-Live voice spend has exactly one consumer, so the whole family goes to
  // 'realtime' with a nominal weight. There is nothing to apportion between —
  // the weight only has to be non-zero for the family to be attributed at all.
  addWeight('live-voice', 'realtime', 1);
  addWeight('live-backend', 'realtime', 1);

  const totals = new Map<Subsystem, number>();
  const estimatedSubs = new Set<Subsystem>();
  let unattributed = 0;

  for (const item of costs.byLineItem) {
    const family = modelFamilyOf(item.lineItem);
    const candidates = family ? FAMILY_TO_SUBSYSTEMS[family] : undefined;
    const familyWeights = family ? weights.get(family) : undefined;

    if (!candidates || candidates.length === 0) {
      unattributed += item.amountUsd;
      continue;
    }
    if (candidates.length === 1) {
      const sub = candidates[0];
      totals.set(sub, (totals.get(sub) ?? 0) + item.amountUsd);
      continue;
    }
    // Shared model: split by measured weight; if we have no weights at all,
    // fall back to an even split and flag it.
    const present = candidates.filter(c => (familyWeights?.get(c) ?? 0) > 0);
    if (present.length === 0) {
      const each = item.amountUsd / candidates.length;
      for (const c of candidates) {
        totals.set(c, (totals.get(c) ?? 0) + each);
        estimatedSubs.add(c);
      }
      continue;
    }
    const denom = present.reduce((s, c) => s + (familyWeights!.get(c) ?? 0), 0);
    for (const c of present) {
      const share = (familyWeights!.get(c) ?? 0) / denom;
      totals.set(c, (totals.get(c) ?? 0) + item.amountUsd * share);
      estimatedSubs.add(c);
    }
  }
  if (unattributed > 0) totals.set('other', (totals.get('other') ?? 0) + unattributed);

  const grand = [...totals.values()].reduce((a, b) => a + b, 0);
  const bySubsystem = SUBSYSTEMS
    .map(sub => ({
      subsystem: sub,
      amountUsd: round2(totals.get(sub) ?? 0),
      share: grand > 0 ? (totals.get(sub) ?? 0) / grand : 0,
      estimated: estimatedSubs.has(sub),
    }))
    .filter(s => s.amountUsd > 0)
    .sort((a, b) => b.amountUsd - a.amountUsd);

  return { bySubsystem, caveats: [...new Set(caveats)] };
}

const EMPTY: CostDashboard = {
  configured: false, days: 30, totalUsd: 0, daily: [], byLineItem: [],
  bySubsystem: [], attributionCaveats: [], fetchedAt: new Date(0).toISOString(),
  volume: { sessions: 0, endedSessions: 0, realtimeSessions: 0, chatSessions: 0, activeDays: 0, participants: 0 },
  unit: { usdPerSession: null, usdPerEndedSession: null, usdPerDay: 0 },
  budget: { monthlyCapUsd: MONTHLY_CAP_USD, monthToDateUsd: 0, projectedMonthUsd: 0, capRisk: 'ok' },
};

/** Everything the dashboard renders. Never throws. */
export async function getCostDashboard(days = 30): Promise<CostDashboard> {
  const costs = await getCostsSummary(days);
  if (!costs.configured) return { ...EMPTY, days };

  let usage: Awaited<ReturnType<typeof getUsageByPurpose>> = [];
  let realtime = { responses: 0 };
  let volume = EMPTY.volume;
  try {
    [usage, realtime, volume] = await Promise.all([
      getUsageByPurpose(days),
      getRealtimeUsageTotals(days),
      getSessionVolume(days),
    ]);
  } catch (err) {
    // Attribution is a bonus layer; real dollars still render without it.
    log.warn({ err }, 'cost attribution queries failed; showing dollars only');
  }

  const { bySubsystem, caveats } = attribute(costs, usage, realtime.responses);

  // Month-to-date from the daily buckets we already have.
  const monthPrefix = new Date().toISOString().slice(0, 7);
  const monthToDate = costs.days
    .filter(d => d.date.startsWith(monthPrefix))
    .reduce((s, d) => s + d.amountUsd, 0);
  const dayOfMonth = new Date().getUTCDate();
  const projectedMonth = dayOfMonth > 0 ? (monthToDate / dayOfMonth) * daysInThisMonth() : monthToDate;

  const capRisk: CostDashboard['budget']['capRisk'] =
    monthToDate >= MONTHLY_CAP_USD * 0.8 ? 'critical'
      : projectedMonth >= MONTHLY_CAP_USD * 0.8 ? 'warning'
        : 'ok';

  const spanDays = Math.max(1, costs.days.length);

  return {
    configured: true,
    days,
    totalUsd: costs.totalUsd,
    daily: costs.days,
    byLineItem: costs.byLineItem,
    bySubsystem,
    attributionCaveats: caveats,
    volume,
    unit: {
      usdPerSession: volume.sessions > 0 ? round4(costs.totalUsd / volume.sessions) : null,
      usdPerEndedSession: volume.endedSessions > 0 ? round4(costs.totalUsd / volume.endedSessions) : null,
      usdPerDay: round2(costs.totalUsd / spanDays),
    },
    budget: {
      monthlyCapUsd: MONTHLY_CAP_USD,
      monthToDateUsd: round2(monthToDate),
      projectedMonthUsd: round2(projectedMonth),
      capRisk,
    },
    fetchedAt: costs.fetchedAt,
  };
}

function daysInThisMonth(): number {
  const now = new Date();
  return new Date(now.getUTCFullYear(), now.getUTCMonth() + 1, 0).getUTCDate();
}
function round2(v: number): number { return Math.round(v * 100) / 100; }
function round4(v: number): number { return Math.round(v * 10000) / 10000; }
