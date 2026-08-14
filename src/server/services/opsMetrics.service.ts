// In-process HTTP ops metrics (pass-3 telemetry). A tiny rolling-window
// collector fed by a request middleware in the composition root: per
// route-group request counts, 4xx/5xx counts, and p50/p95 latency over the
// last hour. Everything lives in memory — restart resets it, no DB involved.
// The admin ops endpoint (routes/admin/ops.routes.ts) snapshots it.

import type { Request, Response, NextFunction } from 'express';

export type RouteGroup = 'participant_api' | 'admin_api' | 'ssr' | 'static';

interface Sample {
  t: number;          // epoch ms when the response finished
  group: RouteGroup;
  status: number;
  durationMs: number;
}

export interface GroupSnapshot {
  requests: number;
  status_4xx: number;
  status_5xx: number;
  p50_ms: number | null;
  p95_ms: number | null;
}

export type OpsSnapshot = Record<RouteGroup, GroupSnapshot>;

const GROUPS: RouteGroup[] = ['participant_api', 'admin_api', 'ssr', 'static'];

// Anything that is clearly a build asset / dev-server internal request.
const STATIC_RE = /(^\/(assets|@vite|@fs|@react-refresh|node_modules|src)\/)|\.(js|mjs|cjs|css|map|png|jpe?g|gif|svg|ico|woff2?|ttf|webp|mp3|wasm)(\?|$)/;

/** Classify a request path into one of the four dashboard route groups. */
export function classifyRoute(path: string): RouteGroup {
  if (STATIC_RE.test(path)) return 'static';
  if (path.startsWith('/admin/api/')) return 'admin_api';
  if (
    path.startsWith('/api/') ||
    path === '/token' ||
    path === '/health' ||
    path === '/csp-report' ||
    path.startsWith('/logs/') ||
    path.startsWith('/socket.io')
  ) {
    return 'participant_api';
  }
  return 'ssr';
}

/** Nearest-rank percentile over an UNSORTED copy of values. */
export function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.max(1, Math.ceil((p / 100) * sorted.length));
  return sorted[rank - 1];
}

export class OpsMetricsCollector {
  private samples: Sample[] = [];
  private readonly windowMs: number;
  private readonly maxSamples: number;
  private readonly startedAt = Date.now();

  constructor(opts: { windowMs?: number; maxSamples?: number } = {}) {
    this.windowMs = opts.windowMs ?? 60 * 60 * 1000; // 60 min
    this.maxSamples = opts.maxSamples ?? 50_000;      // memory bound
  }

  record(group: RouteGroup, status: number, durationMs: number, now = Date.now()): void {
    this.samples.push({ t: now, group, status, durationMs });
    // Bound memory even under a burst: drop the oldest half when over cap.
    if (this.samples.length > this.maxSamples) {
      this.samples = this.samples.slice(this.samples.length - Math.floor(this.maxSamples / 2));
    }
    this.prune(now);
  }

  private prune(now: number): void {
    const cutoff = now - this.windowMs;
    // Samples are appended in time order; find the first one still in-window.
    let firstLive = 0;
    while (firstLive < this.samples.length && this.samples[firstLive].t < cutoff) firstLive++;
    if (firstLive > 0) this.samples = this.samples.slice(firstLive);
  }

  snapshot(now = Date.now()): OpsSnapshot {
    this.prune(now);
    const out = {} as OpsSnapshot;
    for (const group of GROUPS) {
      const rows = this.samples.filter(s => s.group === group);
      const durations = rows.map(s => s.durationMs);
      out[group] = {
        requests: rows.length,
        status_4xx: rows.filter(s => s.status >= 400 && s.status < 500).length,
        status_5xx: rows.filter(s => s.status >= 500).length,
        p50_ms: percentile(durations, 50),
        p95_ms: percentile(durations, 95),
      };
    }
    return out;
  }

  get windowMinutes(): number {
    return Math.round(this.windowMs / 60_000);
  }

  get uptimeSeconds(): number {
    return Math.round((Date.now() - this.startedAt) / 1000);
  }
}

/** Process-wide singleton fed by the middleware below. */
export const opsMetrics = new OpsMetricsCollector();

/**
 * Express middleware: times every response and feeds the collector. Mounted
 * once in the composition root, before the routers. Independent of pino-http
 * so metrics keep flowing even if logging is reconfigured.
 */
export function opsMetricsMiddleware(collector: OpsMetricsCollector = opsMetrics) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const start = process.hrtime.bigint();
    res.on('finish', () => {
      const durationMs = Number(process.hrtime.bigint() - start) / 1e6;
      collector.record(classifyRoute(req.path || req.url), res.statusCode, durationMs);
    });
    next();
  };
}
