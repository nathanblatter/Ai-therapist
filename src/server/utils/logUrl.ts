// Request-log hygiene: some URLs carry a value that is a credential while it
// lives. The Cognito callback's `code` can be exchanged for tokens (by a party
// that also holds the PKCE verifier) and `state` names the sign-in attempt;
// neither belongs in a log line. Join links carry their token in the path.

const SECRET_QUERY_PATHS = ['/api/auth/cognito/callback', '/api/auth/squawk/callback'];

/** The URL as it may be logged: query dropped where it carries sign-in codes. */
export function loggableUrl(url: string | undefined): string | undefined {
  if (!url) return url;
  const q = url.indexOf('?');
  if (q === -1) return url;
  const path = url.slice(0, q);
  return SECRET_QUERY_PATHS.includes(path) ? `${path}?[redacted]` : url;
}
