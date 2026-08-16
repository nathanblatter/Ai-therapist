import { describe, it, expect, vi, beforeEach } from 'vitest';

const { queryMock, clientQueryMock, releaseMock, connectMock } = vi.hoisted(() => {
  const clientQueryMock = vi.fn();
  const releaseMock = vi.fn();
  return {
    queryMock: vi.fn(),
    clientQueryMock,
    releaseMock,
    connectMock: vi.fn(async () => ({ query: clientQueryMock, release: releaseMock })),
  };
});
vi.mock('../config/db.js', () => ({
  pool: { query: queryMock, connect: connectMock, on: vi.fn() },
}));

import { insertHarnessRun, listHarnessRuns, getHarnessRun } from './harnessRuns.queries.js';

beforeEach(() => {
  queryMock.mockReset();
  clientQueryMock.mockReset();
  releaseMock.mockReset();
});

const SCENARIO = {
  scenarioId: 'voice-first-session',
  variation: 0,
  pipeline: 'voice',
  passed: true,
  assertionFailures: [],
  judgeScores: { empathy: 5 },
  sessionId: 'sess_1',
  durationMs: 1000,
  costUsd: 0.0011,
};

describe('insertHarnessRun', () => {
  it('wraps run + scenario inserts in one transaction and returns the id', async () => {
    clientQueryMock.mockImplementation(async (sql: string) =>
      sql.includes('INSERT INTO harness_runs') ? { rows: [{ id: 7 }] } : { rows: [] });

    const id = await insertHarnessRun({
      startedAt: '2026-08-15T00:00:00Z', finishedAt: '2026-08-15T00:01:00Z',
      suite: 'voice', seed: 42, variations: 2, judgeModel: 'gpt-4o-mini',
      gitSha: 'abc', trigger: 'manual',
      scenarios: [SCENARIO, { ...SCENARIO, variation: 1, passed: false }],
    });

    expect(id).toBe(7);
    const sqls = clientQueryMock.mock.calls.map(c => c[0]);
    expect(sqls[0]).toBe('BEGIN');
    expect(sqls.at(-1)).toBe('COMMIT');
    expect(sqls.filter(s => s.includes('harness_scenario_results')).length).toBe(2);
    // pass_count computed from scenarios (1 of 2).
    const runParams = clientQueryMock.mock.calls.find(c => c[0].includes('INSERT INTO harness_runs'))![1];
    expect(runParams[10]).toBe(1); // pass_count
    expect(runParams[9]).toBe(2); // scenario_count
    expect(releaseMock).toHaveBeenCalled();
  });

  it('rolls back and rethrows when a scenario insert fails', async () => {
    clientQueryMock.mockImplementation(async (sql: string) => {
      if (sql.includes('INSERT INTO harness_runs')) return { rows: [{ id: 7 }] };
      if (sql.includes('harness_scenario_results')) throw new Error('boom');
      return { rows: [] };
    });
    await expect(insertHarnessRun({
      startedAt: 's', finishedAt: 'f', suite: 'smoke', seed: 1, variations: 1,
      scenarios: [SCENARIO],
    })).rejects.toThrow('boom');
    expect(clientQueryMock.mock.calls.map(c => c[0])).toContain('ROLLBACK');
    expect(releaseMock).toHaveBeenCalled();
  });
});

describe('listHarnessRuns / getHarnessRun', () => {
  it('lists newest-first with a clamped limit', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] });
    await listHarnessRuns(9999);
    const [sql, params] = queryMock.mock.calls[0];
    expect(sql).toContain('ORDER BY started_at DESC');
    expect(params).toEqual([200]);
  });

  it('returns null for an unknown run id', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] });
    expect(await getHarnessRun(123)).toBeNull();
  });

  it('returns the run with its ordered scenario rows', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{ id: 7, suite: 'voice' }] })
      .mockResolvedValueOnce({ rows: [{ id: 1, run_id: 7, scenario_id: 'a' }] });
    const out = await getHarnessRun(7);
    expect(out?.run.id).toBe(7);
    expect(out?.results).toHaveLength(1);
    expect(queryMock.mock.calls[1][0]).toContain('ORDER BY scenario_id, variation');
  });
});
