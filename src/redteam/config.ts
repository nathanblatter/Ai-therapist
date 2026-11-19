// Harness configuration + a small cost tracker (spec §8, §11).

import { LIVE_RATES_PER_MINUTE, estimateLiveCostUsd } from '../server/db/liveUsage.queries.js';
import { getBackendModel } from '../server/utils/backendModels.js';
import { isFlexEligible } from '../server/utils/flexTier.js';

/** smoke: fast safety subset, gates deploys. full: all safety + quality
 *  scenarios. quality: rubric-floor scenarios only (nightly). voice: real
 *  voice sessions on the production backend (opt-in — minutes of wall-clock +
 *  per-minute voice billing; never a deploy gate). voice-safety: the
 *  safety-critical families over a real voice session plus the GPT-Live
 *  checks (scenarios/voice.ts; its own workflow, redteam-voice.yml). */
export type RedteamSuite =
  | 'smoke'
  | 'full'
  | 'quality'
  | 'voice'
  | 'voice-safety'
  | 'extended'
  // GPT-Live evaluation guide modes (src/redteam/voice, docs/redteam.md):
  // single-turn spoken requests at critical points, the same under acoustic
  // conditions, and a simulated participant in one full-duplex session.
  | 'voice-crawl'
  | 'voice-walk'
  | 'voice-run';

const SUITES: RedteamSuite[] = [
  'smoke',
  'full',
  'quality',
  'voice',
  'voice-safety',
  'extended',
  'voice-crawl',
  'voice-walk',
  'voice-run',
];

export function isRedteamSuite(v: string | undefined): v is RedteamSuite {
  return SUITES.includes(v as RedteamSuite);
}

export interface RedteamConfig {
  /** LLM that generates persona participant utterances. */
  personaModel: string;
  /** LLM for the semantic assertion classifiers. */
  classifierModel: string;
  /** Label for the reused v1 judge (evaluateSession) in reports and cost
   *  estimates. The judge itself runs the configured ensemble
   *  (system_config.evals.judge_models) unless --judge-model pins a single
   *  model via judgeModelOverride. */
  judgeModel: string;
  /** `--judge-model <m>`: force a single judge instead of the ensemble. */
  judgeModelOverride?: string;
  /** Best-effort determinism for persona + classifier calls. */
  seed: number;
  outDir: string;
  suite: RedteamSuite;
  scenarioId?: string;
  /** Run each scenario as k persona variations (seeded styles); a scenario
   *  passes only if every variation passes. Default 1. */
  variations: number;
  /** Downgrade a failing gate to exit 0 (local exploration). */
  allowFail: boolean;
  /** Replace all OpenAI calls with offline canned behaviour (CI unit path). */
  dryRun: boolean;
  /** `--baseline <path|latest>`: previous summary.json (or the newest
   *  persisted harness run for the same suite) to diff this run against. */
  baseline?: string;
  /** `--gate-diff`: exit non-zero when the diff shows a regression. */
  gateDiff: boolean;
  /** `--sample`: run tonight's weekly sample instead of the whole suite
   *  (sampling.ts; the nightly default leg and its Sunday lead leg). */
  sample?: boolean;
  /** `--skip-on-demand`: drop the on-demand-only scenarios (onDemand.ts).
   *  The scheduled weekly extended run passes it. */
  skipOnDemand?: boolean;
  /** `--sample-date YYYY-MM-DD`: the UTC date to sample for (default today, UTC). */
  sampleDate?: string;
  /** `--sample-history <summary.json|dir>`: previous results whose
   *  rolling-baseline.json drives catch-up (default: the --baseline file). */
  sampleHistory?: string;
  /** `--gate-quality`: judge-floor (judgeMinScores) breaches on QUALITY
   *  scenarios fail the scenario. Off by default — see docs/redteam.md
   *  "Promotion policy". Safety scenarios' floors always gate. */
  gateQuality: boolean;
  /** Voice suite: drive persona turns through the typed-text path instead of
   *  TTS audio (cheaper, skips VAD; never the default). */
  voiceTextTurns: boolean;
  /** Voice suite (Grok): sever the browser-side socket after the first
   *  persona beat, reconnect it, and finish the scenario — exercises the
   *  proxy's client re-attach path (docs/grok-voice.md section 3). */
  voiceDropClientMidway: boolean;
  /** Voice suite (Grok): sever the server's xAI socket after the first
   *  persona beat so the proxy re-dials with xAI's conversation cache. */
  voiceDropUpstreamMidway: boolean;
  /** `--variant <name>`: run under a named feature-flag variant (variants.ts). */
  variant: string;
  /** `--generated-variants <n>` (ai-therapist-109): run up to n LLM-generated
   *  mutations of the selected safety scenarios after the scripted ones. 0 =
   *  off (the default); clamped to MAX_GENERATED_VARIANTS. Adds model spend,
   *  so it is never enabled in a CI workflow. */
  generatedVariants: number;
  /** `--generated-operators a,b`: restrict the mutation operators used. */
  generatedOperators?: string[];
  /** `--variant-cache <dir>`: where generated variant scripts are cached and
   *  replayed from. */
  variantCacheDir: string;
  /** `--gate-generated`: generated-variant failures fail the run. Off by
   *  default: a variant failure is a lead to investigate, not a regression in
   *  a scripted gate. */
  gateGenerated: boolean;
  /** LLM that writes generated variants (the theme guard uses classifierModel). */
  generatorModel: string;
}

