// Drift state, claim policy and the drift query (config_evaluations x the
// evaluated system_config rows) for the red-team config gate.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { queryMock, clientQueryMock, releaseMock } = vi.hoisted(() => ({
  queryMock: vi.fn(),
  clientQueryMock: vi.fn(),
  releaseMock: vi.fn(),
}));
vi.mock('../config/db.js', () => ({
  pool: {
    query: queryMock,
    connect: vi.fn(async () => ({ query: clientQueryMock, release: releaseMock })),
    on: vi.fn(),
  },
}));

import {
  STALE_RUNNING_MS,
  claimConfigEvaluation,
  decideClaim,
  deriveConfigEvalState,
  getConfigEvalStatus,
  lastConfigChange,
} from './configEvaluation.service.js';
import { fingerprintConfigRows } from '../utils/evaluatedConfig.js';
import type { ConfigEvaluationRow } from '../db/configEvaluations.queries.js';

const NOW = new Date('2026-11-18T12:00:00Z');

function evalRow(over: Partial<ConfigEvaluationRow>): ConfigEvaluationRow {
  return {
    id: 1,
    fingerprint: 'a'.repeat(64),
    config_version: 1,
    suite: 'full',
    status: 'passed',
    git_sha: 'abc1234',
    started_at: '2026-11-18T10:00:00Z',
    finished_at: '2026-11-18T10:10:00Z',
    scenarios_total: 20,
    scenarios_passed: 20,
    scenarios_failed: 0,
    known_gaps: 1,
    est_cost_usd: '0.2500',
    result_url: 'https://github.com/o/r/actions/runs/1',
    triggered_by: 'github-actions:schedule',
    config_changed_at: null,
    config_changed_by: null,
    error: null,
    ...over,
  };
}

const CONFIG_ROWS = [
  {
    config_key: 'system_prompts',
    config_value: { chat: { prompt: 'x'.repeat(120) } },
    updated_at: '2026-11-18T09:00:00Z',
    updated_by: 'researcher_a',
  },
  {
    config_key: 'features',
    config_value: { lead_conversation_enabled: true },
    updated_at: '2026-11-18T11:30:00Z',
    updated_by: 'researcher_b',
  },
  { config_key: 'ai_model', config_value: { model: 'gpt-live-1' }, updated_at: null, updated_by: null },
];
const FP = fingerprintConfigRows(CONFIG_ROWS);

/** Route the drift-query SQL to canned results. */
function routeQueries(
  fn: typeof queryMock,
  opts: {
    forFingerprint?: ConfigEvaluationRow[];
    latest?: ConfigEvaluationRow | null;
    count?: number;
    missing?: boolean;
  },
) {
  fn.mockImplementation(async (sql: string, params?: unknown[]) => {
    if (sql.includes('FROM system_config')) {
      expect(params?.[0]).toEqual(expect.arrayContaining(['system_prompts', 'features', 'ai_model', 'crisis']));
      return { rows: CONFIG_ROWS };
    }
    if (opts.missing && sql.includes('config_evaluations')) throw Object.assign(new Error('nope'), { code: '42P01' });
    if (sql.includes('WHERE fingerprint = $1')) {
      expect(params?.[0]).toBe(FP);
      return { rows: opts.forFingerprint ?? [] };
    }
    if (sql.includes("status IN ('passed', 'failed')")) return { rows: opts.latest ? [opts.latest] : [] };
    if (sql.includes('COUNT(*)')) return { rows: [{ n: String(opts.count ?? 0) }] };
    if (sql.includes('INSERT INTO config_evaluations')) {
      return { rows: [evalRow({ id: 9, status: 'running', fingerprint: params?.[0] as string, finished_at: null })] };
    }
    return { rows: [] };
  });
}

beforeEach(() => {
  queryMock.mockReset();
  clientQueryMock.mockReset();
  releaseMock.mockReset();
});
afterEach(() => {
  delete process.env.REDTEAM_CONFIG_EVAL_DAILY_CAP;
  delete process.env.REDTEAM_CONFIG_EVAL_SETTLE_MINUTES;
});

describe('deriveConfigEvalState', () => {
  it('passed wins over a later failure of the same fingerprint', () => {
    const r = deriveConfigEvalState([evalRow({ id: 2, status: 'failed' }), evalRow({ id: 1 })], NOW);
    expect(r.state).toBe('passed');
    expect(r.row?.id).toBe(1);
  });
  it('a fresh claim is running; a stale one or an error counts as unevaluated', () => {
    const fresh = evalRow({ status: 'running', started_at: new Date(NOW.getTime() - 60_000).toISOString() });
    const stale = evalRow({
      status: 'running',
      started_at: new Date(NOW.getTime() - STALE_RUNNING_MS - 1).toISOString(),
    });
    expect(deriveConfigEvalState([fresh], NOW).state).toBe('running');
    expect(deriveConfigEvalState([stale], NOW).state).toBe('unevaluated');
    expect(deriveConfigEvalState([evalRow({ status: 'error' })], NOW).state).toBe('unevaluated');
    expect(deriveConfigEvalState([], NOW).state).toBe('unevaluated');
  });
  it('a failure without a pass is failed', () => {
    expect(deriveConfigEvalState([evalRow({ status: 'failed' })], NOW).state).toBe('failed');
  });
});

