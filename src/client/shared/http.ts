// Shared JSON request helpers: the "send JSON with the session cookie, parse
// {error} from the body or fall back to `Request failed (status)`" pattern that
// handlers across the admin SPA each re-implemented.
//
// Error contract: a non-2xx response throws an HttpError whose message is the
// server's {error} string, else the caller's `fallback`, else
// `Request failed (<status>)`. The status and parsed body ride along so a
// caller can branch on 404/409 or read `{details}` without a second parse.
// Network failures propagate as whatever fetch threw (a TypeError), never an
// HttpError. There is no 401/403 special-casing: components set their own
// error state or toast, exactly as they did with raw fetch.

export type JsonMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export interface RequestJsonOptions {
  method?: JsonMethod;
  /** JSON-encoded when provided; `undefined` sends no body at all. */
  body?: unknown;
  headers?: Record<string, string>;
  /** Message to throw when the error body carries no `{error}` string. */
  fallback?: string;
}

export class HttpError extends Error {
  readonly status: number;
  /** The parsed JSON error body, or null when there was none. */
  readonly body: Record<string, unknown> | null;

  constructor(message: string, status: number, body: Record<string, unknown> | null) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.body = body;
  }
}

function parseJson(text: string): unknown {
  return text ? JSON.parse(text) : undefined;
}

export async function requestJson<T = unknown>(url: string, opts: RequestJsonOptions = {}): Promise<T> {
  const hasBody = opts.body !== undefined;
  const res = await fetch(url, {
    method: opts.method ?? 'GET',
    credentials: 'include',
    headers: { ...(hasBody ? { 'Content-Type': 'application/json' } : {}), ...opts.headers },
    ...(hasBody ? { body: JSON.stringify(opts.body) } : {}),
  });
  const text = await res.text();
  if (!res.ok) {
    let data: Record<string, unknown> | null = null;
    try {
      const parsed = parseJson(text);
      if (parsed && typeof parsed === 'object') data = parsed as Record<string, unknown>;
    } catch {
      data = null;
    }
    const serverMessage = typeof data?.error === 'string' && data.error ? data.error : null;
    throw new HttpError(serverMessage || opts.fallback || `Request failed (${res.status})`, res.status, data);
  }
  // An empty 2xx (204, or a route that ends the response bare) resolves to
  // undefined instead of throwing a JSON parse error.
  return parseJson(text) as T;
}

export function getJson<T = unknown>(url: string, opts?: Pick<RequestJsonOptions, 'fallback' | 'headers'>): Promise<T> {
  return requestJson<T>(url, { ...opts, method: 'GET' });
}

/** POST (or PUT/PATCH) a JSON body; `body` defaults to `{}` so the request is always JSON. */
export function postJson<T = unknown>(
  url: string,
  body?: object,
  opts?: { method?: 'POST' | 'PUT' | 'PATCH' } & Pick<RequestJsonOptions, 'fallback' | 'headers'>,
): Promise<T> {
  return requestJson<T>(url, { ...opts, method: opts?.method ?? 'POST', body: body ?? {} });
}

/** DELETE; sends a JSON body only when one is given. */
export function deleteJson<T = unknown>(
  url: string,
  body?: object,
  opts?: Pick<RequestJsonOptions, 'fallback' | 'headers'>,
): Promise<T> {
  return requestJson<T>(url, { ...opts, method: 'DELETE', body });
}
