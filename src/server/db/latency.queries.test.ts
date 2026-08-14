import { describe, it, expect, vi, beforeEach } from 'vitest';

const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn() }));
vi.mock('../config/db.js', () => ({
  pool: { query: queryMock, connect: vi.fn(), on: vi.fn() },
}));

import { insertTurnLatency, getLatencyStats, getSessionLatency } from './latency.queries.js';

beforeEach(() => {
  queryMock.mockReset();
});

describe('insertTurnLatency', () => {
  it('computes ttfa_ms and total_ms from the timestamps', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] });
    const userDoneAt = new Date('2026-08-13T12:00:00.000Z');
    const firstOutputAt = new Date('2026-08-13T12:00:01.250Z');
    const responseDoneAt = new Date('2026-08-13T12:00:04.000Z');

    await insertTurnLatency({
      sessionId: 'sess-1', turnIndex: 3, userDoneAt, firstOutputAt, responseDoneAt, channel: 'realtime',
    });

    expect(queryMock).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO turn_latency'),
      ['sess-1', 3, userDoneAt, firstOutputAt, responseDoneAt, 1250, 4000, 'realtime']
    );
  });

  it('stores a null ttfa_ms when no first output was observed', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] });
    const userDoneAt = new Date('2026-08-13T12:00:00.000Z');
    const responseDoneAt = new Date('2026-08-13T12:00:02.000Z');

    await insertTurnLatency({
      sessionId: 'sess-1', userDoneAt, firstOutputAt: null, responseDoneAt, channel: 'realtime',
    });

    const params = queryMock.mock.calls[0][1] as unknown[];
    expect(params[5]).toBeNull(); // ttfa_ms
    expect(params[6]).toBe(2000); // total_ms
  });

  it('clamps negative deltas to zero (transcription can land after output starts)', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] });
    const userDoneAt = new Date('2026-08-13T12:00:05.000Z');

    await insertTurnLatency({
      sessionId: 'sess-1',
      userDoneAt,
      firstOutputAt: new Date('2026-08-13T12:00:04.000Z'),
      responseDoneAt: new Date('2026-08-13T12:00:04.500Z'),
      channel: 'realtime',
    });

    const params = queryMock.mock.calls[0][1] as unknown[];
    expect(params[5]).toBe(0);
    expect(params[6]).toBe(0);
  });

  it('never throws when the insert fails (fire-and-forget)', async () => {
    queryMock.mockRejectedValueOnce(new Error('db down'));
    await expect(insertTurnLatency({
      sessionId: 'sess-1',
      userDoneAt: new Date(),
      firstOutputAt: new Date(),
      responseDoneAt: new Date(),
      channel: 'chat',
    })).resolves.toBeUndefined();
  });
});

describe('getLatencyStats', () => {
  it('returns per-channel p50/p95 rows with turns parsed to numbers', async () => {
    queryMock.mockResolvedValueOnce({
      rows: [
        { channel: 'chat', turns: '12', p50_ttfa_ms: 2100, p95_ttfa_ms: 5000, p50_total_ms: 2100, p95_total_ms: 5000 },
        { channel: 'realtime', turns: '40', p50_ttfa_ms: 800, p95_ttfa_ms: 1900, p50_total_ms: 6200, p95_total_ms: 14000 },
      ],
    });

    const stats = await getLatencyStats(7);

    expect(queryMock).toHaveBeenCalledWith(expect.stringContaining('FROM turn_latency'), [7]);
    expect(stats).toHaveLength(2);
    expect(stats[1]).toEqual({
      channel: 'realtime', turns: 40,
      p50_ttfa_ms: 800, p95_ttfa_ms: 1900, p50_total_ms: 6200, p95_total_ms: 14000,
    });
  });
});

describe('getSessionLatency', () => {
  it('returns the measured turns for one session in order', async () => {
    queryMock.mockResolvedValueOnce({
      rows: [
        { turn_index: 1, user_done_at: new Date(), ttfa_ms: 900, total_ms: 4200, channel: 'realtime' },
        { turn_index: 2, user_done_at: new Date(), ttfa_ms: 750, total_ms: 3100, channel: 'realtime' },
      ],
    });

    const rows = await getSessionLatency('sess-1');

    expect(queryMock).toHaveBeenCalledWith(expect.stringContaining('ORDER BY created_at ASC'), ['sess-1']);
    expect(rows.map(r => r.turn_index)).toEqual([1, 2]);
  });
});
