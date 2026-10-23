// Harness configuration + a small cost tracker (spec §8, §11).

import { LIVE_RATES_PER_MINUTE, estimateLiveCostUsd } from '../server/db/liveUsage.queries.js';

/** smoke: fast safety subset, gates deploys. full: all safety + quality
 *  scenarios. quality: rubric-floor scenarios only (nightly). voice: real
 *  voice sessions on the production backend (opt-in — minutes of wall-clock +
 *  per-minute voice billing; never a deploy gate). */
export type RedteamSuite = 'smoke' | 'full' | 'quality' | 'voice';

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
};

/** The chat therapy reply model (chatTherapy.service.ts) — used only for cost
 *  estimation. NOT independently verified pricing; see docs/redteam.md R5. */
export const CHAT_THERAPY_MODEL = 'gpt-5.2';

// USD per 1M tokens. gpt-4o-mini is public pricing; gpt-5.2 is an ASSUMED
// placeholder (the repo's configured prod chat model — pricing unverified,
// flagged in docs/redteam.md §R5). Cost figures are estimates, not billing.
export const MODEL_PRICING: Record<string, { inPerM: number; outPerM: number }> = {
  'gpt-4o-mini': { inPerM: 0.15, outPerM: 0.6 },
  'gpt-5-mini': { inPerM: 0.25, outPerM: 2.0 }, // second ensemble judge (backendModels.ts)
  'gpt-5.2': { inPerM: 1.25, outPerM: 10.0 }, // assumed; see R5
  default: { inPerM: 0.5, outPerM: 1.5 },
};

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
}

/** Per-scenario cost accumulator. Real usage feeds in from persona/classifier
 *  calls; chat therapy replies (no usage returned by the Responses wrapper) are
 *  estimated from assumed token counts. */
export class CostTracker {
  usd = 0;
  calls = 0;

  add(model: string, usage?: Usage): void {
    const price = MODEL_PRICING[model] ?? MODEL_PRICING.default;
    const inTok = usage?.prompt_tokens ?? 0;
    const outTok = usage?.completion_tokens ?? 0;
    this.usd += (inTok / 1e6) * price.inPerM + (outTok / 1e6) * price.outPerM;
    this.calls += 1;
  }

  /** Add an estimated call when real token usage is unavailable. */
  estimate(model: string, inTok: number, outTok: number): void {
    const price = MODEL_PRICING[model] ?? MODEL_PRICING.default;
    this.usd += (inTok / 1e6) * price.inPerM + (outTok / 1e6) * price.outPerM;
    this.calls += 1;
  }

  /** Voice-session minutes on a per-minute backend (GPT-Live / Grok), priced
   *  from the model the session resolved to. `seconds` is the backend's own
   *  cumulative billable figure (live_usage), never a harness stopwatch. */
  addVoiceSeconds(model: string, seconds: number): void {
    this.usd += estimateLiveCostUsd(model, seconds);
    this.calls += 1;
  }

  /** One persona TTS call: billed on generated audio duration. */
  addTts(_chars: number, audioSeconds: number): void {
    this.usd += (audioSeconds / 60) * TTS_USD_PER_MINUTE;
    this.calls += 1;
  }
}
