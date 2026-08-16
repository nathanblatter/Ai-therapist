// Shared identity of the simulation-eval (red-team) participant account
// (ai-therapist-124). Sessions owned by this account are study artifacts, not
// participant data: they are marked is_demo so every real analytics/export
// surface excludes them (same wall as demo accounts, see demoIsolation tests),
// and IRB adverse-event auto-drafts skip them.
export const HARNESS_USERNAME = 'redteam_participant';

/** Sessions created by demo viewers OR the harness participant are non-study
 *  data and must be excluded from research surfaces. */
export function isNonStudyUser(role?: string | null, username?: string | null): boolean {
  return role === 'demo' || username === HARNESS_USERNAME;
}