export const DEFAULTS = {
  personaModel: 'gpt-4o-mini',
  classifierModel: 'gpt-4o-mini',
  judgeModel: 'gpt-4o-mini',
  seed: 42,
  outDir: 'redteam-results',
  suite: 'full' as const,
  variations: 1,
  allowFail: false,
  dryRun: false,
  gateDiff: false,
  gateQuality: false,
  voiceTextTurns: false,
  voiceDropClientMidway: false,
  voiceDropUpstreamMidway: false,
  variant: 'default',
  generatedVariants: 0,
  variantCacheDir: 'redteam-variant-cache',
  gateGenerated: false,
  generatorModel: 'gpt-4o-mini',
};

/** The chat therapy reply model's CODE DEFAULT (utils/chatModel.ts). The
 *  model a run actually exercises is system_config.chat_model in the scratch
 *  database, which the in-process server reads exactly as production does;
 *  cli.ts prices chat turns with that resolved value. */
export const CHAT_THERAPY_MODEL = 'gpt-5.2';

// USD per 1M tokens, Standard tier (pricing page re-checked 2026-11-18).
// `cachedInPerM` is the cached-input rate; without one, cached tokens are
// priced as ordinary input (no discount assumed). Models not listed here are
// priced from the backend-model registry (server/utils/backendModels.ts),
// which covers the GPT-6 series. Cost figures are estimates, not billing.
export interface ModelPrice {
  inPerM: number;
  outPerM: number;
  cachedInPerM?: number;
}
export const MODEL_PRICING: Record<string, ModelPrice> = {
  'gpt-4o-mini': { inPerM: 0.15, cachedInPerM: 0.075, outPerM: 0.6 },
  'gpt-5': { inPerM: 1.25, cachedInPerM: 0.125, outPerM: 10.0 }, // redaction (post-session, flex)
  'gpt-5-mini': { inPerM: 0.25, cachedInPerM: 0.025, outPerM: 2.0 }, // second ensemble judge, leak check
  'gpt-5.2': { inPerM: 1.75, cachedInPerM: 0.175, outPerM: 14.0 },
  default: { inPerM: 0.5, outPerM: 1.5 },
};

/** Flex prices at Batch rates, half of Standard (server/utils/flexTier.ts),
 *  on every token class. Applied only to flex-eligible models on calls that
 *  request flex (the post-session jobs). A flex request that finds no
 *  capacity is retried on Standard; that case is priced at the flex rate too,
 *  so post-session figures are a slight underestimate when it happens. */
export const FLEX_PRICE_FACTOR = 0.5;

function priceFor(model: string): ModelPrice {
  const listed = MODEL_PRICING[model];
  if (listed) return listed;
  const registered = getBackendModel(model);
  if (registered)
    return {
      inPerM: registered.inputPerMillion,
      outPerM: registered.outputPerMillion,
      cachedInPerM: registered.cachedInputPerMillion,
    };
  return MODEL_PRICING.default;
}

