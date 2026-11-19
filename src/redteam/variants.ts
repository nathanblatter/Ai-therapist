// Named configuration variants for the red-team harness (`--variant <name>`).
//
// Feature flags in system_config.features default OFF, and the eval database
// is built from migrations, so without a variant nothing behind a flag is ever
// evaluated. A variant switches a fixed set of flags on for one run.
//
// The flags are overlaid IN-PROCESS (sessionHelpers.setFeatureOverrides), not
// written to system_config: the in-app harness runner spawns this CLI against
// the live database (harnessRunner.service.ts), where a write would switch the
// flag on for real participants. Every code path that reads these flags goes
// through getSystemConfig(), which applies the overlay.
//
// Results are labelled with the variant (summary.json `variant`, the report
// header, and the persisted harness_runs suite label `<suite>:<variant>`) and
// only diff against a baseline of the same variant.
import type { DbLike } from './types.js';

export interface RedteamVariant {
  name: string;
  description: string;
  /** Keys overlaid on system_config.features for this process. */
  features: Record<string, unknown>;
  /** ai-therapist-202 experiment: pin the session's arm instead of a 50/50
   *  roll (only consulted when the experiment flag is on). */
  psychoeducationCueArm?: boolean;
}

export const DEFAULT_VARIANT = 'default';

export const VARIANTS: Record<string, RedteamVariant> = {
  [DEFAULT_VARIANT]: {
    name: DEFAULT_VARIANT,
    description: 'Flags as migrated (everything behind a feature flag off).',
    features: {},
  },
  'lead-conversation': {
    name: 'lead-conversation',
    description:
      'features.lead_conversation_enabled = true (PR #32): "Leading the conversation" prompt block and the opening invitation.',
    features: { lead_conversation_enabled: true },
  },
  'psychoeducation-cue': {
    name: 'psychoeducation-cue',
    description:
      'features.psychoeducation_cue_ab_enabled = true (PR #30) with every session forced into the cue arm (no 50/50 roll).',
    features: { psychoeducation_cue_ab_enabled: true },
    psychoeducationCueArm: true,
  },
  'assistant-agents-api': {
    name: 'assistant-agents-api',
    description:
      'features.assistant_agents_api_enabled = true: the admin assistant runs on the OpenAI Agents API backend (aggregate-only tools, per-turn sessions deleted after use; docs/agents-api-evaluation.md).',
    features: { assistant_agents_api_enabled: true },
  },
};

export function getVariant(name: string | undefined): RedteamVariant {
  const key = name ?? DEFAULT_VARIANT;
  const v = VARIANTS[key];
  if (!v) throw new Error(`unknown --variant "${key}" (known: ${Object.keys(VARIANTS).join(', ')})`);
  return v;
}

/** Label written to summary.json and the report. */
export interface VariantLabel {
  name: string;
  description: string;
  features: Record<string, unknown>;
  psychoeducationCueArm: boolean | null;
}

export function variantLabel(v: RedteamVariant): VariantLabel {
  return {
    name: v.name,
    description: v.description,
    features: { ...v.features },
    psychoeducationCueArm: v.psychoeducationCueArm ?? null,
  };
}

/** Suite label persisted on harness_runs, so `--baseline latest` (which looks
 *  up the newest run with the same suite label) never crosses variants. The
 *  default variant keeps the bare suite name so existing history still matches. */
export function persistedSuiteLabel(suite: string, variant: string): string {
  return variant === DEFAULT_VARIANT ? suite : `${suite}:${variant}`;
}

/** Install the variant's overrides in this process. Returns a restore function. */
export async function applyVariant(v: RedteamVariant): Promise<() => void> {
  const { setFeatureOverrides, setPsychoeducationCueArmOverride } = await import('../server/utils/sessionHelpers.js');
  setFeatureOverrides(v.features);
  setPsychoeducationCueArmOverride(v.psychoeducationCueArm ?? null);
  return () => {
    setFeatureOverrides(null);
    setPsychoeducationCueArmOverride(null);
  };
}

/** Marker of the lead-conversation block in an assembled prompt. The block
 *  text itself lives in promptContext.ts; only its heading is checked here. */
const LEAD_BLOCK_HEADING = '## Leading the conversation';

/**
 * Evidence that a chat session actually ran under the variant: reads the
 * assembled prompt and the recorded arm from session_configurations. Returns
 * null when the variant sets nothing that a session records (default).
 */
export async function checkVariantApplied(
  v: RedteamVariant,
  pool: DbLike,
  sessionId: string,
): Promise<{ passed: boolean; detail: string } | null> {
  const wantsLead = v.features.lead_conversation_enabled === true;
  const wantsCue = v.features.psychoeducation_cue_ab_enabled === true;
  if (!wantsLead && !wantsCue) return null;
  const { rows } = await pool.query(
    `SELECT instructions, to_jsonb(sc)->'psychoeducation_cue' AS cue
       FROM session_configurations sc WHERE session_id = $1`,
    [sessionId],
  );
  const row = rows[0];
  if (!row) return { passed: false, detail: `no session_configurations row for ${sessionId}` };
  const instructions = String(row.instructions ?? '');
  const problems: string[] = [];
  const notes: string[] = [];
  if (wantsLead) {
    if (instructions.includes(LEAD_BLOCK_HEADING)) notes.push('lead-conversation block present');
    else problems.push('lead-conversation block missing from the assembled prompt');
  }
  if (wantsCue) {
    const want = v.psychoeducationCueArm ?? null;
    const got = row.cue === null || row.cue === undefined ? null : row.cue === true;
    if (want !== null && got !== want) problems.push(`psychoeducation_cue arm ${String(got)} (want ${String(want)})`);
    else notes.push(`psychoeducation_cue arm ${String(got)}`);
    const linepresent = instructions.includes('CALL retrieve_psychoeducation');
    if (linepresent) notes.push('cue line present');
    else if (want === true) problems.push('cue line missing (is retrieve_psychoeducation enabled for chat?)');
    else notes.push('cue line absent');
  }
  return problems.length
    ? { passed: false, detail: problems.concat(notes).join('; ') }
    : { passed: true, detail: notes.join('; ') };
}
