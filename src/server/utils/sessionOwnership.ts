// Ownership checks for therapy sessions. Participants may be anonymous, so a
// session's creator is remembered in their express-session cookie
// (ownedSessions) at creation time; logged-in users are additionally matched
// against the session row's user_id. Admin roles bypass ownership.
import type { Request } from 'express';

// Cap the cookie list so long-lived anonymous sessions don't grow unbounded.
const MAX_OWNED = 20;

export function isAdminRole(role?: string | null): boolean {
  return role === 'therapist' || role === 'researcher';
}

/** Remember that the requester created this therapy session. */
export function recordSessionOwnership(req: Request, sessionId: string): void {
  if (!req.session) return;
  const owned = req.session.ownedSessions ?? [];
  if (owned.includes(sessionId)) return;
  req.session.ownedSessions = [...owned.slice(-(MAX_OWNED - 1)), sessionId];
}

/**
 * May this request act on the given therapy session?
 * Admins always can; owners are matched by user_id (logged in) or by the
 * ownedSessions list in their cookie (anonymous participants).
 */
export function canAccessSession(
  req: Request,
  // user_id is number | null in practice; SessionAccessInfo types it loosely.
  session: { user_id: number | string | null },
  sessionId: string
): boolean {
  if (isAdminRole(req.session?.userRole)) return true;
  if ((req.session?.ownedSessions ?? []).includes(sessionId)) return true;
  if (session.user_id != null) return session.user_id === req.session?.userId;
  return false;
}
