// Quiet hours (ai-therapist-152): env gating, the overnight wrap-around
// window, DST-correct Denver hour math, and the participant-only middleware.
import { describe, it, expect, afterEach } from 'vitest';
import {
  getQuietHoursConfig,
  denverHour,
  hourInWindow,
  isQuietHoursActive,
  getQuietHoursStatus,
} from './quietHours.js';
import { requireOutsideQuietHours } from '../middleware/quietHours.js';
import type { Request, Response } from 'express';

const ENV_KEYS = ['QUIET_HOURS_ENABLED', 'QUIET_HOURS_START_HOUR', 'QUIET_HOURS_END_HOUR'];

afterEach(() => {
  for (const k of ENV_KEYS) delete process.env[k];
});

describe('getQuietHoursConfig', () => {
  it('is disabled by default with the IRB window (22:00-06:00)', () => {
    expect(getQuietHoursConfig()).toEqual({ enabled: false, startHour: 22, endHour: 6 });
  });

  it('ignores invalid hour overrides', () => {
    process.env.QUIET_HOURS_ENABLED = 'true';
    process.env.QUIET_HOURS_START_HOUR = '25';
    process.env.QUIET_HOURS_END_HOUR = 'six';
    expect(getQuietHoursConfig()).toEqual({ enabled: true, startHour: 22, endHour: 6 });
  });
});

describe('denverHour (DST-correct)', () => {
  it('handles MST (winter, UTC-7)', () => {
    // 2026-01-15 05:00Z == 22:00 in Denver (MST)
    expect(denverHour(new Date('2026-01-15T05:00:00Z'))).toBe(22);
  });

  it('handles MDT (summer, UTC-6)', () => {
    // 2026-07-15 05:00Z == 23:00 in Denver (MDT)
    expect(denverHour(new Date('2026-07-15T05:00:00Z'))).toBe(23);
    // 2026-07-15 12:00Z == 06:00 in Denver (MDT)
    expect(denverHour(new Date('2026-07-15T12:00:00Z'))).toBe(6);
  });
});

describe('hourInWindow', () => {
  it('wraps overnight windows (22 -> 6)', () => {
    expect(hourInWindow(22, 22, 6)).toBe(true);
    expect(hourInWindow(23, 22, 6)).toBe(true);
    expect(hourInWindow(0, 22, 6)).toBe(true);
    expect(hourInWindow(5, 22, 6)).toBe(true);
    expect(hourInWindow(6, 22, 6)).toBe(false);
    expect(hourInWindow(12, 22, 6)).toBe(false);
    expect(hourInWindow(21, 22, 6)).toBe(false);
  });

  it('handles same-day windows and treats start==end as never active', () => {
    expect(hourInWindow(10, 9, 17)).toBe(true);
    expect(hourInWindow(17, 9, 17)).toBe(false);
    expect(hourInWindow(3, 3, 3)).toBe(false);
  });
});

describe('isQuietHoursActive / getQuietHoursStatus', () => {
  it('is inert when disabled, regardless of the hour', () => {
    expect(isQuietHoursActive(new Date('2026-01-15T05:00:00Z'))).toBe(false); // 22:00 Denver
    expect(getQuietHoursStatus().enabled).toBe(false);
  });

  it('activates inside the window when enabled', () => {
    process.env.QUIET_HOURS_ENABLED = 'true';
    expect(isQuietHoursActive(new Date('2026-01-15T05:00:00Z'))).toBe(true); // 22:00 MST
    expect(isQuietHoursActive(new Date('2026-01-15T19:00:00Z'))).toBe(false); // 12:00 MST
    const status = getQuietHoursStatus(new Date('2026-01-15T05:00:00Z'));
    expect(status).toMatchObject({ enabled: true, active: true, startHour: 22, endHour: 6, timezone: 'America/Denver' });
  });
});

describe('requireOutsideQuietHours middleware', () => {
  function run(session: Record<string, unknown>) {
    const req = { session } as unknown as Request;
    let statusCode: number | null = null;
    let body: unknown = null;
    const res = {
      status(code: number) { statusCode = code; return this; },
      json(payload: unknown) { body = payload; return this; },
    } as unknown as Response;
    let nexted = false;
    requireOutsideQuietHours(req, res, () => { nexted = true; });
    return { statusCode, body, nexted };
  }

  it('passes everyone through when quiet hours are disabled', () => {
    expect(run({ userRole: 'participant' }).nexted).toBe(true);
  });

  /** Force a window that provably contains the CURRENT Denver hour — the
   *  middleware reads the real clock, and a fixed 0-23 window is false at
   *  23:xx (hourInWindow(23, 0, 23) === false), i.e. a nightly CI flake. */
  function forceActiveWindow() {
    const h = denverHour();
    process.env.QUIET_HOURS_ENABLED = 'true';
    process.env.QUIET_HOURS_START_HOUR = String(h);
    process.env.QUIET_HOURS_END_HOUR = String((h + 1) % 24);
  }

  it('blocks participants (and role-less sessions) during active quiet hours', () => {
    forceActiveWindow();
    const blocked = run({ userRole: 'participant' });
    expect(blocked.nexted).toBe(false);
    expect(blocked.statusCode).toBe(403);
    expect(blocked.body).toMatchObject({ error: 'quiet_hours' });
    expect(run({}).nexted).toBe(false); // no role -> treated as participant
  });

  it('never blocks staff, demo, or sandbox users', () => {
    forceActiveWindow();
    expect(run({ userRole: 'researcher' }).nexted).toBe(true);
    expect(run({ userRole: 'therapist' }).nexted).toBe(true);
    expect(run({ userRole: 'caseworker' }).nexted).toBe(true);
    expect(run({ userRole: 'demo' }).nexted).toBe(true);
    expect(run({ userRole: 'participant', isSandbox: true }).nexted).toBe(true);
  });
});
