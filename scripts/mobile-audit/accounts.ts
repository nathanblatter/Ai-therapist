// Local-only throwaway credentials for the mobile audit scripts. These accounts
// exist only in a scratch rt_* database built by seed.ts; override the shared
// password with MOBILE_AUDIT_PASS if you like.
const password = process.env.MOBILE_AUDIT_PASS || 'mobile-Audit-local-1';

export const MOBILE_AUDIT_ACCOUNTS = {
  researcher: { username: 'mobile_researcher', password },
  therapist: { username: 'mobile_therapist', password },
  /** A sandbox client with session history, re-keyed so the screenshot script can sign in as it. */
  participant: { username: 'mobile_participant', password },
  /** A brand-new participant with no consent on file (consent screen, empty home). */
  newcomer: { username: 'mobile_newcomer', password },
  /** role=demo: its whole admin API is synthetic fixtures (demo.routes.ts), e.g. a live session to monitor. */
  demo: { username: 'mobile_demo', password },
};
