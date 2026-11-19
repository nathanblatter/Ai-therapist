import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';

// Mock the database pool so the rate-limit logic can be exercised without Postgres.
const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn() }));
vi.mock('../config/db.js', () => ({ pool: { query: queryMock } }));

import {
  checkSessionLimits,
  invalidateConfigCache,
  resolveProactiveOffering,
  resolvePsychoeducationCue,
  resetPsychoeducationCueColumnCache,
  resolveLeadConversation,
  getSystemPrompt,
  getSystemConfig,
  setFeatureOverrides,
  setPsychoeducationCueArmOverride,
} from './sessionHelpers.js';

// The harness overrides are module state in sessionHelpers: the arm pinned by
// 'pins the psychoeducation-cue arm' used to stay pinned for whichever test ran
// next (ai-therapist-370). A Math.random spy left behind by a failed assertion
// is restored here too.
afterEach(() => {
  setFeatureOverrides(null);
  setPsychoeducationCueArmOverride(null);
  vi.restoreAllMocks();
});

const SESSION_LIMITS = {
  enabled: true,
  max_sessions_per_day: 3,
  cooldown_minutes: 30,
  max_duration_minutes: 30,
};

interface SetupOptions {
  limits?: {
    enabled: boolean;
    max_sessions_per_day?: number;
    cooldown_minutes?: number;
    max_duration_minutes?: number;
  };
  todayCount?: number;
  lastEndedAt?: Date | null;
}

function setup({ limits = SESSION_LIMITS, todayCount = 0, lastEndedAt = null }: SetupOptions = {}) {
  queryMock.mockReset();
  queryMock.mockImplementation((sql: string) => {
    if (sql.includes('system_config')) {
      return Promise.resolve({ rows: [{ config_key: 'session_limits', config_value: limits }] });
    }
    if (sql.includes('COUNT(*)')) {
      return Promise.resolve({ rows: [{ session_count: String(todayCount) }] });
    }
    if (sql.includes('ended_at')) {
      return Promise.resolve({ rows: lastEndedAt ? [{ ended_at: lastEndedAt }] : [] });
    }
    return Promise.resolve({ rows: [] });
  });
  // getSystemConfig caches across calls; reset it so each test sees its own config.
  invalidateConfigCache();
}

describe('checkSessionLimits', () => {
  beforeEach(() => setup());

  it('allows anonymous users (no userId)', async () => {
    const r = await checkSessionLimits(null);
    expect(r.allowed).toBe(true);
  });

  it('exempts researchers from limits', async () => {
    const r = await checkSessionLimits(1, 'researcher');
    expect(r).toMatchObject({ allowed: true, bypass: 'researcher' });
  });

  it('allows when session limits are disabled', async () => {
    setup({ limits: { enabled: false } });
    const r = await checkSessionLimits(1, 'participant');
    expect(r.allowed).toBe(true);
  });

  it('denies when the daily session limit is reached', async () => {
    setup({ todayCount: 3 });
    const r = await checkSessionLimits(1, 'participant');
    expect(r).toMatchObject({ allowed: false, reason: 'daily_limit', limit: 3, current: 3 });
  });

  it('denies during the cooldown window after a recent session', async () => {
    setup({ todayCount: 0, lastEndedAt: new Date(Date.now() - 10 * 60 * 1000) });
    const r = await checkSessionLimits(1, 'participant');
    expect(r).toMatchObject({ allowed: false, reason: 'cooldown' });
  });

  it('allows once the cooldown has elapsed', async () => {
    setup({ todayCount: 0, lastEndedAt: new Date(Date.now() - 60 * 60 * 1000) });
    const r = await checkSessionLimits(1, 'participant');
    expect(r.allowed).toBe(true);
  });
});

// ---------- ai-therapist-74: proactive-vs-reactive exercise offering ----------

function setupFeatures(features: Record<string, unknown>) {
  queryMock.mockReset();
  queryMock.mockImplementation((sql: string) => {
    if (sql.includes('system_config')) {
      return Promise.resolve({ rows: [{ config_key: 'features', config_value: features }] });
    }
    return Promise.resolve({ rows: [] });
  });
  invalidateConfigCache();
}

describe('resolveProactiveOffering', () => {
  it('"always" mode always returns true', async () => {
    setupFeatures({ proactive_offering: { mode: 'always' } });
    expect(await resolveProactiveOffering()).toBe(true);
    expect(await resolveProactiveOffering()).toBe(true);
  });

  it('"never" mode always returns false', async () => {
    setupFeatures({ proactive_offering: { mode: 'never' } });
    expect(await resolveProactiveOffering()).toBe(false);
  });

  it('defaults to ab_test (random 50/50) when unconfigured', async () => {
    setupFeatures({});
    const mathRandomSpy = vi.spyOn(Math, 'random');
    mathRandomSpy.mockReturnValueOnce(0.1); // < 0.5 -> true
    expect(await resolveProactiveOffering()).toBe(true);
    mathRandomSpy.mockReturnValueOnce(0.9); // >= 0.5 -> false
    expect(await resolveProactiveOffering()).toBe(false);
    mathRandomSpy.mockRestore();
  });
});

describe('getSystemPrompt proactive-offering appendix', () => {
  beforeEach(() => setupFeatures({}));

  it('appends proactive steering when proactiveOffering=true is passed explicitly', async () => {
    const prompt = await getSystemPrompt('en', 'realtime', true);
    expect(prompt).toMatch(/research condition: proactive/);
    expect(prompt).toMatch(/proactively OFFER one concrete, fitting exercise/);
  });

  it('appends reactive-only steering when proactiveOffering=false is passed explicitly', async () => {
    const prompt = await getSystemPrompt('en', 'realtime', false);
    expect(prompt).toMatch(/research condition: reactive/);
    expect(prompt).not.toMatch(/research condition: proactive/);
  });

  it('resolves internally (does not throw) when no override is passed', async () => {
    const prompt = await getSystemPrompt('en', 'realtime');
    expect(prompt).toMatch(/research condition: (proactive|reactive)/);
  });
});

