import { describe, it, expect, vi, beforeEach } from 'vitest';

const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn() }));
vi.mock('../config/db.js', () => ({
  pool: { query: queryMock, connect: vi.fn(), on: vi.fn() },
}));

import {
  getStudyOpsSummary,
  createDeviation,
  updateDeviation,
  deleteDeviation,
  scanForDeviations,
} from './studyOps.queries.js';

const PROTOCOL = {
  enrollment_target: 40,
  expected_sessions_per_participant: 4,
  study_start: null,
  study_end: null,
  arm_imbalance_threshold: 0.15,
};

function routeBy(handlers: { match: RegExp; rows: unknown[] }[]) {
  queryMock.mockImplementation((sqlArg: unknown) => {
    const sql = typeof sqlArg === 'string' ? sqlArg : '';
    if (sql.includes('FROM system_config WHERE config_key')) {
      return Promise.resolve({ rows: [{ config_key: 'study_protocol', config_value: PROTOCOL }] });
    }
    for (const h of handlers) if (h.match.test(sql)) return Promise.resolve({ rows: h.rows });
    return Promise.resolve({ rows: [] });
  });
}

beforeEach(() => queryMock.mockReset());

describe('getStudyOpsSummary', () => {
  it('returns zeroed, NaN-free shapes on an empty DB', async () => {
    routeBy([]);
    const s = await getStudyOpsSummary();
    expect(s.enrollment.enrolled_participants).toBe(0);
    expect(s.arm_balance.imbalance).toBeNull();
    expect(s.arm_balance.over_threshold).toBe(false);
    expect(s.sessions_per_participant.histogram).toEqual([]);
    expect(s.deviations.open).toBe(0);
  });

  it('computes arm imbalance and flags over-threshold', async () => {
    routeBy([
      { match: /proactive_offering IS TRUE/, rows: [{ arm_true: '8', arm_false: '2', arm_null: '1' }] },
      { match: /enrolled_participants/, rows: [{ enrolled_participants: '10', anonymous_sessions: '3' }] },
    ]);
    const s = await getStudyOpsSummary();
    expect(s.arm_balance.imbalance).toBeCloseTo(0.6, 5);
    expect(s.arm_balance.over_threshold).toBe(true);
    expect(s.enrollment.enrolled_participants).toBe(10);
  });

  it('handles the all-NULL arm case without dividing by zero', async () => {
    routeBy([
      { match: /proactive_offering IS TRUE/, rows: [{ arm_true: '0', arm_false: '0', arm_null: '5' }] },
    ]);
    const s = await getStudyOpsSummary();
    expect(s.arm_balance.imbalance).toBeNull();
    expect(s.arm_balance.over_threshold).toBe(false);
  });

  it('buckets sessions-per-participant against expectation', async () => {
    routeBy([
      { match: /GROUP BY n_sessions/, rows: [
        { n_sessions: '2', n_participants: '3' }, // below (expected 4)
        { n_sessions: '4', n_participants: '5' }, // at
        { n_sessions: '7', n_participants: '1' }, // above
      ] },
    ]);
    const s = await getStudyOpsSummary();
    expect(s.sessions_per_participant.below_expected).toBe(3);
    expect(s.sessions_per_participant.at_expected).toBe(5);
    expect(s.sessions_per_participant.above_expected).toBe(1);
  });
});

describe('deviation CRUD', () => {
  it('createDeviation inserts a manual row', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ deviation_id: 1, source: 'manual', category: 'procedure' }] });
    const row = await createDeviation({ category: 'procedure', description: 'x', created_by: 'alice' });
    expect(row.deviation_id).toBe(1);
    const [sql, params] = queryMock.mock.calls[0];
    expect(sql).toContain('INSERT INTO protocol_deviations');
    expect(params).toContain('alice');
  });

  it('updateDeviation stamps resolved_by/at when moving to resolved', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ deviation_id: 1, status: 'resolved', resolved_by: 'bob' }] });
    await updateDeviation(1, { status: 'resolved' }, 'bob');
    const sql = String(queryMock.mock.calls[0][0]);
    expect(sql).toContain('resolved_by =');
    expect(sql).toContain('resolved_at = CURRENT_TIMESTAMP');
  });

  it('deleteDeviation refuses auto rows (WHERE source = manual) and reports no-op', async () => {
    queryMock.mockResolvedValueOnce({ rowCount: 0 });
    const ok = await deleteDeviation(99);
    expect(ok).toBe(false);
    expect(String(queryMock.mock.calls[0][0])).toContain("source = 'manual'");
  });

  it('deleteDeviation returns true when a manual row is removed', async () => {
    queryMock.mockResolvedValueOnce({ rowCount: 1 });
    expect(await deleteDeviation(5)).toBe(true);
  });
});

describe('scanForDeviations', () => {
  it('every anomaly insert is idempotent (ON CONFLICT auto_key DO NOTHING) and inserted count sums rowCounts', async () => {
    // study_start null => rule 1b skipped; 4 inserts run.
    let inserts = 0;
    queryMock.mockImplementation((sqlArg: unknown) => {
      const sql = typeof sqlArg === 'string' ? sqlArg : '';
      if (sql.includes('FROM system_config WHERE config_key')) {
        return Promise.resolve({ rows: [{ config_value: PROTOCOL }] });
      }
      if (sql.includes('INSERT INTO protocol_deviations')) {
        expect(sql).toContain('ON CONFLICT (auto_key) DO NOTHING');
        inserts++;
        return Promise.resolve({ rowCount: 1 });
      }
      return Promise.resolve({ rows: [] });
    });
    const { inserted } = await scanForDeviations();
    expect(inserts).toBe(4);
    expect(inserted).toBe(4);
  });

  it('a re-scan over unchanged data inserts nothing (conflict path)', async () => {
    queryMock.mockImplementation((sqlArg: unknown) => {
      const sql = typeof sqlArg === 'string' ? sqlArg : '';
      if (sql.includes('FROM system_config WHERE config_key')) {
        return Promise.resolve({ rows: [{ config_value: PROTOCOL }] });
      }
      if (sql.includes('INSERT INTO protocol_deviations')) return Promise.resolve({ rowCount: 0 });
      return Promise.resolve({ rows: [] });
    });
    const { inserted } = await scanForDeviations();
    expect(inserted).toBe(0);
  });

  it('runs the system_config-row rule only when a study window start is set', async () => {
    const withWindow = { ...PROTOCOL, study_start: '2026-01-01T00:00:00Z' };
    let inserts = 0;
    queryMock.mockImplementation((sqlArg: unknown) => {
      const sql = typeof sqlArg === 'string' ? sqlArg : '';
      if (sql.includes('FROM system_config WHERE config_key')) {
        return Promise.resolve({ rows: [{ config_value: withWindow }] });
      }
      if (sql.includes('INSERT INTO protocol_deviations')) { inserts++; return Promise.resolve({ rowCount: 0 }); }
      return Promise.resolve({ rows: [] });
    });
    await scanForDeviations();
    expect(inserts).toBe(5); // 1a, 1b, 2, 3, 4
  });
});
