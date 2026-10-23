// OpenAI org-costs client (ai-therapist-236 test backfill). Real dollars feed
// the cost dashboard, so bucket aggregation, line-item ranking, the per-window
// cache and the never-throws contract are pinned here. fetch is mocked.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

import { getCostsSummary, costsConfigured } from './openaiCosts.service.js';

function ok(body: unknown): Response {
  return { ok: true, status: 200, json: async () => body } as unknown as Response;
}

const DAY = 86_400;
const T0 = 1_760_000_000; // fixed bucket start

beforeEach(() => {
  fetchMock.mockReset();
  process.env.OPENAI_ADMIN_KEY = 'admin-test-key';
});
afterEach(() => {
  delete process.env.OPENAI_ADMIN_KEY;
});

describe('getCostsSummary', () => {
  it('returns configured:false without an admin key and never calls the API', async () => {
    delete process.env.OPENAI_ADMIN_KEY;
    expect(costsConfigured()).toBe(false);
    const s = await getCostsSummary(7);
    expect(s.configured).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('sums buckets into days and ranks line items highest first', async () => {
    fetchMock.mockResolvedValueOnce(
      ok({
        data: [
          {
            start_time: T0,
            results: [
              { amount: { value: 1.25 }, line_item: 'gpt-5, output' },
              { amount: { value: 0.5 }, line_item: 'gpt-4o-mini, input' },
              { amount: { value: 'nope' }, line_item: 'broken' },
            ],
          },
          {
            start_time: T0 + DAY,
            results: [{ amount: { value: 2 }, line_item: 'gpt-5, output' }, { amount: { value: 0.1 } }],
          },
        ],
      }),
    );
    const s = await getCostsSummary(2);
    expect(s.configured).toBe(true);
    expect(s.totalUsd).toBeCloseTo(3.85, 2);
    expect(s.days.map((d) => d.amountUsd)).toEqual([1.75, 2.1]);
    expect(s.days[0].date).toBe(new Date(T0 * 1000).toISOString().slice(0, 10));
    expect(s.byLineItem[0]).toEqual({ lineItem: 'gpt-5, output', amountUsd: 3.25 });
    expect(s.byLineItem.map((l) => l.lineItem)).toContain('unattributed');
    const url = String(fetchMock.mock.calls[0][0]);
    expect(url).toContain('bucket_width=1d');
    expect(url).toContain('group_by=line_item');
    expect(url).toContain('limit=2');
  });

  it('caches per window length so two windows do not evict each other', async () => {
    fetchMock.mockResolvedValue(ok({ data: [] }));
    await getCostsSummary(9);
    await getCostsSummary(11);
    await getCostsSummary(9);
    await getCostsSummary(11);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('returns configured:false on a non-OK status or a thrown fetch, never throws', async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 401, json: async () => ({}) } as unknown as Response);
    expect((await getCostsSummary(13)).configured).toBe(false);
    fetchMock.mockRejectedValueOnce(new Error('network'));
    expect((await getCostsSummary(17)).configured).toBe(false);
  });

  it('bounds the window to 1..180 days', async () => {
    fetchMock.mockResolvedValue(ok({ data: [] }));
    await getCostsSummary(5000);
    expect(String(fetchMock.mock.calls[0][0])).toContain('limit=180');
    await getCostsSummary(0);
    expect(String(fetchMock.mock.calls[1][0])).toContain('limit=1');
  });
});
