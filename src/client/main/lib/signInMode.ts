// Which sign-in flow the login page runs (ai-therapist-387). The server says
// which providers are configured; this decides, once per page load, what the
// page shows and whether it leaves for a provider straight away.
//
//   cognito: the study's Cognito hosted page takes the password. The login
//            page only hands the browser over (or shows why sign-in failed).
//   squawk:  the login page's own form, completing a Squawk ceremony.
//   legacy:  the login page's own form, against /api/auth/login.
//
// Cognito wins when both are configured: it is the one a deployment is moving
// to, and its hosted page never needs this page's form.
export type SignInMode = 'cognito' | 'squawk' | 'legacy';

export interface SignInPlan {
  mode: SignInMode;
  /** Leave the page for this URL now, or null to stay and render. */
  redirect: string | null;
}

export const COGNITO_START = '/api/auth/cognito/start';
export const SQUAWK_START = '/api/auth/squawk/start';

export function planSignIn(input: {
  cognitoEnabled: boolean;
  squawkEnabled: boolean;
  /** Squawk's parked request id, present once Squawk has sent the browser back. */
  loginChallenge: string | null;
  /** ?error= from a provider callback. Never auto-redirect past it: the person
   *  needs to see why sign-in failed, and redirecting would loop. */
  callbackError: string | null;
  /** ?enrol=totp: the callback is holding a staff sign-in until an
   *  authenticator app is set up. Stay on the page for that. */
  enrolling?: boolean;
}): SignInPlan {
  if (input.cognitoEnabled) {
    return { mode: 'cognito', redirect: input.callbackError || input.enrolling ? null : COGNITO_START };
  }
  if (input.squawkEnabled) {
    return { mode: 'squawk', redirect: !input.loginChallenge && !input.callbackError ? SQUAWK_START : null };
  }
  return { mode: 'legacy', redirect: null };
}

/** Where the browser goes after the app session is ended: the provider's own
 *  sign-out when the server names one (same-origin paths and https URLs only),
 *  otherwise the login page. */
export function afterLogout(body: unknown): string {
  const redirect = (body as { redirect?: unknown } | null)?.redirect;
  if (typeof redirect === 'string' && (/^https:\/\/[^/]/.test(redirect) || /^\/(?!\/)/.test(redirect))) {
    return redirect;
  }
  return '/login';
}
