import { describe, it, expect, beforeEach, vi } from 'vitest';

const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn() }));
vi.mock('../config/db.js', () => ({
  pool: { query: queryMock, connect: vi.fn(), on: vi.fn() },
}));

import { getRedactionStatusBreakdown } from './adminSessions.queries.js';

beforeEach(() => {
  queryMock.mockReset();
});

describe('getRedactionStatusBreakdown', () => {
  it('labels a session with nothing to redact as no_content', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ total: '0', redacted: '0' }] });
    const result = await getRedactionStatusBreakdown('s1');
    expect(result).toEqual({ total: 0, redacted: 0, pending: 0, status: 'no_content' });
  });

  it('labels a session with everything redacted as complete', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ total: '5', redacted: '5' }] });
    const result = await getRedactionStatusBreakdown('s1');
    expect(result).toEqual({ total: 5, redacted: 5, pending: 0, status: 'complete' });
  });

  it('labels a session with nothing redacted yet as pending', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ total: '3', redacted: '0' }] });
    const result = await getRedactionStatusBreakdown('s1');
    expect(result).toEqual({ total: 3, redacted: 0, pending: 3, status: 'pending' });
  });

  it('labels a session with some but not all redacted as partial — the gap case', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ total: '4', redacted: '2' }] });
    const result = await getRedactionStatusBreakdown('s1');
    expect(result).toEqual({ total: 4, redacted: 2, pending: 2, status: 'partial' });
  });
});
