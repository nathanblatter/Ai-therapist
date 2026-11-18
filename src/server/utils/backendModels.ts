// Candidate backend models for counterfactual evaluation.
//
// GPT-Live delegates reasoning to a backend model chosen independently of the
// voice model, and a fork may override that backend. That makes a question
// newly answerable: given the same conversation up to the same moment, what
// would a different model have said?
//
// This registry is the candidate set for that comparison. Rates are the
// published Standard-tier $/1M-token figures (short context, <=272K input) and
// are a hand-maintained ESTIMATE for relative comparison, matching the
// convention in costTracking.queries.ts — invoices remain the source of truth.
// GPT-6 rates re-checked against developers.openai.com/api/docs/pricing on
// 2026-11-18. costTracking.queries.ts falls back to this table, so a model
// listed here is priced correctly in the per-session cost panel too.
//
// Not every model here is necessarily accepted as a GPT-Live delegation
// backend; the docs recommend Terra and Luna but publish no allowlist. The
// harness therefore treats a rejected model as a per-candidate failure rather
// than aborting the run, and records the rejection so the unsupported set is
// discovered empirically rather than guessed.

export interface BackendModel {
  id: string;
  /** Coarse family, for grouping results in the comparison view. */
  family: 'gpt-6' | 'gpt-5.6' | 'gpt-5.5' | 'gpt-5.4' | 'gpt-5.x' | 'gpt-4.x';
  inputPerMillion: number;
  outputPerMillion: number;
  /** Reasoning models accept a `reasoning.effort` setting. */
  supportsReasoningEffort: boolean;
  /**
   * False for models that reject `reasoning.effort: 'none'` (GPT-6 Astra and
   * GPT-6.1 Sol, per the GPT-6 guide's Limitations section). Nothing sends
   * `none` today; this exists so a future caller that does can check first.
   * Omitted means "accepts none" for reasoning models.
   */
  supportsNoneEffort?: boolean;
  /**
   * In the default sweep. Kept small on purpose: a full sweep multiplies cost
   * by the number of candidates, and most of the signal comes from spanning the
   * quality/price range rather than from adjacent snapshots of one family.
   */
  inDefaultSweep: boolean;
  notes?: string;
}

