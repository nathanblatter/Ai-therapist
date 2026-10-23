// Server-side password policy, enforced at every password-setting entry point
// (register, admin user create/update, study join, invite join). Login is
// deliberately NOT policy-checked so pre-policy accounts can still sign in.
export const MIN_PASSWORD_LENGTH = 12;

// Upper bound only guards against absurd inputs reaching bcrypt / Squawk
// (bcrypt ignores everything past 72 bytes anyway); it is a cap, not a second
// policy. Squawk's own rules still apply on the account it creates.
export const MAX_PASSWORD_LENGTH = 256;

export const PASSWORD_POLICY_MESSAGE = `Password must be at least ${MIN_PASSWORD_LENGTH} characters`;
export const PASSWORD_TOO_LONG_MESSAGE = `Password must be at most ${MAX_PASSWORD_LENGTH} characters`;

/** Returns a user-facing error string when the password fails policy, else null. */
export function passwordPolicyError(password: unknown): string | null {
  if (typeof password !== 'string' || password.length < MIN_PASSWORD_LENGTH) {
    return PASSWORD_POLICY_MESSAGE;
  }
  if (password.length > MAX_PASSWORD_LENGTH) {
    return PASSWORD_TOO_LONG_MESSAGE;
  }
  return null;
}
