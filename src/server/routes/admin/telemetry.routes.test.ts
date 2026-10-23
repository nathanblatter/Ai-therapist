// Route coverage for the telemetry read endpoints (ai-therapist-205): all
// three are researcher-only, clamp the window, pass the flag state through
// honestly, and surface a query failure as a 500 rather than a hang.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

const mocks = vi.hoisted(() => ({
  getAdminUsageStats: vi.fn(),
  getAdminViewReach: vi.fn(),
  getAdminViewUsageByRole: vi.fn(),
  getEngagementEventStats: vi.fn(),
  getSessionRhythmSummary: vi.fn(),
  getLatencyStats: vi.fn(),
  getLatencyDrift: vi.fn(),
  getSessionLatency: vi.fn(),
  getSystemConfig: vi.fn(),
}));

vi.mock('../../db/index.js', () => mocks);
vi.mock('../../utils/sessionHelpers.js', () => ({ getSystemConfig: mocks.getSystemConfig }));

import telemetryRoutes from './telemetry.routes.js';

function appAs(role: string | null, userId: number | null = 1) {
  const app = express();
  app.use((req, _res, next) => {
    (req as unknown as { session: Record<string, unknown> }).session = {
      ...(userId !== null ? { userId } : {}),
      ...(role !== null ? { userRole: role } : {}),
    };
    next();
  });
  app.use(telemetryRoutes());
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getAdminUsageStats.mockResolvedValue([{ kind: 'view_open', count: 12, last_seen: new Date() }]);
  mocks.getAdminViewReach.mockResolvedValue([{ view: 'sessions', opens: 9 }]);
  mocks.getAdminViewUsageByRole.mockResolvedValue([{ view: 'sessions', role: 'therapist', opens: 9, visible_ms: 61000 }]);
  mocks.getEngagementEventStats.mockResolvedValue([]);
  mocks.getSessionRhythmSummary.mockResolvedValue({
    sessions: 4, participants: 2, p50_duration_seconds: 900, p50_gap_seconds: 86400, start_hours: [{ start_hour: 9, sessions: 4 }],
  });
  mocks.getLatencyStats.mockResolvedValue([{ channel: 'realtime', turns: 40, p50_ttfa_ms: 800, p95_ttfa_ms: 1900, p50_total_ms: 6200, p95_total_ms: 14000 }]);
  mocks.getLatencyDrift.mockResolvedValue([]);
  mocks.getSessionLatency.mockResolvedValue([]);
  mocks.getSystemConfig.mockResolvedValue({ features: { telemetry_interaction_timing: false, telemetry_engagement_events: false } });
});

describe('role gating', () => {
  it.each([
    '/admin/api/telemetry/admin-usage',
    '/admin/api/telemetry/engagement',
    '/admin/api/telemetry/latency',
  ])('%s is researcher-only', async (path) => {
    expect((await request(appAs(null, null)).get(path)).status).toBe(401);
    expect((await request(appAs('therapist')).get(path)).status).toBe(403);
    expect((await request(appAs('caseworker')).get(path)).status).toBe(403);
    expect((await request(appAs('researcher')).get(path)).status).toBe(200);
  });
});

describe('GET /admin/api/telemetry/admin-usage', () => {
  it('returns kinds, reach, and the per-role split for the window', async () => {
    const res = await request(appAs('researcher')).get('/admin/api/telemetry/admin-usage?days=14');
    expect(res.status).toBe(200);
    expect(res.body.days).toBe(14);
    expect(mocks.getAdminUsageStats).toHaveBeenCalledWith(14);
    expect(mocks.getAdminViewReach).toHaveBeenCalledWith(14);
    expect(mocks.getAdminViewUsageByRole).toHaveBeenCalledWith(14);
    expect(res.body.reach).toEqual([{ view: 'sessions', opens: 9 }]);
    expect(res.body.byRole[0]).toMatchObject({ view: 'sessions', role: 'therapist', opens: 9 });
  });

  it('clamps the window to 1..365 and defaults to 30', async () => {
    await request(appAs('researcher')).get('/admin/api/telemetry/admin-usage?days=9999');
    expect(mocks.getAdminUsageStats).toHaveBeenLastCalledWith(365);
    await request(appAs('researcher')).get('/admin/api/telemetry/admin-usage?days=0');
    expect(mocks.getAdminUsageStats).toHaveBeenLastCalledWith(1);
    await request(appAs('researcher')).get('/admin/api/telemetry/admin-usage?days=banana');
    expect(mocks.getAdminUsageStats).toHaveBeenLastCalledWith(30);
    await request(appAs('researcher')).get('/admin/api/telemetry/admin-usage');
    expect(mocks.getAdminUsageStats).toHaveBeenLastCalledWith(30);
  });

  it('500s when a query fails', async () => {
    mocks.getAdminViewReach.mockRejectedValueOnce(new Error('db down'));
    const res = await request(appAs('researcher')).get('/admin/api/telemetry/admin-usage');
    expect(res.status).toBe(500);
  });
});

