// Data-access for sandbox invites (caseworker portal, migration 077).
// A researcher mints a batch of one-time links; each consumed link creates a
// fresh kind='sandbox' org with a seeded synthetic caseload. Only the sha256
// hex of the raw token is stored (065 pattern); raw tokens appear once in the
// mint response.
import { createHash, randomBytes, randomUUID } from 'crypto';
import { pool } from '../config/db.js';

export type SandboxInviteRole = 'therapist' | 'caseworker';

export interface SandboxInviteRow {
  invite_id: number;
  token_hash: string;
  batch_id: string;
  invite_role: SandboxInviteRole;
  seed_profile: string;
  label: string | null;
  created_by: number;
  created_at: string;
  expires_at: string;
  used_at: string | null;
  used_by: number | null;
  org_id: number | null;
}

const INVITE_COLUMNS = `invite_id, token_hash, batch_id, invite_role, seed_profile, label,
       created_by, created_at::text AS created_at, expires_at::text AS expires_at,
       used_at::text AS used_at, used_by, org_id`;

function hashToken(rawToken: string): string {
  return createHash('sha256').update(rawToken).digest('hex');
}

/**
 * Mint a batch of sandbox invites (count 1..500). Returns each raw token
 * (shown exactly once) alongside its stored row.
 */
export async function createSandboxInviteBatch(input: {
  count: number;
  inviteRole: SandboxInviteRole;
  seedProfile?: string;
  label?: string | null;
  ttlHours?: number;
  createdBy: number;
}): Promise<{ batchId: string; invites: Array<{ rawToken: string; invite: SandboxInviteRow }> }> {
  const count = Math.trunc(input.count);
  if (!Number.isFinite(count) || count < 1 || count > 500) {
    throw new Error('count must be between 1 and 500');
  }
  const batchId = randomUUID();
  const ttlHours = input.ttlHours ?? 24 * 30;
  const rawTokens = Array.from({ length: count }, () => randomBytes(32).toString('base64url'));
  const result = await pool.query<SandboxInviteRow>(
    `INSERT INTO sandbox_invites
       (token_hash, batch_id, invite_role, seed_profile, label, created_by, expires_at)
     SELECT hash, $2, $3, $4, $5, $6, now() + ($7 * INTERVAL '1 hour')
     FROM unnest($1::text[]) AS hash
     RETURNING ${INVITE_COLUMNS}`,
    [
      rawTokens.map(hashToken),
      batchId,
      input.inviteRole,
      input.seedProfile ?? 'standard',
      input.label ?? null,
      input.createdBy,
      ttlHours,
    ]
  );
  // unnest preserves array order, so rows line up with rawTokens.
  const invites = result.rows.map((invite, i) => ({ rawToken: rawTokens[i], invite }));
  return { batchId, invites };
}

/** Peek at an invite by raw token without consuming it (GET /join-sandbox). */
export async function findSandboxInviteByToken(rawToken: string): Promise<SandboxInviteRow | null> {
  const result = await pool.query<SandboxInviteRow>(
    `SELECT ${INVITE_COLUMNS} FROM sandbox_invites WHERE token_hash = $1`,
    [hashToken(rawToken)]
  );
  return result.rows[0] ?? null;
}

/**
 * Atomically consume a single-use, unexpired invite (065 pattern): only one
 * caller can ever win the guarded UPDATE. Null when unknown/used/expired.
 */
export async function consumeSandboxInvite(rawToken: string): Promise<SandboxInviteRow | null> {
  const result = await pool.query<SandboxInviteRow>(
    `UPDATE sandbox_invites SET used_at = now()
     WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now()
     RETURNING ${INVITE_COLUMNS}`,
    [hashToken(rawToken)]
  );
  return result.rows[0] ?? null;
}

/** Record the account + org a consumed invite produced. */
export async function markSandboxInviteUsed(
  inviteId: number,
  userId: number,
  orgId: number
): Promise<void> {
  await pool.query(
    `UPDATE sandbox_invites SET used_by = $1, org_id = $2 WHERE invite_id = $3`,
    [userId, orgId, inviteId]
  );
}

/** Release a consumed invite after a failed signup so the link stays valid. */
export async function releaseSandboxInvite(inviteId: number): Promise<void> {
  await pool.query(
    `UPDATE sandbox_invites SET used_at = NULL, used_by = NULL, org_id = NULL WHERE invite_id = $1`,
    [inviteId]
  );
}

export interface SandboxInviteBatchRow {
  batch_id: string;
  invite_role: SandboxInviteRole;
  seed_profile: string;
  label: string | null;
  created_by: number;
  created_at: string;
  expires_at: string;
  total: number;
  used: number;
}

/** Batches with per-batch used/total counts, newest first (admin panel). */
export async function listSandboxInviteBatches(): Promise<SandboxInviteBatchRow[]> {
  const result = await pool.query<SandboxInviteBatchRow>(
    `SELECT batch_id, invite_role, seed_profile, label, created_by,
            MIN(created_at)::text AS created_at, MAX(expires_at)::text AS expires_at,
            COUNT(*)::int AS total,
            COUNT(used_at)::int AS used
     FROM sandbox_invites
     GROUP BY batch_id, invite_role, seed_profile, label, created_by
     ORDER BY MIN(created_at) DESC`
  );
  return result.rows;
}

/** The org ids a batch created (batch teardown enumeration). */
export async function listSandboxOrgIdsForBatch(batchId: string): Promise<number[]> {
  const result = await pool.query<{ org_id: number }>(
    `SELECT org_id FROM sandbox_invites WHERE batch_id = $1 AND org_id IS NOT NULL`,
    [batchId]
  );
  return result.rows.map((row) => row.org_id);
}
