import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HttpError, deleteJson, getJson, postJson, requestJson } from './http';

const fetchMock = vi.fn();

// A Response body can be read once, so every fetch call gets a fresh one.
function reply(status: number, body?: unknown): () => Promise<Response> {
  const text = body === undefined ? '' : typeof body === 'string' ? body : JSON.stringify(body);
  // undici forbids a body on 204, so the empty case is modelled as `new Response(null)`.
  return () => Promise.resolve(new Response(text || null, { status, headers: { 'Content-Type': 'application/json' } }));
}

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('requestJson', () => {
  it('sends the session cookie and parses the JSON body', async () => {
    fetchMock.mockImplementation(reply(200, { ok: true }));
    await expect(getJson<{ ok: boolean }>('/x')).resolves.toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledWith('/x', {
      method: 'GET',
      credentials: 'include',
      headers: {},
    });
  });

  it('throws an HttpError carrying the server {error} message and the status', async () => {
    fetchMock.mockImplementation(reply(409, { error: 'already running' }));
    const err = await getJson('/x').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpError).message).toBe('already running');
    expect((err as HttpError).status).toBe(409);
    expect((err as HttpError).body).toEqual({ error: 'already running' });
  });

  it('prefers the server message, then the caller fallback, then the generic text', async () => {
    fetchMock.mockImplementationOnce(reply(400, { error: 'bad value' }));
    await expect(getJson('/x', { fallback: 'Failed to load' })).rejects.toThrow('bad value');

    fetchMock.mockImplementationOnce(reply(500, { details: 'stack' }));
    await expect(getJson('/x', { fallback: 'Failed to load' })).rejects.toThrow('Failed to load');

    fetchMock.mockImplementationOnce(reply(503, 'not json'));
    const err = (await getJson('/x').catch((e: unknown) => e)) as HttpError;
    expect(err.message).toBe('Request failed (503)');
    expect(err.body).toBeNull();
  });

  it('does not special-case 401/403: they throw like any other status', async () => {
    fetchMock.mockImplementation(reply(403, { error: 'Forbidden' }));
    const err = (await getJson('/x').catch((e: unknown) => e)) as HttpError;
    expect(err.status).toBe(403);
    expect(err.message).toBe('Forbidden');
  });

  it('resolves undefined for an empty 2xx body', async () => {
    fetchMock.mockImplementation(reply(204));
    await expect(deleteJson('/x')).resolves.toBeUndefined();
  });

  it('lets network failures propagate untouched', async () => {
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));
    const err = await getJson('/x').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TypeError);
    expect(err).not.toBeInstanceOf(HttpError);
  });

  it('only sets Content-Type when a body is sent', async () => {
    fetchMock.mockImplementation(reply(200, {}));
    await requestJson('/x', { method: 'POST' });
    expect(fetchMock.mock.calls[0][1]).toEqual({ method: 'POST', credentials: 'include', headers: {} });

    await requestJson('/x', { method: 'PATCH', body: { a: 1 }, headers: { 'X-Extra': 'y' } });
    expect(fetchMock.mock.calls[1][1]).toEqual({
      method: 'PATCH',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json', 'X-Extra': 'y' },
      body: '{"a":1}',
    });
  });
});

describe('postJson', () => {
  it('defaults to POST with an empty JSON object body', async () => {
    fetchMock.mockImplementation(reply(200, { id: 1 }));
    await expect(postJson('/x')).resolves.toEqual({ id: 1 });
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ method: 'POST', body: '{}' });
  });

  it('honours the PUT/PATCH override', async () => {
    fetchMock.mockImplementation(reply(200, {}));
    await postJson('/x', { v: 2 }, { method: 'PUT' });
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ method: 'PUT', body: '{"v":2}' });
  });
});

describe('deleteJson', () => {
  it('sends a JSON body only when given one', async () => {
    fetchMock.mockImplementation(reply(200, {}));
    await deleteJson('/x');
    expect(fetchMock.mock.calls[0][1]).not.toHaveProperty('body');
    await deleteJson('/x', { notes: 'why' });
    expect(fetchMock.mock.calls[1][1]).toMatchObject({ method: 'DELETE', body: '{"notes":"why"}' });
  });
});
