// Forcing the proactive_offering experimental arm (ai-therapist-74, migration
// 042) for the ARM-01/ARM-02 scenarios.
//
// /api/chat/start resolves the arm once per session through
// resolveProactiveOffering(), which reads system_config.features
// .proactive_offering.mode ('always' | 'never' | 'ab_test', default ab_test =
// a 50/50 roll). The harness pins the mode IN THIS PROCESS ONLY by setting it
// on the cached config object getSystemConfig() hands out; nothing is written
// to system_config. That matters: the in-app harness runner spawns the CLI
// against the live database, where a write would change the arm for real
// participants.
//
// The override reaches the server only because getSystemConfig() returns its
// cache object by reference. If that ever changes, the override silently
// stops working, so every arm scenario also asserts armRecorded(): the session
// row must show the forced arm and its prompt section, or the scenario fails.
import type { DbLike } from './types.js';
import type { ProactiveArm } from './relationalAssertions.js';

export async function forceProactiveArm(arm: ProactiveArm): Promise<void> {
  const { getSystemConfig } = await import('../server/utils/sessionHelpers.js');
  const config = await getSystemConfig();
  const features = (config.features ?? {}) as Record<string, unknown>;
  features.proactive_offering = { mode: arm === 'proactive' ? 'always' : 'never' };
  config.features = features;
}

/** Drop the override: the next read reloads system_config from the database. */
export async function clearProactiveArm(): Promise<void> {
  const { invalidateConfigCache } = await import('../server/utils/sessionHelpers.js');
  invalidateConfigCache();
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
