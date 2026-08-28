// Data-access for client invite links (ai-therapist-119, caseload RBAC).
// A therapist mints a one-time link; a new client registers through it and is
// auto-assigned to that therapist. Only the sha256 hex of the raw token is
// ever stored — the raw token exists solely in the create response / link.
import { randomBytes } from 'crypto';
import { pool } from '../config/db.js';
import { hashToken } from '../utils/crypto.js';

export interface ClientInviteRow {
  invite_id: number;
  token_hash: string;
  therapist_id: number;
  organization_id: number | null;
  label: string | null;
  created_at: string;
  expires_at: string;
  used_at: string | null;
  used_by: number | null;
}

const INVITE_COLUMNS =
  'invite_id, token_hash, therapist_id, organization_id, label, created_at, expires_at, used_at, used_by';

/**
 * Mint a new invite for a care-team member (therapist or caseworker; the
 * therapist_id column historically holds either). Returns the raw token
 * (32 random bytes, base64url — shown exactly once) alongside the stored row,
 * which holds only the sha256 hex of the token. The invite inherits the
 * inviter's organization (069: client_invites.organization_id NOT NULL).
 */
export async function createInvite(
  therapistId: number,
  label: string | null,
  ttlHours: number = 168
): Promise<{ rawToken: string; invite: ClientInviteRow }> {
  const rawToken = randomBytes(32).toString('base64url');
  const result = await pool.query<ClientInviteRow>(
    `INSERT INTO client_invites (token_hash, therapist_id, organization_id, label, expires_at)
     VALUES ($1, $2,
             (SELECT organization_id FROM users WHERE userid = $2),
             $3, now() + ($4 * INTERVAL '1 hour'))
     RETURNING ${INVITE_COLUMNS}`,
    [hashToken(rawToken), therapistId, label, ttlHours]
  );
  return { rawToken, invite: result.rows[0] };
}

/**
 * Peek at an invite by raw token without consuming it (used by GET /join/:token
 * to render the form or a 410 page). Returns the row even if used/expired so
 * the caller can distinguish "dead" from "unknown".
 */
export async function findInviteByToken(rawToken: string): Promise<ClientInviteRow | null> {
  const result = await pool.query<ClientInviteRow>(
    `SELECT ${INVITE_COLUMNS} FROM client_invites WHERE token_hash = $1`,
    [hashToken(rawToken)]
  );
  return result.rows[0] ?? null;
}

/**
 * Atomically consume a single-use, unexpired invite: the UPDATE's WHERE clause
 * guarantees exactly one caller can ever win, even under concurrent posts.
 * Returns the consumed row, or null when the token is unknown, already used,
 * or expired.
 */
export async function consumeInvite(rawToken: string): Promise<ClientInviteRow | null> {
  const result = await pool.query<ClientInviteRow>(
    `UPDATE client_invites SET used_at = now()
     WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now()
     RETURNING ${INVITE_COLUMNS}`,
    [hashToken(rawToken)]
  );
  return result.rows[0] ?? null;
}

/** Record which user account a consumed invite produced. */
export async function markInviteUsedBy(inviteId: number, userId: number): Promise<void> {
  await pool.query('UPDATE client_invites SET used_by = $1 WHERE invite_id = $2', [
    userId,
    inviteId,
  ]);
}

/**
 * Release a consumed invite (clears used_at/used_by). Used only when the
 * registration that consumed it could not complete, so the link stays valid.
 */
export async function releaseInvite(inviteId: number): Promise<void> {
  await pool.query(
    'UPDATE client_invites SET used_at = NULL, used_by = NULL WHERE invite_id = $1',
    [inviteId]
  );
}

/** A therapist's invites, newest first (admin invite panel). */
export async function listInvites(therapistId: number): Promise<ClientInviteRow[]> {
  const result = await pool.query<ClientInviteRow>(
    `SELECT ${INVITE_COLUMNS} FROM client_invites
     WHERE therapist_id = $1 ORDER BY created_at DESC`,
    [therapistId]
  );
  return result.rows;
}
