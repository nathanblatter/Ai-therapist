// Forcing the proactive_offering experimental arm (ai-therapist-74, migration
// 042) for the ARM-01/ARM-02 scenarios.
//
// /api/chat/start resolves the arm once per session through
// resolveProactiveOffering(), which reads system_config.features
// .proactive_offering.mode ('always' | 'never' | 'ab_test', default ab_test =
// a 50/50 roll). The harness pins the mode IN THIS PROCESS ONLY through the
// same in-process feature overlay `--variant` uses
// (sessionHelpers.setFeatureOverrides); nothing is written to system_config.
// That matters: the in-app harness runner spawns the CLI against the live
// database, where a write would change the arm for real participants.
//
// The overlay is a single slot, so the arm is layered on top of the run's
// variant flags and the variant's own overlay is put back afterwards.
// Every arm scenario also asserts armRecorded(): the session row must show
// the forced arm and its prompt section, or the scenario fails.
import type { DbLike } from './types.js';
import type { ProactiveArm } from './relationalAssertions.js';

/** The --variant this process runs under (cli.ts parses the same flag). */
function runVariantName(argv = process.argv): string | undefined {
  const i = argv.indexOf('--variant');
  return i >= 0 ? argv[i + 1] : undefined;
}

async function variantFeatures(): Promise<Record<string, unknown>> {
  const { getVariant } = await import('./variants.js');
  return { ...getVariant(runVariantName()).features };
}

export async function forceProactiveArm(arm: ProactiveArm): Promise<void> {
  const { setFeatureOverrides } = await import('../server/utils/sessionHelpers.js');
  setFeatureOverrides({
    ...(await variantFeatures()),
    proactive_offering: { mode: arm === 'proactive' ? 'always' : 'never' },
  });
}

/** Restore the run's variant overlay (empty for the default variant). */
export async function clearProactiveArm(): Promise<void> {
  const { setFeatureOverrides } = await import('../server/utils/sessionHelpers.js');
  setFeatureOverrides(await variantFeatures());
}

/** Pin feature flags (and optionally the psychoeducation-cue arm) for one
 *  scenario, on top of the run's variant flags, in this process only. Used by
 *  the ARM-03/05/06 scenarios: ab_test mode, lead-conversation on, and either
 *  psychoeducation-cue arm. Nothing is written to system_config. */
export function featureHooks(
  features: Record<string, unknown>,
  opts: { psychoeducationCueArm?: boolean } = {},
): {
  setup: (pool: DbLike) => Promise<void>;
  teardown: (pool: DbLike) => Promise<void>;
} {
  return {
    setup: async () => {
      const { setFeatureOverrides, setPsychoeducationCueArmOverride } = await import(
        '../server/utils/sessionHelpers.js'
      );
      setFeatureOverrides({ ...(await variantFeatures()), ...features });
      if (opts.psychoeducationCueArm !== undefined) setPsychoeducationCueArmOverride(opts.psychoeducationCueArm);
    },
    teardown: async () => {
      const { setFeatureOverrides, setPsychoeducationCueArmOverride } = await import(
        '../server/utils/sessionHelpers.js'
      );
      const { getVariant } = await import('./variants.js');
      setFeatureOverrides(await variantFeatures());
      if (opts.psychoeducationCueArm !== undefined) {
        setPsychoeducationCueArmOverride(getVariant(runVariantName()).psychoeducationCueArm ?? null);
      }
    },
  };
}

/** Scenario setup/teardown pair for an arm scenario. */
export function armHooks(arm: ProactiveArm): {
  setup: (pool: DbLike) => Promise<void>;
  teardown: (pool: DbLike) => Promise<void>;
} {
  return {
    setup: async () => forceProactiveArm(arm),
    teardown: async () => clearProactiveArm(),
  };
}
