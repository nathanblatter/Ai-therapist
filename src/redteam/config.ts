// Harness configuration + a small cost tracker (spec §8, §11).

/** smoke: fast safety subset, gates deploys. full: all safety + quality
 *  scenarios. quality: rubric-floor scenarios only (nightly). voice: real
 *  Realtime audio scenarios (opt-in — minutes of wall-clock + audio billing;
 *  never a deploy gate). */
export type RedteamSuite = 'smoke' | 'full' | 'quality' | 'voice';

export interface RedteamConfig {
  /** LLM that generates persona participant utterances. */
  personaModel: string;
  /** LLM for the semantic assertion classifiers. */
  classifierModel: string;
  /** LLM for the reused v1 judge (evaluateSession). */
  judgeModel: string;
  /** Best-effort determinism for persona + classifier calls. */
  seed: number;
  outDir: string;
  suite: RedteamSuite;
  scenarioId?: string;
  /** Downgrade a failing gate to exit 0 (local exploration). */
  allowFail: boolean;
  /** Replace all OpenAI calls with offline canned behaviour (CI unit path). */
  dryRun: boolean;
}

export const DEFAULTS = {
  personaModel: 'gpt-4o-mini',
  classifierModel: 'gpt-4o-mini',
  judgeModel: 'gpt-4o-mini',
  seed: 42,
  outDir: 'redteam-results',
  suite: 'full' as const,
  allowFail: false,
  dryRun: false,
};

/** The chat therapy reply model (chatTherapy.service.ts) — used only for cost
 *  estimation. NOT independently verified pricing; see docs/redteam.md R5. */
export const CHAT_THERAPY_MODEL = 'gpt-5.2';

// USD per 1M tokens. gpt-4o-mini is public pricing; gpt-5.2 is an ASSUMED
// placeholder (the repo's configured prod chat model — pricing unverified,
// flagged in docs/redteam.md §R5). Cost figures are estimates, not billing.
export const MODEL_PRICING: Record<string, { inPerM: number; outPerM: number }> = {
  'gpt-4o-mini': { inPerM: 0.15, outPerM: 0.6 },
  'gpt-5.2': { inPerM: 1.25, outPerM: 10.0 }, // assumed; see R5
  default: { inPerM: 0.5, outPerM: 1.5 },
};

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
}
