// Account audit trail (migration 132, ai-therapist-411): who changed which
// account, and how. Access-control changes must be auditable, the same reason
// caseload_audit_log exists; before this they were log lines only.
import { pool } from '../config/db.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('accountAudit');

export type AccountAuditAction =
  | 'account_created'
  | 'account_deleted'
  | 'role_changed'
  | 'password_changed'
  | 'username_changed'
  | 'email_changed'
  | 'authenticator_reset';

export interface AccountAuditInput {
  action: AccountAuditAction;
  targetUserId: number | null;
  targetUsername: string | null;
  organizationId?: number | null;
  /** null for a change nobody signed in made (an invite sign-up is its own actor). */
  actorUserId: number | null;
  actorUsername: string | null;
  /** What changed, never a secret: no password, token or email address. */
  detail?: Record<string, unknown>;
}

let warnedMissingTable = false;

/**
 * Append one account audit row. Never throws: an audit failure must not undo
 * or fail the change it records (which has already happened), but it is
 * logged at error level. A database that has not had migration 132 applied
 * says so once, at warn level, instead of on every account change.
 */
export async function insertAccountAudit(input: AccountAuditInput): Promise<void> {
  try {
    await pool.query(
      `INSERT INTO account_audit_log
         (action, target_user_id, target_username, organization_id, actor_user_id, actor_username, detail)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        input.action,
        input.targetUserId,
        input.targetUsername,
        input.organizationId ?? null,
        input.actorUserId,
        input.actorUsername,
        input.detail === undefined ? null : JSON.stringify(input.detail),
      ],
    );
  } catch (err) {
    if ((err as { code?: string } | null)?.code === '42P01') {
      if (!warnedMissingTable) {
        warnedMissingTable = true;
        log.warn('account_audit_log does not exist (migration 132 not applied): account changes are not being audited');
      }
      return;
    }
    log.error({ err, action: input.action, target: input.targetUserId }, 'failed to record an account audit row');
  }
}

/** Test seam: forget that the missing-table warning was given. */
export function _resetAccountAuditWarning(): void {
  warnedMissingTable = false;
}

export interface AccountAuditRow {
  audit_id: number;
  action: AccountAuditAction;
  target_user_id: number | null;
  target_username: string | null;
  organization_id: number | null;
  actor_user_id: number | null;
  actor_username: string | null;
  detail: unknown;
  created_at: Date;
}

/** The newest audit rows of one organisation (researcher review), or null
 *  when this database has no audit table yet (migration 132 not applied): the
 *  caller says so instead of showing an error or an empty trail. */
export async function listAccountAudit(organizationId: number, limit = 200): Promise<AccountAuditRow[] | null> {
  try {
    const result = await pool.query<AccountAuditRow>(
      `SELECT audit_id, action, target_user_id, target_username, organization_id,
              actor_user_id, actor_username, detail, created_at
         FROM account_audit_log
        WHERE organization_id = $1
        ORDER BY created_at DESC, audit_id DESC
        LIMIT $2`,
      [organizationId, Math.max(1, Math.min(1000, Math.floor(limit)))],
    );
    return result.rows;
  } catch (err) {
    if ((err as { code?: string } | null)?.code === '42P01') return null;
    throw err;
  }
}
