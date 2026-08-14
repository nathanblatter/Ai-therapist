// Unit coverage for the in-process ops metrics collector (pass-3 telemetry):
// route-group classification, percentile math, and rolling-window pruning.
import { describe, it, expect } from 'vitest';
import { OpsMetricsCollector, classifyRoute, percentile } from './opsMetrics.service.js';

describe('classifyRoute', () => {
  it('groups participant-facing endpoints as participant_api', () => {
    expect(classifyRoute('/api/chat/message')).toBe('participant_api');
    expect(classifyRoute('/api/client-events')).toBe('participant_api');
    expect(classifyRoute('/token')).toBe('participant_api');
    expect(classifyRoute('/logs/batch')).toBe('participant_api');
    expect(classifyRoute('/health')).toBe('participant_api');
  });

  it('groups /admin/api/* as admin_api', () => {
    expect(classifyRoute('/admin/api/analytics')).toBe('admin_api');
    expect(classifyRoute('/admin/api/analytics/ops')).toBe('admin_api');
  });

  it('groups build assets and vite internals as static', () => {
    expect(classifyRoute('/assets/admin-abc123.js')).toBe('static');
    expect(classifyRoute('/@vite/client')).toBe('static');
    expect(classifyRoute('/favicon.ico')).toBe('static');
    expect(classifyRoute('/some/file.css')).toBe('static');
  });

  it('groups everything else as ssr', () => {
    expect(classifyRoute('/')).toBe('ssr');
    expect(classifyRoute('/login')).toBe('ssr');
    expect(classifyRoute('/admin')).toBe('ssr');
  });
});

describe('percentile', () => {
  it('returns null for an empty set', () => {
    expect(percentile([], 95)).toBeNull();
  });

  it('returns the single value for a one-element set', () => {
    expect(percentile([42], 50)).toBe(42);
    expect(percentile([42], 95)).toBe(42);
  });

  it('computes nearest-rank p50 and p95', () => {
    const values = Array.from({ length: 100 }, (_, i) => i + 1); // 1..100
    expect(percentile(values, 50)).toBe(50);
    expect(percentile(values, 95)).toBe(95);
  });

  it('does not mutate its input', () => {
    const values = [3, 1, 2];
    percentile(values, 95);
    expect(values).toEqual([3, 1, 2]);
  });
});

describe('OpsMetricsCollector', () => {
  it('counts requests and 4xx/5xx per group', () => {
    const c = new OpsMetricsCollector();
    const now = Date.now();
    c.record('participant_api', 200, 10, now);
    c.record('participant_api', 404, 5, now);
    c.record('participant_api', 500, 20, now);
    c.record('admin_api', 200, 15, now);

    const snap = c.snapshot(now);
    expect(snap.participant_api.requests).toBe(3);
    expect(snap.participant_api.status_4xx).toBe(1);
    expect(snap.participant_api.status_5xx).toBe(1);
    expect(snap.admin_api.requests).toBe(1);
    expect(snap.ssr.requests).toBe(0);
    expect(snap.ssr.p50_ms).toBeNull();
  });

  it('computes p50/p95 latency over recorded samples', () => {
    const c = new OpsMetricsCollector();
    const now = Date.now();
    for (let i = 1; i <= 100; i++) c.record('ssr', 200, i, now);
    const snap = c.snapshot(now);
    expect(snap.ssr.p50_ms).toBe(50);
    expect(snap.ssr.p95_ms).toBe(95);
  });

  it('drops samples that fall outside the rolling window', () => {
    const c = new OpsMetricsCollector({ windowMs: 60_000 });
    const t0 = Date.now();
    c.record('participant_api', 200, 10, t0);
    c.record('participant_api', 200, 20, t0 + 30_000);

    // 61s after t0: the first sample has aged out, the second remains.
    const snap = c.snapshot(t0 + 61_000);
    expect(snap.participant_api.requests).toBe(1);
    expect(snap.participant_api.p50_ms).toBe(20);
  });

  it('bounds memory under a sample flood', () => {
    const c = new OpsMetricsCollector({ maxSamples: 100 });
    const now = Date.now();
    for (let i = 0; i < 500; i++) c.record('static', 200, 1, now);
    const snap = c.snapshot(now);
    expect(snap.static.requests).toBeLessThanOrEqual(101);
  });
});
