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

// Check if user can view redacted data
export function canViewRedactedData(role: string): boolean {
  return role === 'therapist' || role === 'researcher';
}

// Check if user can access admin features
export function canAccessAdmin(role: string): boolean {
  return role === 'therapist' || role === 'researcher';
}

// Check if user can view unredacted data
export function canViewUnredactedData(role: string): boolean {
  return role === 'therapist';
}
