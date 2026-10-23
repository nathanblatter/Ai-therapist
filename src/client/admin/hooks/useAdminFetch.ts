import { useState, useEffect, useCallback } from 'react';
import { getJson, HttpError } from '../../shared/http';
import { recordAdminApiError } from '../utils/adminUsageTelemetry';

// Shared JSON GET hook for admin API endpoints (ai-therapist-120): every admin
// view was hand-rolling the same fetch/loading/error triple. Refetches when
// the URL changes; `refetch` re-runs the same request on demand.
//
// The error string is always `Request failed (<status>)` for an HTTP failure
// (never the server's {error} text): callers such as ParticipantProfile match
// on the status in that string to detect a 403.
export default function useAdminFetch<T>(url: string) {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refetch = useCallback(() => {
    setLoading(true);
    setError(null);
    getJson<T>(url)
      .then(setData)
      .catch((err: unknown) => {
        if (err instanceof HttpError) {
          // De-identified usage telemetry: templated path + status only.
          recordAdminApiError(url, err.status);
          setError(`Request failed (${err.status})`);
          return;
        }
        setError(err instanceof Error ? err.message : 'Unknown error');
      })
      .finally(() => setLoading(false));
  }, [url]);

  useEffect(() => {
    refetch();
  }, [refetch]);

  return { data, loading, error, refetch };
}
