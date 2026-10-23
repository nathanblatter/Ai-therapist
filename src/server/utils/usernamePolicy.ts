// Server-side username rules for the public self-registration routes
// (/join, /join-sandbox, /join-study; ai-therapist-154). Mirrors the inline
// registration pages' minlength=3 / maxlength=64 and pins a charset so a
// username can never carry whitespace, control characters or markup. The
// charset deliberately admits email-shaped usernames (notification.service
// derives care-team addresses from them) and the dot/underscore/hyphen/plus
// handles already in use.
export const MIN_USERNAME_LENGTH = 3;
export const MAX_USERNAME_LENGTH = 64;
export const USERNAME_PATTERN = /^[A-Za-z0-9._@+-]+$/;
/** The same charset as an HTML `pattern` attribute (implicitly anchored). */
export const USERNAME_HTML_PATTERN = '[A-Za-z0-9._@+-]+';

/** Returns a user-facing error string when the username fails policy, else null. */
export function usernamePolicyError(username: unknown): string | null {
  if (typeof username !== 'string') return 'Username is required';
  const trimmed = username.trim();
  if (trimmed.length < MIN_USERNAME_LENGTH) {
    return `Username must be at least ${MIN_USERNAME_LENGTH} characters`;
  }
  if (trimmed.length > MAX_USERNAME_LENGTH) {
    return `Username must be at most ${MAX_USERNAME_LENGTH} characters`;
  }
  if (!USERNAME_PATTERN.test(trimmed)) {
    return 'Username may only contain letters, numbers, and . _ - @ +';
  }
  return null;
}
