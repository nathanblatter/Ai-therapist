// Wording of the red-team config drift notice (ConfigEvalNotice.tsx).
import { describe, it, expect } from 'vitest';
import { headline, nextStep, type ConfigEvalStatus } from './ConfigEvalNotice';

function status(over: Partial<ConfigEvalStatus> = {}): ConfigEvalStatus {
  return {
    fingerprint: 'f'.repeat(64),
    short_fingerprint: 'ffffffffffff',
    state: 'unevaluated',
    evaluated: false,
    last_change: { at: '2026-11-18T10:00:00Z', by: 'researcher_a', key: 'system_prompts' },
    current_evaluation: null,
    last_evaluated: null,
    reason: 'settling',
    runs_last_24h: 0,
    daily_cap: 4,
    settle_minutes: 10,
    table_missing: false,
    ...over,
  };
}

describe('ConfigEvalNotice wording', () => {
  it('names when and by whom the configuration changed', () => {
    const h = headline(status());
    expect(h).toMatch(
      /^The AI configuration was changed on .+ by researcher_a and has not been through the safety evaluation\.$/,
    );
    expect(headline(status({ last_change: { at: null, by: null, key: null } }))).toBe(
      'The AI configuration on this environment has not been through the safety evaluation.',
    );
  });

  it('says what happens next for each state', () => {
    expect(nextStep(status())).toMatch(/unchanged for 10 minutes/);
    expect(nextStep(status({ reason: 'daily_cap' }))).toMatch(/daily limit of 4/);
    expect(nextStep(status({ table_missing: true }))).toMatch(/migration 126/);
    const failed = {
      id: 1,
      fingerprint: 'f'.repeat(64),
      status: 'failed' as const,
      started_at: '2026-11-18T10:00:00Z',
      finished_at: '2026-11-18T10:10:00Z',
      scenarios_total: 20,
      scenarios_passed: 18,
      scenarios_failed: 2,
      known_gaps: 1,
      result_url: null,
    };
    expect(nextStep(status({ state: 'failed', current_evaluation: failed }))).toMatch(
      /FAILED the safety evaluation: Failed on .+ \(18 of 20 scenarios passed, 1 known gap\)/,
    );
    expect(nextStep(status({ state: 'running', current_evaluation: { ...failed, status: 'running' } }))).toMatch(
      /running since/,
    );
  });
});
