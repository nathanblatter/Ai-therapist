// How a row of the account audit trail (GET /api/users/audit, migration 132)
// reads to a researcher. Pure, so the wording is tested without a browser.

export interface AccountAuditRow {
  audit_id: number;
  action: string;
  target_user_id: number | null;
  target_username: string | null;
  actor_user_id: number | null;
  actor_username: string | null;
  detail: unknown;
  created_at: string;
}

const LABELS: Record<string, string> = {
  account_created: 'Account created',
  account_deleted: 'Account deleted',
  role_changed: 'Role changed',
  password_changed: 'Password changed',
  username_changed: 'Username changed',
  email_changed: 'Email changed',
  authenticator_reset: 'Authenticator app reset',
};

export function auditActionLabel(action: string): string {
  return LABELS[action] ?? action;
}

function text(v: unknown): string | null {
  return typeof v === 'string' && v ? v : null;
}

/** The "what changed" cell. The trail never holds a password or an address,
 *  so there is none to hide here; unknown shapes show nothing. */
export function auditDetailText(row: Pick<AccountAuditRow, 'action' | 'detail'>): string {
  const d = (row.detail && typeof row.detail === 'object' ? row.detail : {}) as Record<string, unknown>;
  switch (row.action) {
    case 'role_changed':
    case 'username_changed': {
      const from = text(d.from);
      const to = text(d.to);
      return from && to ? `${from} to ${to}` : '';
    }
    case 'account_created': {
      const role = text(d.role);
      const via = d.via === 'register' ? 'register route' : d.via === 'user_management' ? 'User Management' : null;
      return [role, via ? `via ${via}` : null].filter(Boolean).join(', ');
    }
    case 'account_deleted': {
      const role = text(d.role);
      const kept =
        d.signInServiceRemoved === false ? 'its sign-in could not be removed from the sign-in service' : null;
      return [role, kept].filter(Boolean).join('; ');
    }
    case 'password_changed':
      return d.self === true ? 'by the account holder' : '';
    case 'email_changed':
      return d.provisioned === true ? 'study address provisioned' : d.set === true ? 'address set' : 'address cleared';
    case 'authenticator_reset':
      return text(d.role) ?? '';
    default:
      return '';
  }
}

/** Who made the change, for the "By" cell. */
export function auditActorText(row: Pick<AccountAuditRow, 'actor_username' | 'actor_user_id'>): string {
  return row.actor_username ?? (row.actor_user_id !== null ? `user ${row.actor_user_id}` : 'unknown');
}
