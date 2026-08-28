// Shared role and data-tier vocabulary (caseworker portal foundation,
// docs/caseworker-portal.md section 3). Server and client both import from
// here so the role catalog cannot drift between the two.
//
// Tiers: 'full' = message-level/transcript content; 'summary' = AI summaries,
// risk/crisis signals, screeners/mood, engagement metadata, safety plans,
// check-ins — never verbatim therapy-session content; 'none' = no admin data
// access. Row scoping (caseload / org) is applied on top of the tier.

/** Every account role. Adds 'caseworker' and fixes the latent missing-'demo'
 *  bug in the old src/server/types.ts UserRole union. */
export type UserRole = 'therapist' | 'researcher' | 'participant' | 'demo' | 'caseworker';

/** Roles that can appear on a care team (therapist_clients.member_role). */
export type CareTeamRole = 'therapist' | 'caseworker';

/** Admin data tier a role is entitled to (before row scoping). */
export type DataTier = 'full' | 'summary' | 'none';

export const USER_ROLES: readonly UserRole[] = [
  'therapist',
  'researcher',
  'participant',
  'demo',
  'caseworker',
] as const;

export const CARE_TEAM_ROLES: readonly CareTeamRole[] = ['therapist', 'caseworker'] as const;

/** Is this role a caseload-row-scoped care-team role? */
export function isCareTeamRole(role: string | undefined | null): role is CareTeamRole {
  return role === 'therapist' || role === 'caseworker';
}

/**
 * The admin data tier for a role. Therapists and researchers see full content
 * (researchers see the redacted column post-session, unchanged); caseworkers
 * see summaries and signals only; everyone else has no admin tier.
 */
export function dataTierFor(role: string | undefined | null): DataTier {
  if (role === 'therapist' || role === 'researcher') return 'full';
  if (role === 'caseworker') return 'summary';
  return 'none';
}

/** One care-team edge as read from therapist_clients (see getCareTeam). */
export interface CareTeamMember {
  member_id: number;
  username: string;
  member_role: CareTeamRole;
  assigned_at: string;
}