describe('GET /admin/api/telemetry/engagement', () => {
  it('reports the Phase 2 flag state alongside the (empty) kinds', async () => {
    const res = await request(appAs('researcher')).get('/admin/api/telemetry/engagement');
    expect(res.status).toBe(200);
    expect(res.body.flags).toEqual({ telemetry_interaction_timing: false, telemetry_engagement_events: false });
    expect(res.body.kinds).toEqual([]);
    expect(res.body.rhythm.sessions).toBe(4);
    expect(mocks.getEngagementEventStats).toHaveBeenCalledWith(30);
    expect(mocks.getSessionRhythmSummary).toHaveBeenCalledWith(30);
  });

  it('passes a true flag through and never invents one', async () => {
    mocks.getSystemConfig.mockResolvedValue({ features: { telemetry_engagement_events: true, telemetry_interaction_timing: 'yes' } });
    const res = await request(appAs('researcher')).get('/admin/api/telemetry/engagement');
    expect(res.body.flags).toEqual({ telemetry_interaction_timing: false, telemetry_engagement_events: true });
  });

  it('treats a config read failure as all flags off (still 200)', async () => {
    mocks.getSystemConfig.mockRejectedValueOnce(new Error('config down'));
    const res = await request(appAs('researcher')).get('/admin/api/telemetry/engagement');
    expect(res.status).toBe(200);
    expect(res.body.flags).toEqual({ telemetry_interaction_timing: false, telemetry_engagement_events: false });
  });

  it('500s when a query fails', async () => {
    mocks.getSessionRhythmSummary.mockRejectedValueOnce(new Error('db down'));
    expect((await request(appAs('researcher')).get('/admin/api/telemetry/engagement')).status).toBe(500);
  });
});

describe('GET /admin/api/telemetry/latency', () => {
  it('returns per-channel stats and drift over a 7-day default window', async () => {
    const res = await request(appAs('researcher')).get('/admin/api/telemetry/latency');
    expect(res.status).toBe(200);
    expect(res.body.days).toBe(7);
    expect(res.body.channels[0]).toMatchObject({ channel: 'realtime', turns: 40 });
    expect(res.body.session).toBeNull();
    expect(mocks.getLatencyStats).toHaveBeenCalledWith(7);
    expect(mocks.getLatencyDrift).toHaveBeenCalledWith(7);
    expect(mocks.getSessionLatency).not.toHaveBeenCalled();
  });

  it('includes one session\'s measured turns when sessionId is given', async () => {
    mocks.getSessionLatency.mockResolvedValue([{ turn_index: 1, user_done_at: new Date().toISOString(), ttfa_ms: 900, total_ms: 4200, channel: 'realtime' }]);
    const res = await request(appAs('researcher')).get('/admin/api/telemetry/latency?days=30&sessionId=sess_abc123');
    expect(res.status).toBe(200);
    expect(mocks.getSessionLatency).toHaveBeenCalledWith('sess_abc123');
    expect(res.body.session.sessionId).toBe('sess_abc123');
    expect(res.body.session.turns).toHaveLength(1);
  });

  it('400s a malformed sessionId before querying', async () => {
    const res = await request(appAs('researcher')).get('/admin/api/telemetry/latency?sessionId=' + encodeURIComponent("x' OR 1=1"));
    expect(res.status).toBe(400);
    expect(mocks.getSessionLatency).not.toHaveBeenCalled();
  });

  it('500s when a query fails', async () => {
    mocks.getLatencyStats.mockRejectedValueOnce(new Error('db down'));
    expect((await request(appAs('researcher')).get('/admin/api/telemetry/latency')).status).toBe(500);
  });
});
