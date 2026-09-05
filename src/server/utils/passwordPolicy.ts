// Server-side password policy, enforced at every password-setting entry point
// (register, admin user create/update, study join, invite join). Login is
// deliberately NOT policy-checked so pre-policy accounts can still sign in.
export const MIN_PASSWORD_LENGTH = 12;

export const PASSWORD_POLICY_MESSAGE = `Password must be at least ${MIN_PASSWORD_LENGTH} characters`;

/** Returns a user-facing error string when the password fails policy, else null. */
export function passwordPolicyError(password: unknown): string | null {
  if (typeof password !== 'string' || password.length < MIN_PASSWORD_LENGTH) {
    return PASSWORD_POLICY_MESSAGE;
  }
  return null;
}
