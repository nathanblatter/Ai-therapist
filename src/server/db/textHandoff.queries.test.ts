import { describe, it, expect, vi, beforeEach } from 'vitest';

const { poolQueryMock, clientQueryMock, releaseMock } = vi.hoisted(() => ({
  poolQueryMock: vi.fn(),
  clientQueryMock: vi.fn(),
  releaseMock: vi.fn(),
}));
vi.mock('../config/db.js', () => ({
  pool: {
    query: poolQueryMock,
    on: vi.fn(),
    connect: vi.fn(async () => ({ query: clientQueryMock, release: releaseMock })),
  },
}));

import {
  getHandoffRecord,
  getPredecessorSessionId,
  getSessionAssessedPeak,
  markTextHandoffContinuation,
} from './textHandoff.queries.js';

beforeEach(() => {
  poolQueryMock.mockReset();
  releaseMock.mockReset();
  clientQueryMock.mockReset().mockImplementation(async (sql: string) => {
    if (/INSERT INTO crisis_events/.test(sql)) return { rows: [{ event_id: 1 }], rowCount: 1 };
    return { rows: [], rowCount: 1 };
  });
});

describe('markTextHandoffContinuation (ai-therapist-356)', () => {
  const calls = () => clientQueryMock.mock.calls.map((c) => [String(c[0]), c[1] as unknown[]] as const);

  it("flags the chat session at the incident's real severity and score", async () => {
    await markTextHandoffContinuation('chat_1', {
      severity: 'high',
      riskScore: 85,
      continuedFrom: 'live_A',
      reason: 'content',
    });
    expect(calls()[0][0]).toBe('BEGIN');
    const update = calls().find(([sql]) => /UPDATE therapy_sessions/.test(sql))!;
    expect(update[1]).toEqual(['chat_1', 'high', 85]);
    expect(update[0]).toMatch(/crisis_flagged = TRUE/);
    expect(update[0]).toMatch(/crisis_flagged_by = 'system'/);
    expect(calls().at(-1)![0]).toBe('COMMIT');
    expect(releaseMock).toHaveBeenCalled();
  });

  it('marks the flag as a continuation stamp, so the paging policy never reads it as a disclosure', async () => {
    await markTextHandoffContinuation('chat_1', {
      severity: 'high',
      riskScore: 85,
      continuedFrom: 'live_A',
      reason: 'content',
    });
    const insert = calls().find(([sql]) => /INSERT INTO crisis_events/.test(sql))!;
    const values = insert[1];
    // The factor db/paging.queries excludes (getParticipantFlagEvents) and
    // looks for (highFlagIsContinuationStampOnly).
    const factors = values.find((v) => typeof v === 'string' && v.includes('recovery_continuation'));
    expect(JSON.parse(factors as string)).toEqual(['recovery_continuation', 'text_handoff']);
    // trigger_method is CHECK-constrained to auto|manual|system|ai_tool.
    expect(values).toContain('system');
    expect(values).toContain('flagged');
    expect(
      values.some((v) => typeof v === 'string' && v.includes('live_A') && v.includes('not a new disclosure')),
    ).toBe(true);
  });

  it('a medium incident is stamped medium; an unknown score is stored empty', async () => {
    await markTextHandoffContinuation('chat_2', {
      severity: 'medium',
      riskScore: null,
      continuedFrom: 'live_B',
      reason: 'expired',
    });
    const update = calls().find(([sql]) => /UPDATE therapy_sessions/.test(sql))!;
    expect(update[1]).toEqual(['chat_2', 'medium', null]);
    const insert = calls().find(([sql]) => /INSERT INTO crisis_events/.test(sql))!;
    expect(insert[1]).toContain('medium');
    expect(insert[1].some((v) => typeof v === 'string' && v.includes('session time limit'))).toBe(true);
  });

  it('rolls back and throws when the event cannot be written', async () => {
    clientQueryMock.mockImplementation(async (sql: string) => {
      if (/INSERT INTO crisis_events/.test(sql)) throw new Error('check violation');
      return { rows: [], rowCount: 1 };
    });
    await expect(
      markTextHandoffContinuation('chat_3', { severity: 'high', riskScore: 80, continuedFrom: 'x', reason: 'content' }),
    ).rejects.toThrow('check violation');
    expect(clientQueryMock.mock.calls.map((c) => String(c[0]))).toContain('ROLLBACK');
    expect(releaseMock).toHaveBeenCalled();
  });
});

describe('hand-off link reads', () => {
  it('getPredecessorSessionId follows either kind of link, newest first', async () => {
    poolQueryMock.mockResolvedValue({ rows: [{ from_session: 'live_A' }] });
    expect(await getPredecessorSessionId('chat_1')).toBe('live_A');
    const [sql, params] = poolQueryMock.mock.calls[0] as [string, unknown[]];
    expect(sql).toMatch(/ORDER BY performed_at DESC/);
    expect(params).toEqual(['chat_1', ['voice_cut_text_handoff', 'voice_resumed_from_text']]);
    poolQueryMock.mockResolvedValue({ rows: [] });
    expect(await getPredecessorSessionId('live_A')).toBeNull();
  });

  it('getHandoffRecord reads the stored decision, from an object or a JSON string', async () => {
    const details = {
      event: 'voice_cut_text_handoff',
      kind: 'crisis',
      severity: 'high',
      reason: 'content',
      from: 'live_A',
    };
    poolQueryMock.mockResolvedValue({ rows: [{ details }] });
    expect(await getHandoffRecord('chat_1')).toEqual({
      kind: 'crisis',
      severity: 'high',
      reason: 'content',
      from: 'live_A',
    });
    poolQueryMock.mockResolvedValue({ rows: [{ details: JSON.stringify(details) }] });
    expect((await getHandoffRecord('chat_1'))?.kind).toBe('crisis');
    poolQueryMock.mockResolvedValue({ rows: [] });
    expect(await getHandoffRecord('chat_plain')).toBeNull();
    poolQueryMock.mockResolvedValue({ rows: [{ details: '{not json' }] });
    expect(await getHandoffRecord('chat_bad')).toBeNull();
  });

  it('getSessionAssessedPeak reads the stored bands, not a threshold', async () => {
    poolQueryMock.mockResolvedValue({ rows: [{ has_high: true, has_medium: true }] });
    expect(await getSessionAssessedPeak('c')).toBe('high');
    poolQueryMock.mockResolvedValue({ rows: [{ has_high: false, has_medium: true }] });
    expect(await getSessionAssessedPeak('c')).toBe('medium');
    poolQueryMock.mockResolvedValue({ rows: [{ has_high: false, has_medium: false }] });
    expect(await getSessionAssessedPeak('c')).toBe('none');
    expect(String(poolQueryMock.mock.calls[0][0])).not.toMatch(/\b(65|75)\b/);
  });
});
