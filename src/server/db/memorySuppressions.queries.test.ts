import { describe, it, expect, beforeEach, vi } from 'vitest';

const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn() }));
vi.mock('../config/db.js', () => ({ pool: { query: queryMock } }));

const { getLastSessionSafetySignal, getUserMemorySuppressions, insertMemorySuppression, excludeSummariesFromMemory } =
  await import('./memorySuppressions.queries.js');

const missingTable = Object.assign(new Error('relation "memory_suppressions" does not exist'), { code: '42P01' });

beforeEach(() => {
  queryMock.mockReset();
});

// ai-therapist-341: migrations are applied by hand, so the code must behave
// before migration 128 exists.
describe('memory_suppressions before the migration is applied', () => {
  it('reads as "no suppressions" so memory keeps working', async () => {
    queryMock.mockRejectedValue(missingTable);
    await expect(getUserMemorySuppressions(42)).resolves.toEqual([]);
  });

  it('reports the write as failed so the assistant makes no promise', async () => {
    queryMock.mockRejectedValue(missingTable);
    await expect(insertMemorySuppression(42, 's1', 'a thing', 'tool')).resolves.toBe(false);
  });

  it('any other read error is not swallowed', async () => {
    queryMock.mockRejectedValue(new Error('connection refused'));
    await expect(getUserMemorySuppressions(42)).rejects.toThrow('connection refused');
  });
});

describe('insertMemorySuppression', () => {
  it('stores a trimmed, bounded topic against the user and session', async () => {
    queryMock.mockResolvedValue({ rows: [] });
    await expect(insertMemorySuppression(42, 's1', `  ${'x'.repeat(500)}  `, 'summary')).resolves.toBe(true);
    const [sql, params] = queryMock.mock.calls[0];
    expect(sql).toContain('INSERT INTO memory_suppressions');
    expect(params[0]).toBe(42);
    expect(params[1]).toBe('s1');
    expect((params[2] as string).length).toBe(200);
    expect(params[3]).toBe('summary');
  });
});

describe('excludeSummariesFromMemory', () => {
  it('only sets the marker: the stored summary text is not rewritten', async () => {
    queryMock.mockResolvedValue({ rows: [] });
    await excludeSummariesFromMemory(42, ['s0']);
    const [sql, params] = queryMock.mock.calls[0];
    expect(sql).toMatch(/jsonb_set\(summary::jsonb, '\{memory_excluded\}', 'true'::jsonb\)/);
    expect(sql).toContain('WHERE user_id = $1 AND session_id = ANY($2::text[])');
    expect(params).toEqual([42, ['s0']]);
  });

  it('does nothing for an empty list', async () => {
    await excludeSummariesFromMemory(42, []);
    expect(queryMock).not.toHaveBeenCalled();
  });
});

// ai-therapist-344
describe('getLastSessionSafetySignal', () => {
  const at = new Date('2026-11-16T00:00:00Z');
  const row = (over: Record<string, unknown> = {}) => ({
    session_id: 'prev',
    crisis_severity: 'high',
    crisis_flagged_at: at,
    crisis_unflagged_at: null,
    at,
    recent: true,
    ...over,
  });

  it('reads the session row only: the newest OTHER session the participant spoke in, no content', async () => {
    queryMock.mockResolvedValue({ rows: [row()] });
    const signal = await getLastSessionSafetySignal(42, 'current', 30);
    expect(signal).toEqual({ session_id: 'prev', severity: 'high', at });
    const [sql, params] = queryMock.mock.calls[0];
    expect(params).toEqual([42, 'current', 30]);
    expect(sql).toContain('FROM therapy_sessions ts');
    expect(sql).toContain('ts.session_id <> $2');
    expect(sql).toContain("m.role = 'user'");
    expect(sql).toContain('ORDER BY ts.created_at DESC');
    expect(sql).toContain('LIMIT 1');
    // No conversation content, summary or insight is selected.
    expect(sql).not.toMatch(/session_insights|summary|m\.content|soap/i);
  });

  it('is null when there is no earlier conversation', async () => {
    queryMock.mockResolvedValue({ rows: [] });
    await expect(getLastSessionSafetySignal(42, null, 30)).resolves.toBeNull();
  });

  it('is null when the last conversation was not flagged', async () => {
    queryMock.mockResolvedValue({ rows: [row({ crisis_flagged_at: null, crisis_severity: null })] });
    await expect(getLastSessionSafetySignal(42, null, 30)).resolves.toBeNull();
  });

  it('is null outside the window', async () => {
    queryMock.mockResolvedValue({ rows: [row({ recent: false })] });
    await expect(getLastSessionSafetySignal(42, null, 30)).resolves.toBeNull();
  });

  it('respects a staff unflag made after the flag, and ignores one made before a re-flag', async () => {
    queryMock.mockResolvedValue({ rows: [row({ crisis_unflagged_at: new Date('2026-11-17T00:00:00Z') })] });
    await expect(getLastSessionSafetySignal(42, null, 30)).resolves.toBeNull();
    queryMock.mockResolvedValue({ rows: [row({ crisis_unflagged_at: new Date('2026-11-15T00:00:00Z') })] });
    await expect(getLastSessionSafetySignal(42, null, 30)).resolves.not.toBeNull();
  });
});
