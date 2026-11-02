import { describe, it, expect, vi, beforeEach } from 'vitest';

const { clientQueryMock, releaseMock } = vi.hoisted(() => ({ clientQueryMock: vi.fn(), releaseMock: vi.fn() }));
vi.mock('../config/db.js', () => ({
  pool: {
    query: vi.fn(),
    on: vi.fn(),
    connect: vi.fn(async () => ({ query: clientQueryMock, release: releaseMock })),
  },
}));

import { markSessionCrisisContinuation } from './crisis.queries.js';

beforeEach(() => {
  clientQueryMock.mockReset().mockImplementation(async (sql: string) => {
    if (/UPDATE therapy_sessions/.test(sql)) return { rows: [{ crisis_risk_score: 87 }], rowCount: 1 };
    if (/INSERT INTO crisis_events/.test(sql)) return { rows: [{ id: 1 }], rowCount: 1 };
    return { rows: [], rowCount: 0 };
  });
  releaseMock.mockReset();
});

describe('markSessionCrisisContinuation (ai-therapist-281 / 268)', () => {
  it('flags the recovery row high, inherits the score, and records a CHECK-safe crisis event', async () => {
    await markSessionCrisisContinuation('rec-1');
    const calls = clientQueryMock.mock.calls.map((c) => [String(c[0]), c[1]] as const);
    expect(calls[0][0]).toBe('BEGIN');
    const update = calls.find(([sql]) => /UPDATE therapy_sessions/.test(sql));
    expect(update).toBeDefined();
    expect(update![0]).toMatch(/crisis_severity = 'high'/);
    expect(update![0]).toMatch(/crisis_flagged_by = 'system'/);
    expect(update![1]).toEqual(['rec-1']);
    const insert = calls.find(([sql]) => /INSERT INTO crisis_events/.test(sql));
    expect(insert).toBeDefined();
    // trigger_method is CHECK-constrained to auto|manual|system|ai_tool (011/068):
    // the continuation rides 'system' and is identified by its risk factor.
    const cols = insert![0];
    const vals = insert![1] as unknown[];
    expect(cols).toMatch(/trigger_method/);
    expect(vals).toContain('system');
    expect(vals).not.toContain('recovery_continuation');
    expect(vals.some((v) => typeof v === 'string' && v.includes('recovery_continuation'))).toBe(true);
    expect(vals).toContain(87);
    expect(calls.at(-1)![0]).toBe('COMMIT');
    expect(releaseMock).toHaveBeenCalled();
  });

  it('rolls back when the insert fails', async () => {
    clientQueryMock.mockImplementation(async (sql: string) => {
      if (/INSERT INTO crisis_events/.test(sql)) throw new Error('check violation');
      return { rows: [{ crisis_risk_score: 50 }], rowCount: 1 };
    });
    await expect(markSessionCrisisContinuation('rec-2')).rejects.toThrow('check violation');
    expect(clientQueryMock.mock.calls.map((c) => String(c[0]))).toContain('ROLLBACK');
  });
});
