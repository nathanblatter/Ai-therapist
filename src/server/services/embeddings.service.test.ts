// Embeddings client (ai-therapist-236 test backfill): batch chunking, order
// preservation via the API's index field, retry on retryable statuses with
// Retry-After, and strict shape validation. fetch is mocked.
import { describe, it, expect, vi, beforeEach } from 'vitest';

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);
vi.mock('../config/secrets.js', () => ({ getOpenAIKey: async () => 'test-key' }));

import { embedText, embedTextBatch, EMBEDDING_MODEL } from './embeddings.service.js';

function ok(body: unknown): Response {
  return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body), headers: new Headers() } as unknown as Response;
}
function status(code: number, retryAfter?: string): Response {
  const headers = new Headers(retryAfter ? { 'retry-after': retryAfter } : {});
  return { ok: false, status: code, json: async () => ({}), text: async () => `status ${code}`, headers } as unknown as Response;
}

beforeEach(() => {
  fetchMock.mockReset();
  vi.useRealTimers();
});

describe('embedText', () => {
  it('posts the model and input and returns the vector', async () => {
    fetchMock.mockResolvedValueOnce(ok({ data: [{ index: 0, embedding: [0.1, 0.2] }] }));
    expect(await embedText('hello')).toEqual([0.1, 0.2]);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.openai.com/v1/embeddings');
    expect(JSON.parse(init.body)).toEqual({ model: EMBEDDING_MODEL, input: 'hello' });
    expect(init.headers.Authorization).toBe('Bearer test-key');
  });

  it('throws on a non-retryable error and on an empty embedding', async () => {
    fetchMock.mockResolvedValueOnce(status(400));
    await expect(embedText('x')).rejects.toThrow('Embeddings API error: 400');
    fetchMock.mockResolvedValueOnce(ok({ data: [{ embedding: [] }] }));
    await expect(embedText('x')).rejects.toThrow('no embedding');
  });

  it('retries a 429 honouring Retry-After, then succeeds', async () => {
    vi.useFakeTimers();
    fetchMock
      .mockResolvedValueOnce(status(429, '1'))
      .mockResolvedValueOnce(ok({ data: [{ index: 0, embedding: [1] }] }));
    const p = embedText('x');
    await vi.advanceTimersByTimeAsync(1000);
    expect(await p).toEqual([1]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('gives up after three retryable failures', async () => {
    vi.useFakeTimers();
    fetchMock.mockResolvedValue(status(503));
    const p = embedText('x').catch(e => e);
    await vi.advanceTimersByTimeAsync(10_000);
    const err = await p;
    expect(String(err)).toContain('503');
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});

describe('embedTextBatch', () => {
  it('chunks inputs by 100 and restores order from the index field', async () => {
    const texts = Array.from({ length: 150 }, (_, i) => `t${i}`);
    fetchMock.mockImplementation(async (_url: string, init: { body: string }) => {
      const input = JSON.parse(init.body).input as string[];
      // Return items in reverse order to prove index-based ordering.
      const data = input.map((_, i) => ({ index: i, embedding: [Number(input[i].slice(1))] })).reverse();
      return ok({ data });
    });
    const out = await embedTextBatch(texts);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(out).toHaveLength(150);
    expect(out[0]).toEqual([0]);
    expect(out[149]).toEqual([149]);
  });

  it('throws when a chunk comes back short or malformed', async () => {
    fetchMock.mockResolvedValueOnce(ok({ data: [{ index: 0, embedding: [1] }] }));
    await expect(embedTextBatch(['a', 'b'])).rejects.toThrow('returned 1 embeddings for 2 inputs');
    fetchMock.mockResolvedValueOnce(ok({ data: [{ index: 0, embedding: [1] }, { embedding: [2] }] }));
    await expect(embedTextBatch(['a', 'b'])).rejects.toThrow('malformed');
  });

  it('returns an empty array for no inputs without calling the API', async () => {
    expect(await embedTextBatch([])).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
