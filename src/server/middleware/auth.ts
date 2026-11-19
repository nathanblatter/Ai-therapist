// Authentication middleware and role helpers. User persistence/auth queries
// (verifyCredentials, createUser, getAllUsers, getUserById, updateUser,
// deleteUser) live in db/users.queries.ts.
import type { Request, Response, NextFunction } from 'express';

// Authentication middleware - protects routes
export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  if (!req.session?.userId) {
    res.status(401).json({ error: 'Authentication required' });
    return;
  }
  next();
}

// Role-based authorization middleware
export function requireRole(...allowedRoles: string[]) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!req.session?.userId) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }

    if (!allowedRoles.includes(req.session.userRole ?? '')) {
      res.status(403).json({ error: 'Insufficient permissions' });
      return;
    }

    next();
  };
}

/**
 * A signed-out browser loading a staff page goes to the sign-in page instead
 * of reading `{"error":"Authentication required"}`. Only a top-level page load
 * qualifies: a GET (or HEAD) whose Accept header prefers HTML over JSON, which
 * is what a browser sends when someone taps a link (a crisis page SMS opens
 * /admin#session=... or /admin#participant=...). fetch/XHR (Accept `*` or
 * JSON), curl and every API route keep the 401 JSON from requireRole.
 *
 * The redirect carries no fragment, so the browser keeps the link's own hash
 * on /login (RFC 9110 section 10.2.2); the sign-in page stores it and the
 * admin page restores it after sign-in (src/client/admin/utils/pendingDeepLink.ts).
 * Signed-in requests pass straight through: a wrong role still gets
 * requireRole's 403 JSON, never a redirect, so there is no loop.
 */
export function signedOutPageToLogin(req: Request, res: Response, next: NextFunction): void {
  if (
    !req.session?.userId &&
    (req.method === 'GET' || req.method === 'HEAD') &&
    req.accepts(['json', 'html']) === 'html'
  ) {
    res.set('Cache-Control', 'no-store');
    res.redirect(302, '/login');
    return;
  }
  next();
}

/** Roles that load the admin SPA (demo accounts see synthetic data; demo.routes.ts). */
export const ADMIN_PAGE_ROLES = ['therapist', 'caseworker', 'researcher', 'demo'] as const;

/** Guard for GET /admin (prod and dev): signed-out page loads go to /login,
 *  everything else is requireRole as before. */
export const adminPageGuard = [signedOutPageToLogin, requireRole(...ADMIN_PAGE_ROLES)];

/**
 * Full-content tier gate (caseworker portal, docs/caseworker-portal.md
 * section 2): every transcript/message/recording route is allowlisted to the
 * full-tier roles. Behaviorally identical to the previous inline
 * requireRole('therapist', 'researcher') calls — this named export documents
 * intent and keeps caseworkers structurally excluded from verbatim content.
 */
export const requireFullContent = requireRole('therapist', 'researcher');

// Check if user can view redacted data
export function canViewRedactedData(role: string): boolean {
  return role === 'therapist' || role === 'researcher';
}

// Check if user can access admin features
// (caseworkers get the admin SPA at the summaries tier; content access is
// gated per-route by requireRole / requireFullContent.)
export function canAccessAdmin(role: string): boolean {
  return role === 'therapist' || role === 'researcher' || role === 'caseworker';
}

// Check if user can view unredacted data
export function canViewUnredactedData(role: string): boolean {
  return role === 'therapist';
}
