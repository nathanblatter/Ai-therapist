import { useEffect, useState } from 'react';
import { isCareTeamRole } from '../../../shared/roles';

// Shared viewer identity for the admin SPA. Six components used to fire their
// own GET /api/auth/status on mount; the result is cached module-wide (one
// request per page load no matter how many components mount) and exposed with
// the common role predicates (isCareTeamRole from src/shared/roles is the
// single care-team definition).

interface AuthUser {
  userid: number;
  username: string;
  role: string;
  is_sandbox?: boolean;
}

export interface AuthState {
  role: string | null;
  userId: number | null;
  username: string | null;
  /** Sandbox demo account (join-sandbox signup). */
  isSandbox: boolean;
  isCareTeam: boolean;
  isTherapist: boolean;
  isCaseworker: boolean;
  isResearcher: boolean;
  loading: boolean;
}

// undefined = not fetched yet; null = unauthenticated (or the fetch failed).
let cachedUser: AuthUser | null | undefined;
let inflight: Promise<AuthUser | null> | null = null;

function fetchAuthUser(): Promise<AuthUser | null> {
  if (cachedUser !== undefined) return Promise.resolve(cachedUser);
  if (!inflight) {
    inflight = fetch('/api/auth/status', { credentials: 'include' })
      .then(r => (r.ok ? r.json() : null))
      .then((data: { authenticated?: boolean; user?: AuthUser } | null) => {
        cachedUser = data?.authenticated && data.user ? data.user : null;
        return cachedUser;
      })
      .catch(() => {
        cachedUser = null;
        return null;
      })
      .finally(() => {
        inflight = null;
      });
  }
  return inflight;
}

export default function useAuth(): AuthState {
  const [user, setUser] = useState<AuthUser | null>(cachedUser ?? null);
  const [loading, setLoading] = useState(cachedUser === undefined);

  useEffect(() => {
    let cancelled = false;
    void fetchAuthUser().then(u => {
      if (!cancelled) {
        setUser(u);
        setLoading(false);
      }
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const role = user?.role ?? null;
  return {
    role,
    userId: user?.userid ?? null,
    username: user?.username ?? null,
    isSandbox: user?.is_sandbox === true,
    isCareTeam: isCareTeamRole(role),
    isTherapist: role === 'therapist',
    isCaseworker: role === 'caseworker',
    isResearcher: role === 'researcher',
    loading,
  };
}
