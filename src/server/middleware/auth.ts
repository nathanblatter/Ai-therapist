// Authentication middleware and utilities
import bcrypt from 'bcrypt';
import type { Request, Response, NextFunction } from 'express';
import { pool } from '../config/db.js';
import type { UserRow } from '../db/index.js';

const SALT_ROUNDS = 10;

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

export interface VerifiedUser {
  userid: number;
  username: string;
  role: string;
  mfa_enabled: boolean;
  mfa_secret: string | null;
  mfa_backup_codes: string[] | null;
}

// Verify user credentials
export async function verifyCredentials(username: string, password: string): Promise<VerifiedUser | null> {
  try {
    const result = await pool.query<UserRow & { password: string }>(
      'SELECT userid, username, password, role, mfa_enabled, mfa_secret, mfa_backup_codes FROM users WHERE username = $1',
      [username]
    );

    if (result.rows.length === 0) {
      return null; // User not found
    }

    const user = result.rows[0];
    const passwordMatch = await bcrypt.compare(password, user.password);

    if (!passwordMatch) {
      return null; // Invalid password
    }

    // Return user data without password
    return {
      userid: user.userid,
      username: user.username,
      role: user.role,
      mfa_enabled: user.mfa_enabled ?? false,
      mfa_secret: user.mfa_secret ?? null,
      mfa_backup_codes: user.mfa_backup_codes ?? null
    };
  } catch (error) {
    console.error('Error verifying credentials:', error);
    throw error;
  }
}

// Create new user (for registration)
export async function createUser(username: string, password: string, role: string): Promise<UserRow> {
  try {
    const hashedPassword = await bcrypt.hash(password, SALT_ROUNDS);

    const result = await pool.query<UserRow>(
      'INSERT INTO users (username, password, role) VALUES ($1, $2, $3) RETURNING userid, username, role',
      [username, hashedPassword, role]
    );

    return result.rows[0];
  } catch (error: unknown) {
    const pgErr = error as { code?: string };
    if (pgErr.code === '23505') { // Unique constraint violation
      throw new Error('Username already exists');
    }
    console.error('Error creating user:', error);
    throw error;
  }
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

// Get all users (for admin user management)
export async function getAllUsers(): Promise<UserRow[]> {
  try {
    const result = await pool.query<UserRow>(
      'SELECT userid, username, role, preferred_voice, preferred_language, mfa_enabled, mfa_enabled_at, created_at, updated_at FROM users ORDER BY created_at DESC'
    );
    return result.rows;
  } catch (error) {
    console.error('Error fetching users:', error);
    throw error;
  }
}

// Get user by ID
export async function getUserById(userid: number | string): Promise<UserRow | null> {
  try {
    const result = await pool.query<UserRow>(
      'SELECT userid, username, role, preferred_voice, preferred_language, created_at, updated_at FROM users WHERE userid = $1 ORDER BY userid asc',
      [userid]
    );

    if (result.rows.length === 0) {
      return null;
    }

    return result.rows[0];
  } catch (error) {
    console.error('Error fetching user:', error);
    throw error;
  }
}

// Update user (username, role, or password)
export async function updateUser(userid: number | string, updates: Record<string, string>): Promise<UserRow> {
  try {
    const allowedFields = ['username', 'role', 'password'];
    const updateFields: string[] = [];
    const values: unknown[] = [];
    let paramIndex = 1;

    for (const [key, value] of Object.entries(updates)) {
      if (allowedFields.includes(key) && value !== undefined) {
        if (key === 'password') {
          // Hash password if it's being updated
          const hashedPassword = await bcrypt.hash(value, SALT_ROUNDS);
          updateFields.push(`password = $${paramIndex}`);
          values.push(hashedPassword);
        } else {
          updateFields.push(`${key} = $${paramIndex}`);
          values.push(value);
        }
        paramIndex++;
      }
    }

    if (updateFields.length === 0) {
      throw new Error('No valid fields to update');
    }

    // Add updated_at timestamp
    updateFields.push(`updated_at = CURRENT_TIMESTAMP`);

    // Add userid as the last parameter
    values.push(userid);

    const query = `
      UPDATE users
      SET ${updateFields.join(', ')}
      WHERE userid = $${paramIndex}
      RETURNING userid, username, role, created_at, updated_at
    `;

    const result = await pool.query<UserRow>(query, values);

    if (result.rows.length === 0) {
      throw new Error('User not found');
    }

    return result.rows[0];
  } catch (error: unknown) {
    const pgErr = error as { code?: string };
    if (pgErr.code === '23505') { // Unique constraint violation
      throw new Error('Username already exists');
    }
    console.error('Error updating user:', error);
    throw error;
  }
}

// Delete user
export async function deleteUser(userid: number | string): Promise<UserRow> {
  try {
    const result = await pool.query<UserRow>(
      'DELETE FROM users WHERE userid = $1 RETURNING userid, username',
      [userid]
    );

    if (result.rows.length === 0) {
      throw new Error('User not found');
    }

    return result.rows[0];
  } catch (error) {
    console.error('Error deleting user:', error);
    throw error;
  }
}