describe('decideClaim', () => {
  const base = {
    lastChangeAt: '2026-11-18T10:00:00Z',
    now: NOW,
    runsLast24h: 0,
    cap: 4,
    settleMs: 600_000,
    force: false,
  };
  it('claims an unevaluated, settled configuration', () => {
    expect(decideClaim({ ...base, state: 'unevaluated' })).toEqual({ ok: true });
  });
  it('debounces an edit storm: a change inside the settle window waits', () => {
    expect(decideClaim({ ...base, state: 'unevaluated', lastChangeAt: '2026-11-18T11:55:00Z' })).toEqual({
      ok: false,
      reason: 'settling',
    });
  });
  it('runs a fingerprint once: never while running, not again after pass or fail unless forced', () => {
    expect(decideClaim({ ...base, state: 'running', force: true })).toEqual({ ok: false, reason: 'in_progress' });
    expect(decideClaim({ ...base, state: 'passed' })).toEqual({ ok: false, reason: 'already_passed' });
    expect(decideClaim({ ...base, state: 'failed' })).toEqual({ ok: false, reason: 'failed_needs_manual_rerun' });
    expect(decideClaim({ ...base, state: 'failed', force: true })).toEqual({ ok: true });
  });
  it('enforces the daily cap even when forced', () => {
    expect(decideClaim({ ...base, state: 'unevaluated', runsLast24h: 4 })).toEqual({ ok: false, reason: 'daily_cap' });
    expect(decideClaim({ ...base, state: 'failed', force: true, runsLast24h: 4 })).toEqual({
      ok: false,
      reason: 'daily_cap',
    });
  });
});

describe('lastConfigChange', () => {
  it('picks the newest edit to an evaluated key, from the audit columns', () => {
    expect(lastConfigChange(CONFIG_ROWS)).toEqual({
      at: '2026-11-18T11:30:00.000Z',
      by: 'researcher_b',
      key: 'features',
    });
    expect(lastConfigChange([])).toEqual({ at: null, by: null, key: null });
  });
});

describe('getConfigEvalStatus (drift query)', () => {
  it('reports drift with the last change and the last evaluated result when the fingerprint has no pass', async () => {
    const other = evalRow({ id: 5, fingerprint: 'b'.repeat(64) });
    routeQueries(queryMock, { forFingerprint: [], latest: other, count: 1 });
    const s = await getConfigEvalStatus(NOW);
    expect(s.fingerprint).toBe(FP);
    expect(s.state).toBe('unevaluated');
    expect(s.evaluated).toBe(false);
    expect(s.last_change.by).toBe('researcher_b');
    expect(s.last_evaluated?.id).toBe(5);
    expect(s.current_evaluation).toBeNull();
    // Last edit 30 min ago, outside the 10-minute settle window.
    expect(s.should_run).toBe(true);
    expect(s).toMatchObject({ runs_last_24h: 1, daily_cap: 4, settle_minutes: 10, table_missing: false });
  });

  it('is clean once the current fingerprint has a passing evaluation', async () => {
    routeQueries(queryMock, { forFingerprint: [evalRow({ fingerprint: FP })], latest: evalRow({ fingerprint: FP }) });
    const s = await getConfigEvalStatus(NOW);
    expect(s.evaluated).toBe(true);
    expect(s.should_run).toBe(false);
    expect(s.reason).toBe('already_passed');
  });

  it('degrades to "unevaluated, not migrated" when the table is missing', async () => {
    routeQueries(queryMock, { missing: true });
    const s = await getConfigEvalStatus(NOW);
    expect(s).toMatchObject({ state: 'unevaluated', table_missing: true, should_run: false, reason: 'not_migrated' });
  });

  it('honours the env overrides for cap and settle window', async () => {
    process.env.REDTEAM_CONFIG_EVAL_DAILY_CAP = '1';
    process.env.REDTEAM_CONFIG_EVAL_SETTLE_MINUTES = '60';
    routeQueries(queryMock, { count: 0 });
    const s = await getConfigEvalStatus(NOW);
    expect(s.daily_cap).toBe(1);
    expect(s.reason).toBe('settling');
  });
});

describe('claimConfigEvaluation', () => {
  it('locks, records a running claim with provenance and returns the snapshot of that fingerprint', async () => {
    routeQueries(clientQueryMock, {});
    const out = await claimConfigEvaluation({
      suite: 'full',
      triggeredBy: 'github-actions:schedule',
      gitSha: 'abc1234',
      resultUrl: null,
      environment: 'stage',
      force: false,
      now: NOW,
    });
    expect(out.claimed).toBe(true);
    if (!out.claimed) return;
    expect(out.snapshot.fingerprint).toBe(FP);
    expect(out.snapshot.environment).toBe('stage');
    const sqls = clientQueryMock.mock.calls.map((c) => String(c[0]));
    expect(sqls[0]).toBe('BEGIN');
    expect(sqls[1]).toContain('pg_advisory_xact_lock');
    expect(sqls.at(-1)).toBe('COMMIT');
    const insert = clientQueryMock.mock.calls.find((c) => String(c[0]).includes('INSERT INTO config_evaluations'));
    expect(insert?.[1]).toEqual([
      FP,
      1,
      'full',
      'abc1234',
      null,
      'github-actions:schedule',
      '2026-11-18T11:30:00.000Z',
      'researcher_b',
    ]);
    expect(releaseMock).toHaveBeenCalled();
  });

  it('refuses (and writes nothing) when the fingerprint is already running', async () => {
    routeQueries(clientQueryMock, {
      forFingerprint: [
        evalRow({ fingerprint: FP, status: 'running', started_at: NOW.toISOString(), finished_at: null }),
      ],
    });
    const out = await claimConfigEvaluation({
      suite: 'full',
      triggeredBy: 't',
      gitSha: null,
      resultUrl: null,
      environment: null,
      force: true,
      now: NOW,
    });
    expect(out).toMatchObject({ claimed: false, reason: 'in_progress' });
    const sqls = clientQueryMock.mock.calls.map((c) => String(c[0]));
    expect(sqls.some((s) => s.includes('INSERT'))).toBe(false);
    expect(sqls.at(-1)).toBe('ROLLBACK');
  });
});
