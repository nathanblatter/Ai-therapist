// The notice an account's open pages get when a researcher changes the role
// of, or deletes, the account while it is signed in (accounts.service
// endSessions). An authenticator reset sends none. The server
// ends the account's app sessions and closes its sockets; this is what it says
// first, so the page can explain itself instead of going dead.

/** Socket event sent to the account's user:<id> room just before its sockets close. */
export const ACCOUNT_SIGNED_OUT_EVENT = 'account:signed-out';

/** Recorded as therapy_sessions.ended_by, and the `reason` of the session:status
 *  event, for a therapy session ended because its account changed. */
export const ACCOUNT_CHANGED_END_REASON = 'account_changed';

export type AccountSignedOutReason = 'role_changed' | 'account_deleted';

const MESSAGES: Record<AccountSignedOutReason, string> = {
  role_changed:
    'The study team changed your account, so you have been signed out. If you were in a session, it has ended. Please sign in again to continue.',
  account_deleted:
    'The study team removed this account, so you have been signed out. If you were in a session, it has ended.',
};

const FALLBACK = 'Your account was changed by the study team, so you have been signed out. Please sign in again.';

/** Plain words for the person whose account changed. An unknown reason (an
 *  older or newer server) gets the general wording. */
export function accountSignedOutMessage(reason: unknown): string {
  return typeof reason === 'string' && Object.hasOwn(MESSAGES, reason)
    ? MESSAGES[reason as AccountSignedOutReason]
    : FALLBACK;
}

/** Whether signing in again can work for this reason (not for a deleted account). */
export function canSignInAgain(reason: unknown): boolean {
  return reason !== 'account_deleted';
}