// ---------- ai-therapist-202: psychoeducation retrieval cue experiment ----------

function setupCue(features: Record<string, unknown>, column: 'present' | 'absent' | 'error' = 'present') {
  queryMock.mockReset();
  queryMock.mockImplementation((sql: string) => {
    if (sql.includes('system_config')) {
      return Promise.resolve({ rows: [{ config_key: 'features', config_value: features }] });
    }
    if (sql.includes('information_schema.columns')) {
      if (column === 'error') return Promise.reject(new Error('db down'));
      return Promise.resolve({ rows: column === 'present' ? [{ '?column?': 1 }] : [] });
    }
    return Promise.resolve({ rows: [] });
  });
  invalidateConfigCache();
  resetPsychoeducationCueColumnCache();
}

describe('resolvePsychoeducationCue', () => {
  it('is off (null, no cue) by default when the flag is unset', async () => {
    setupCue({});
    expect(await resolvePsychoeducationCue()).toBeNull();
    // Flag off never even checks the schema.
    expect(queryMock.mock.calls.some(([sql]) => String(sql).includes('information_schema'))).toBe(false);
  });

  it('is off unless the flag is exactly true', async () => {
    setupCue({ psychoeducation_cue_ab_enabled: 'true' });
    expect(await resolvePsychoeducationCue()).toBeNull();
  });

  it('splits sessions 50/50 when the flag is on and the column exists', async () => {
    setupCue({ psychoeducation_cue_ab_enabled: true });
    const spy = vi.spyOn(Math, 'random');
    spy.mockReturnValueOnce(0.1);
    expect(await resolvePsychoeducationCue()).toBe(true);
    spy.mockReturnValueOnce(0.5);
    expect(await resolvePsychoeducationCue()).toBe(false);
    spy.mockRestore();
  });

  it('runs as control (null) when migration 123 has not been applied', async () => {
    setupCue({ psychoeducation_cue_ab_enabled: true }, 'absent');
    const spy = vi.spyOn(Math, 'random');
    expect(await resolvePsychoeducationCue()).toBeNull();
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it('runs as control (null) and does not throw when the column check fails', async () => {
    setupCue({ psychoeducation_cue_ab_enabled: true }, 'error');
    await expect(resolvePsychoeducationCue()).resolves.toBeNull();
  });

  it('re-checks a missing column so a hand-applied migration is picked up without a restart', async () => {
    setupCue({ psychoeducation_cue_ab_enabled: true }, 'absent');
    expect(await resolvePsychoeducationCue()).toBeNull();
    queryMock.mockImplementation((sql: string) => {
      if (sql.includes('system_config')) {
        return Promise.resolve({
          rows: [{ config_key: 'features', config_value: { psychoeducation_cue_ab_enabled: true } }],
        });
      }
      if (sql.includes('information_schema.columns')) return Promise.resolve({ rows: [{ '?column?': 1 }] });
      return Promise.resolve({ rows: [] });
    });
    expect(typeof (await resolvePsychoeducationCue())).toBe('boolean');
  });
});

// ---------- lead-conversation flag (owner feedback 2026-11-16) ----------

describe('resolveLeadConversation', () => {
  it('is off by default when the flag is unset', async () => {
    setupCue({});
    expect(await resolveLeadConversation()).toBe(false);
  });

  it('is off unless the flag is exactly true', async () => {
    setupCue({ lead_conversation_enabled: 'true' });
    expect(await resolveLeadConversation()).toBe(false);
    setupCue({ lead_conversation_enabled: 1 });
    expect(await resolveLeadConversation()).toBe(false);
  });

  it('is on for every session when the flag is true (no random assignment)', async () => {
    setupCue({ lead_conversation_enabled: true });
    const spy = vi.spyOn(Math, 'random');
    expect(await resolveLeadConversation()).toBe(true);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it('does not change the base prompt either way', async () => {
    setupCue({ lead_conversation_enabled: true });
    const on = await getSystemPrompt('en', 'realtime', false);
    setupCue({});
    const off = await getSystemPrompt('en', 'realtime', false);
    expect(on).toBe(off);
    expect(on).not.toContain('Leading the conversation');
  });
});

// ---------- red-team variant hooks (src/redteam/variants.ts) ----------

describe('harness overrides', () => {
  beforeEach(() => {
    setFeatureOverrides(null);
    setPsychoeducationCueArmOverride(null);
  });

  it('overlays feature flags in-process without touching the database', async () => {
    setupCue({ chat_enabled: true });
    setFeatureOverrides({ lead_conversation_enabled: true });
    expect(await resolveLeadConversation()).toBe(true);
    const features = (await getSystemConfig()).features ?? {};
    expect(features.chat_enabled).toBe(true);
    expect(features.lead_conversation_enabled).toBe(true);
    expect(queryMock.mock.calls.some(([sql]) => /UPDATE|INSERT/i.test(String(sql)))).toBe(false);
    setFeatureOverrides(null);
    expect(await resolveLeadConversation()).toBe(false);
  });

  it('pins the psychoeducation-cue arm only when the experiment is on', async () => {
    setPsychoeducationCueArmOverride(true);
    setupCue({});
    expect(await resolvePsychoeducationCue()).toBeNull();
    setupCue({ psychoeducation_cue_ab_enabled: true });
    const spy = vi.spyOn(Math, 'random').mockReturnValue(0.9);
    for (let i = 0; i < 3; i++) expect(await resolvePsychoeducationCue()).toBe(true);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});