export interface PriceOptions {
  /** Input tokens served from the prompt cache (a subset of inTok). */
  cachedInTok?: number;
  /** The call requested the flex tier. */
  flex?: boolean;
}

/** Voice backends bill per minute of session audio, not per token. These are
 *  the same figures the admin cost dashboard uses (liveUsage.queries.ts):
 *  GPT-Live $0.05/min (plus the delegated backend's tokens, not estimated
 *  here) and Grok Voice $0.08/min. Re-exported so the harness and the
 *  dashboard can never disagree. */
export const VOICE_RATES_PER_MINUTE = LIVE_RATES_PER_MINUTE;

/** Persona TTS (gpt-4o-mini-tts): OpenAI's published estimate is about
 *  $0.015 per minute of generated audio ($0.60/1M text-in + $12/1M audio-out
 *  tokens). Pennies per scenario; tracked so the voice figure is honest. */
export const TTS_USD_PER_MINUTE = 0.015;

interface Usage {
  prompt_tokens?: number | null;
  completion_tokens?: number | null;
  prompt_tokens_details?: { cached_tokens?: number | null } | null;
}

/** What a line of spend paid for. `chat-reply`, `in-session` and
 *  `post-session` come from the app's own session_llm_usage rows
 *  (sessionCost.ts); the rest are the harness's own calls. */
export type CostCategory =
  | 'chat-reply' // the therapy model's replies (purpose 'chat')
  | 'in-session' // crisis assessor, eligibility, rerank during the session
  | 'post-session' // redaction + insights jobs fired by /api/chat/end
  | 'persona'
  | 'classifier'
  | 'judge'
  | 'assistant'
  | 'generation' // --generated-variants generator + guard calls
  | 'voice'
  | 'tts'
  | 'other';

/** recorded: token counts (or billable seconds) reported by the API response
 *  or the app's own usage tables. estimated: no counts were available, so the
 *  tokens were derived from text length or a fixed guess. Both are priced
 *  from the hand-maintained table above, so neither is a billing figure. */
export type CostBasis = 'recorded' | 'estimated';

export interface CostCategoryLine {
  usd: number;
  recordedUsd: number;
  estimatedUsd: number;
  calls: number;
  tokensIn: number;
  tokensOut: number;
}

export interface CostBreakdown {
  totalUsd: number;
  recordedUsd: number;
  estimatedUsd: number;
  byCategory: Partial<Record<CostCategory, CostCategoryLine>>;
}

const round6 = (n: number): number => Number(n.toFixed(6));

function emptyLine(): CostCategoryLine {
  return { usd: 0, recordedUsd: 0, estimatedUsd: 0, calls: 0, tokensIn: 0, tokensOut: 0 };
}

/** Per-scenario cost accumulator. Every line carries a category and whether
 *  its token counts were recorded or estimated, so summary.json and the
 *  reports can say how much of a figure is measured. */
export class CostTracker {
  usd = 0;
  calls = 0;
  private readonly lines = new Map<CostCategory, CostCategoryLine>();

  /** Book an amount that was already priced. */
  addUsd(usd: number, category: CostCategory, basis: CostBasis, calls = 1, tokensIn = 0, tokensOut = 0): void {
    let l = this.lines.get(category);
    if (!l) this.lines.set(category, (l = emptyLine()));
    l.usd += usd;
    if (basis === 'recorded') l.recordedUsd += usd;
    else l.estimatedUsd += usd;
    l.calls += calls;
    l.tokensIn += tokensIn;
    l.tokensOut += tokensOut;
    this.usd += usd;
    this.calls += calls;
  }

  /** One call whose usage the API response returned. A response without
   *  usage books zero and counts as estimated, never as measured. */
  add(model: string, usage?: Usage, category: CostCategory = 'other'): void {
    const inTok = usage?.prompt_tokens ?? 0;
    const outTok = usage?.completion_tokens ?? 0;
    const measured = usage != null && (usage.prompt_tokens != null || usage.completion_tokens != null);
    const cachedInTok = usage?.prompt_tokens_details?.cached_tokens ?? 0;
    this.addUsd(
      priceTokens(model, inTok, outTok, { cachedInTok }),
      category,
      measured ? 'recorded' : 'estimated',
      1,
      inTok,
      outTok,
    );
  }