export const BACKEND_MODELS: BackendModel[] = [
  // --- GPT-6 -------------------------------------------------------------
  {
    id: 'gpt-6-astra',
    family: 'gpt-6',
    inputPerMillion: 10,
    outputPerMillion: 50,
    supportsReasoningEffort: true,
    supportsNoneEffort: false,
    inDefaultSweep: true,
    notes: 'Flagship; the quality ceiling for this comparison.',
  },
  {
    id: 'gpt-6.2-astra',
    family: 'gpt-6',
    inputPerMillion: 8,
    outputPerMillion: 40,
    supportsReasoningEffort: true,
    supportsNoneEffort: false,
    inDefaultSweep: false,
    notes: 'Not flex-eligible (pricing page lists no Flex rate).',
  },
  {
    id: 'gpt-6.2-sol',
    family: 'gpt-6',
    inputPerMillion: 2,
    outputPerMillion: 10,
    supportsReasoningEffort: true,
    supportsNoneEffort: false,
    inDefaultSweep: false,
    notes: 'Not flex-eligible (pricing page lists no Flex rate).',
  },
  {
    id: 'gpt-6.1-sol',
    family: 'gpt-6',
    inputPerMillion: 2,
    outputPerMillion: 10,
    supportsReasoningEffort: true,
    supportsNoneEffort: false,
    inDefaultSweep: false,
  },
  {
    id: 'gpt-6-sol',
    family: 'gpt-6',
    inputPerMillion: 2,
    outputPerMillion: 10,
    supportsReasoningEffort: true,
    inDefaultSweep: false,
  },
  {
    id: 'gpt-6.1-terra',
    family: 'gpt-6',
    inputPerMillion: 1,
    outputPerMillion: 5,
    supportsReasoningEffort: true,
    inDefaultSweep: true,
    notes: 'Successor to gpt-5.6-terra at half the input and under half the output price.',
  },
  {
    id: 'gpt-6-luna',
    family: 'gpt-6',
    inputPerMillion: 0.1,
    outputPerMillion: 0.5,
    supportsReasoningEffort: true,
    inDefaultSweep: true,
    notes: 'The GPT-Live delegation guide example backend; also our redaction verifier (Decisions API).',
  },

  // --- GPT-5.6 (the generation GPT-Live delegation was designed around) ---
  {
    id: 'gpt-5.6-sol',
    family: 'gpt-5.6',
    inputPerMillion: 4,
    outputPerMillion: 20,
    supportsReasoningEffort: true,
    inDefaultSweep: true,
  },
  {
    id: 'gpt-5.6-terra',
    family: 'gpt-5.6',
    inputPerMillion: 2,
    outputPerMillion: 12,
    supportsReasoningEffort: true,
    inDefaultSweep: true,
    notes: 'Our current GPT-Live delegation default (LIVE_DEFAULT_BACKEND_MODEL).',
  },
  {
    id: 'gpt-5.6-luna',
    family: 'gpt-5.6',
    inputPerMillion: 0.2,
    outputPerMillion: 1.2,
    supportsReasoningEffort: true,
    inDefaultSweep: true,
    notes: 'Recommended for cost-sensitive workloads; 10x cheaper than Terra.',
  },

  // --- GPT-5.5 / 5.4 -----------------------------------------------------
  {
    id: 'gpt-5.5',
    family: 'gpt-5.5',
    inputPerMillion: 5,
    outputPerMillion: 30,
    supportsReasoningEffort: true,
    inDefaultSweep: false,
  },
  {
    id: 'gpt-5.4',
    family: 'gpt-5.4',
    inputPerMillion: 2.5,
    outputPerMillion: 15,
    supportsReasoningEffort: true,
    inDefaultSweep: false,
  },
  {
    id: 'gpt-5.4-mini',
    family: 'gpt-5.4',
    inputPerMillion: 0.75,
    outputPerMillion: 4.5,
    supportsReasoningEffort: true,
    inDefaultSweep: false,
  },
  {
    id: 'gpt-5.4-nano',
    family: 'gpt-5.4',
    inputPerMillion: 0.2,
    outputPerMillion: 1.25,
    supportsReasoningEffort: true,
    inDefaultSweep: false,
  },

  // --- GPT-5.x -----------------------------------------------------------
  {
    id: 'gpt-5.2',
    family: 'gpt-5.x',
    inputPerMillion: 1.75,
    outputPerMillion: 14,
    supportsReasoningEffort: true,
    inDefaultSweep: true,
    notes: 'The model our text-chat therapy pipeline runs on — the natural baseline.',
  },
  {
    id: 'gpt-5.1',
    family: 'gpt-5.x',
    inputPerMillion: 1.25,
    outputPerMillion: 10,
    supportsReasoningEffort: true,
    inDefaultSweep: false,
  },
  {
    id: 'gpt-5',
    family: 'gpt-5.x',
    inputPerMillion: 1.25,
    outputPerMillion: 10,
    supportsReasoningEffort: true,
    inDefaultSweep: false,
  },
  {
    id: 'gpt-5-mini',
    family: 'gpt-5.x',
    inputPerMillion: 0.25,
    outputPerMillion: 2,
    supportsReasoningEffort: true,
    inDefaultSweep: false,
  },
  {
    id: 'gpt-5-nano',
    family: 'gpt-5.x',
    inputPerMillion: 0.05,
    outputPerMillion: 0.4,
    supportsReasoningEffort: true,
    inDefaultSweep: true,
    notes: 'Floor of the price range; included to show where quality breaks down.',
  },

  // --- GPT-4.x (legacy baselines) ---------------------------------------
  {
    id: 'gpt-4.1',
    family: 'gpt-4.x',
    inputPerMillion: 2,
    outputPerMillion: 8,
    supportsReasoningEffort: false,
    inDefaultSweep: false,
  },
  {
    id: 'gpt-4.1-mini',
    family: 'gpt-4.x',
    inputPerMillion: 0.4,
    outputPerMillion: 1.6,
    supportsReasoningEffort: false,
    inDefaultSweep: false,
  },
  {
    id: 'gpt-4o',
    family: 'gpt-4.x',
    inputPerMillion: 2.5,
    outputPerMillion: 10,
    supportsReasoningEffort: false,
    inDefaultSweep: false,
  },
  {
    id: 'gpt-4o-mini',
    family: 'gpt-4.x',
    inputPerMillion: 0.15,
    outputPerMillion: 0.6,
    supportsReasoningEffort: false,
    inDefaultSweep: false,
  },
];

const INDEX = new Map(BACKEND_MODELS.map((m) => [m.id, m]));

/**
 * Look a model up by id. A dated snapshot id ("gpt-6.1-terra-2026-10-01") or
 * the id OpenAI echoes back on a response resolves to its base entry, so a
 * pinned snapshot is priced the same as its alias.
 */
export function getBackendModel(id: string): BackendModel | null {
  return INDEX.get(id) ?? INDEX.get(id.replace(/-\d{4}-\d{2}-\d{2}$/, '')) ?? null;
}

/** The default sweep: spans the quality/price range without running everything. */
export function defaultSweep(): BackendModel[] {
  return BACKEND_MODELS.filter((m) => m.inDefaultSweep);
}

/** Every registered candidate, cheapest first. */
export function allCandidates(): BackendModel[] {
  return [...BACKEND_MODELS].sort((a, b) => a.inputPerMillion - b.inputPerMillion);
}

/**
 * Resolve a caller-supplied model list.
 *
 * Accepts 'default', 'all', or explicit ids. Unknown ids are RETURNED rather
 * than dropped, with `known: false`: the registry is hand-maintained and will
 * lag OpenAI's releases, so refusing to run an unlisted model would make this
 * harness useless the week a new one ships. Cost is simply unavailable for
 * those.
 */
export function resolveCandidates(
  spec: string[] | 'default' | 'all',
): Array<{ id: string; model: BackendModel | null }> {
  if (spec === 'default') return defaultSweep().map((m) => ({ id: m.id, model: m }));
  if (spec === 'all') return allCandidates().map((m) => ({ id: m.id, model: m }));
  return spec.map((id) => ({ id, model: getBackendModel(id) }));
}

/** Estimated USD for one candidate response. Null when the model is unknown. */
export function estimateCandidateCostUsd(
  model: BackendModel | null,
  tokensIn: number | null,
  tokensOut: number | null,
): number | null {
  if (!model) return null;
  const cost =
    ((tokensIn ?? 0) / 1_000_000) * model.inputPerMillion + ((tokensOut ?? 0) / 1_000_000) * model.outputPerMillion;
  return Math.round(cost * 1_000_000) / 1_000_000;
}
