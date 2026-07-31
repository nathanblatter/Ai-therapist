import { describe, it, expect, vi, beforeEach } from 'vitest';

const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn() }));
vi.mock('../config/db.js', () => ({
  pool: { query: queryMock, connect: vi.fn(), on: vi.fn() },
}));

import { upsertSessionFeedback, isValidRating, getFeedbackAggregate } from './feedback.queries.js';

beforeEach(() => {
  queryMock.mockReset();
});

describe('isValidRating', () => {
  it('accepts integers 1-5', () => {
    for (let i = 1; i <= 5; i++) expect(isValidRating(i)).toBe(true);
  });
  it('accepts null/undefined (optional question)', () => {
    expect(isValidRating(null)).toBe(true);
    expect(isValidRating(undefined)).toBe(true);
  });
  it('rejects out-of-range, non-integer, and non-numeric values', () => {
    expect(isValidRating(0)).toBe(false);
    expect(isValidRating(6)).toBe(false);
    expect(isValidRating(3.5)).toBe(false);
    expect(isValidRating('3')).toBe(false);
  });
});

describe('upsertSessionFeedback', () => {
  it('rejects an out-of-range rating before hitting the db', async () => {
    await expect(
      upsertSessionFeedback('sess-1', { helpfulness_rating: 9 })
    ).rejects.toThrow(/helpfulness_rating/);
    expect(queryMock).not.toHaveBeenCalled();
  });

  it('trims and length-caps free-text comments', async () => {
    queryMock.mockResolvedValueOnce({
      rows: [{ feedback_id: 1, session_id: 'sess-1', helpfulness_rating: 4, ease_rating: null, would_return_rating: null, comments: 'a'.repeat(2000), created_at: new Date() }],
    });
    await upsertSessionFeedback('sess-1', { helpfulness_rating: 4, comments: `  ${'a'.repeat(2500)}  ` });
    const params = queryMock.mock.calls[0][1] as unknown[];
    expect((params[4] as string).length).toBe(2000);
  });

  it('stores null for blank/whitespace-only comments', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{}] });
    await upsertSessionFeedback('sess-1', { comments: '   ' });
    const params = queryMock.mock.calls[0][1] as unknown[];
    expect(params[4]).toBeNull();
  });
});

describe('getFeedbackAggregate', () => {
  it('rounds averages to one decimal and parses counts', async () => {
    queryMock.mockResolvedValueOnce({
      rows: [{ responses: '10', avg_helpfulness: '4.333', avg_ease: '3.666', avg_would_return: null }],
    });
    const agg = await getFeedbackAggregate();
    expect(agg).toEqual({ responses: 10, avg_helpfulness: 4.3, avg_ease: 3.7, avg_would_return: null });
  });
});
