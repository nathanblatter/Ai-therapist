import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock the database pool so the rate-limit logic can be exercised without Postgres.
const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn() }));
vi.mock('../config/db.js', () => ({ pool: { query: queryMock } }));

import { checkSessionLimits, invalidateConfigCache } from './sessionHelpers.js';

const SESSION_LIMITS = {
  enabled: true,
  max_sessions_per_day: 3,
  cooldown_minutes: 30,
  max_duration_minutes: 30,
};

interface SetupOptions {
  limits?: { enabled: boolean; max_sessions_per_day?: number; cooldown_minutes?: number; max_duration_minutes?: number };
  todayCount?: number;
  lastEndedAt?: Date | null;
}

function setup({
  limits = SESSION_LIMITS,
  todayCount = 0,
  lastEndedAt = null,
}: SetupOptions = {}) {
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