  /** Token counts the app recorded itself (session_llm_usage), possibly summed
   *  over several calls. The app records no cached-token count, so these are
   *  priced at the full input rate (an upper bound); `flex` for the
   *  post-session jobs, which request the flex tier. */
  addRecorded(
    model: string,
    inTok: number,
    outTok: number,
    category: CostCategory,
    calls = 1,
    opts: PriceOptions = {},
  ): void {
    this.addUsd(priceTokens(model, inTok, outTok, opts), category, 'recorded', calls, inTok, outTok);
  }

  /** Add an estimated call when real token usage is unavailable. */
  estimate(model: string, inTok: number, outTok: number, category: CostCategory = 'other', calls = 1): void {
    this.addUsd(priceTokens(model, inTok, outTok), category, 'estimated', calls, inTok, outTok);
  }

  /** Voice-session minutes on a per-minute backend (GPT-Live / Grok), priced
   *  from the model the session resolved to. `seconds` is the backend's own
   *  cumulative billable figure (live_usage), never a harness stopwatch. */
  addVoiceSeconds(model: string, seconds: number): void {
    this.addUsd(estimateLiveCostUsd(model, seconds), 'voice', 'recorded');
  }

  /** One persona TTS call: billed on generated audio duration (a per-minute
   *  approximation of the token bill, so estimated). */
  addTts(_chars: number, audioSeconds: number): void {
    this.addUsd((audioSeconds / 60) * TTS_USD_PER_MINUTE, 'tts', 'estimated');
  }

  breakdown(): CostBreakdown {
    return breakdownOf([...this.lines.entries()]);
  }
}

/** USD for a token count at the harness's rate for `model`: cached input at
 *  the cached rate when the model has one, and the flex factor when the call
 *  requested flex and the model is flex-eligible. */
export function priceTokens(model: string, inTok: number, outTok: number, opts: PriceOptions = {}): number {
  const price = priceFor(model);
  const cached = Math.min(Math.max(0, opts.cachedInTok ?? 0), inTok);
  const usd =
    ((inTok - cached) / 1e6) * price.inPerM +
    (cached / 1e6) * (price.cachedInPerM ?? price.inPerM) +
    (outTok / 1e6) * price.outPerM;
  return opts.flex && isFlexEligible(model) ? usd * FLEX_PRICE_FACTOR : usd;
}

/** Sum category lines (one tracker's, or many scenarios') into a breakdown. */
export function breakdownOf(entries: Array<[CostCategory, CostCategoryLine]>): CostBreakdown {
  const byCategory: Partial<Record<CostCategory, CostCategoryLine>> = {};
  let total = 0;
  let recorded = 0;
  let estimated = 0;
  for (const [cat, l] of entries) {
    const acc = (byCategory[cat] ??= emptyLine());
    acc.usd += l.usd;
    acc.recordedUsd += l.recordedUsd;
    acc.estimatedUsd += l.estimatedUsd;
    acc.calls += l.calls;
    acc.tokensIn += l.tokensIn;
    acc.tokensOut += l.tokensOut;
    total += l.usd;
    recorded += l.recordedUsd;
    estimated += l.estimatedUsd;
  }
  for (const l of Object.values(byCategory)) {
    if (!l) continue;
    l.usd = round6(l.usd);
    l.recordedUsd = round6(l.recordedUsd);
    l.estimatedUsd = round6(l.estimatedUsd);
  }
  return { totalUsd: round6(total), recordedUsd: round6(recorded), estimatedUsd: round6(estimated), byCategory };
}

/** Merge several breakdowns (per-scenario into run totals). */
export function mergeBreakdowns(parts: Array<CostBreakdown | undefined | null>): CostBreakdown {
  const entries: Array<[CostCategory, CostCategoryLine]> = [];
  for (const p of parts) {
    if (!p) continue;
    for (const [cat, l] of Object.entries(p.byCategory)) if (l) entries.push([cat as CostCategory, l]);
  }
  return breakdownOf(entries);
}
