import { describe, it, expect, beforeEach, vi } from 'vitest';

const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn() }));
vi.mock('../config/db.js', () => ({
  pool: { query: queryMock, connect: vi.fn(), on: vi.fn() },
}));

const redactSessionMock = vi.fn().mockResolvedValue(undefined);
vi.mock('./sessionRedaction.service.js', () => ({
  redactSession: redactSessionMock,
}));

import { findEndedSessionsWithRedactionGaps, sweepRedactionGaps } from './contentWipe.service.js';

beforeEach(() => {
  queryMock.mockReset();
  redactSessionMock.mockClear();
});

describe('findEndedSessionsWithRedactionGaps', () => {
  it('queries for ended sessions with a not-yet-redacted user/assistant message', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ session_id: 'abc' }] });

    const ids = await findEndedSessionsWithRedactionGaps();

    expect(ids).toEqual(['abc']);
    const [sql] = queryMock.mock.calls[0];
    expect(sql).toContain("ts.status = 'ended'");
    expect(sql).toContain('m.content IS NOT NULL');
    expect(sql).toContain('m.content_redacted IS NULL');
    expect(sql).toContain("role IN ('user', 'assistant')");
  });

  it('returns an empty array when nothing is pending', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] });
    const ids = await findEndedSessionsWithRedactionGaps();
    expect(ids).toEqual([]);
  });
});

describe('sweepRedactionGaps', () => {
  it('does nothing (and never calls redactSession) when there are no gaps', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] });

    const result = await sweepRedactionGaps();

    expect(result).toEqual({ sweptSessions: 0 });
    expect(redactSessionMock).not.toHaveBeenCalled();
  });

  it('re-runs redactSession for every ended session with a gap', async () => {
    queryMock.mockResolvedValueOnce({
      rows: [{ session_id: 'session-a' }, { session_id: 'session-b' }],
    });

    const result = await sweepRedactionGaps();

    expect(result).toEqual({ sweptSessions: 2 });
    expect(redactSessionMock).toHaveBeenCalledTimes(2);
    expect(redactSessionMock).toHaveBeenCalledWith('session-a');
    expect(redactSessionMock).toHaveBeenCalledWith('session-b');
  });

  it('keeps sweeping the remaining sessions even if one redactSession call rejects', async () => {
    queryMock.mockResolvedValueOnce({
      rows: [{ session_id: 'fails' }, { session_id: 'ok' }],
    });
    redactSessionMock.mockRejectedValueOnce(new Error('boom')).mockResolvedValueOnce(undefined);

    const result = await sweepRedactionGaps();

    expect(result).toEqual({ sweptSessions: 2 });
    expect(redactSessionMock).toHaveBeenCalledTimes(2);
  });
});
