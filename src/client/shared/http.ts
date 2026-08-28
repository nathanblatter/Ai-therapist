// Shared JSON POST/PUT helper: the "parse {error} from the JSON body or fall
// back to `Request failed (status)`" pattern that action handlers across the
// admin SPA each re-implemented.

export async function postJson<T = unknown>(
  url: string,
  body?: Record<string, unknown>,
  opts?: { method?: 'POST' | 'PUT' }
): Promise<T> {
  const res = await fetch(url, {
    method: opts?.method ?? 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });
  if (!res.ok) {
    const data = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(data?.error || `Request failed (${res.status})`);
  }
  return res.json() as Promise<T>;
}
