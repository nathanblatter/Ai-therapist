import { useState, useEffect, useCallback } from 'react';

// Shared JSON GET hook for admin API endpoints (ai-therapist-120): every admin
// view was hand-rolling the same fetch/loading/error triple. Refetches when
// the URL changes; `refetch` re-runs the same request on demand.
export default function useAdminFetch<T>(url: string) {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refetch = useCallback(() => {
    setLoading(true);
    setError(null);
    fetch(url, { credentials: 'include' })
      .then(r => {
        if (!r.ok) throw new Error(`Request failed (${r.status})`);
        return r.json() as Promise<T>;
      })
      .then(setData)
      .catch((err: unknown) => setError(err instanceof Error ? err.message : 'Unknown error'))
      .finally(() => setLoading(false));
  }, [url]);

  useEffect(() => {
    refetch();
  }, [refetch]);

  return { data, loading, error, refetch };
}
