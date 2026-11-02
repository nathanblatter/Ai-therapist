// Staff email addresses on the study domain (ai-therapist-283, phase 1).
//
// Researcher, therapist and caseworker accounts may carry an email address;
// the usual one is provisioned here as <slug>@byuisresearch.com, which the
// email-api gateway can both send from and receive for (SES catch-all on the
// domain, verified 2026-11-01). Participants never get one: they are
// anonymous by design (ai-therapist-76), so the participant role is refused
// at this layer no matter who asks.
//
// The address feeds two things: the notification mailer (notification.service
// prefers users.email over the old email-shaped-username heuristic, behind the
// same recipient gate) and, in later phases, composing from and reading mail
// at that address.
import { getUserById, setUserEmail, findUserByEmail, listEmailsWithPrefix, type UserRow } from '../db/index.js';
import { createLogger } from '../utils/logger.js';
import { isEmailShaped } from '../utils/emailShape.js';

const log = createLogger('researcherEmail');

/** The study's mail domain; override for another deployment. */
export function studyEmailDomain(): string {
  const configured = (process.env.STUDY_EMAIL_DOMAIN ?? '').trim().toLowerCase();
  return configured || 'byuisresearch.com';
}

/**
 * The one definition of "this account has a study mailbox": a researcher whose
 * address is on the study domain. Compose and inbox both key on it.
 */
export function studyAddressFor(user: { role?: string; email?: string | null } | null | undefined): string | null {
  if (!user || user.role !== 'researcher') return null;
  const address = (user.email ?? '').trim().toLowerCase();
  return address.endsWith(`@${studyEmailDomain()}`) ? address : null;
}

/** Roles that may hold an address. Participants are anonymous. */
export const EMAIL_ELIGIBLE_ROLES: ReadonlySet<string> = new Set(['researcher', 'therapist', 'caseworker']);

export class EmailAccountError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = 'EmailAccountError';
  }
}

export function isValidEmailAddress(value: string): boolean {
  return isEmailShaped(value);
}

/**
 * The local part derived from a username: lower-cased, an email-shaped
 * username reduced to its local part, anything outside [a-z0-9.-] collapsed
 * to a single hyphen, any run of dots/hyphens collapsed to one hyphen (a
 * dot-atom may not contain consecutive dots), trimmed of leading/trailing
 * dots and hyphens, capped at 40 characters. Never empty.
 */
export function studyAddressSlug(username: string): string {
  const base = username.includes('@') ? username.slice(0, username.indexOf('@')) : username;
  const slug = base
    .toLowerCase()
    .replace(/[^a-z0-9.-]+/g, '-')
    .replace(/[.-]{2,}/g, '-')
    .replace(/^[.-]+|[.-]+$/g, '')
    .slice(0, 40)
    .replace(/[.-]+$/g, '');
  return slug || 'user';
}

const INELIGIBLE_MESSAGE = 'Only researcher, therapist and caseworker accounts may hold an email address';

async function loadEligible(userid: number | string): Promise<UserRow> {
  const user = await getUserById(userid);
  if (!user) throw new EmailAccountError('User not found', 404);
  if (!EMAIL_ELIGIBLE_ROLES.has(user.role)) throw new EmailAccountError(INELIGIBLE_MESSAGE, 403);
  return user;
}

/**
 * Everything setAccountEmail checks, without writing: the normalized address
 * (or null to clear). Lets a caller that also changes other fields validate
 * the email BEFORE persisting anything, so a rejected address never leaves a
 * half-applied edit behind. `roleAfter` is the role the account will have
 * once the caller's own update lands.
 */
export async function validateAccountEmail(
  userid: number | string,
  email: string | null,
  roleAfter?: string,
): Promise<{ user: UserRow; email: string | null }> {
  const user = await getUserById(userid);
  if (!user) throw new EmailAccountError('User not found', 404);
  if (email === null) return { user, email: null };
  if (!EMAIL_ELIGIBLE_ROLES.has(roleAfter ?? user.role)) throw new EmailAccountError(INELIGIBLE_MESSAGE, 403);
  const normalized = email.trim().toLowerCase();
  if (!isValidEmailAddress(normalized)) throw new EmailAccountError('Invalid email address', 400);
  const holder = await findUserByEmail(normalized);
  if (holder && holder.userid !== user.userid) throw new EmailAccountError('Email already in use', 409);
  return { user, email: normalized };
}

/** Set (or clear, with null) a staff account's address. */
export async function setAccountEmail(userid: number | string, email: string | null): Promise<UserRow> {
  const { user, email: normalized } = await validateAccountEmail(userid, email);
  try {
    return await setUserEmail(user.userid, normalized);
  } catch (err) {
    // Lost a uniqueness race after the pre-check: still an ordinary conflict.
    if (err instanceof Error && err.message === 'Email already in use') throw new EmailAccountError(err.message, 409);
    throw err;
  }
}

/** An account leaving the staff roles loses its address (anonymity invariant). */
export async function clearEmailIfIneligible(userid: number | string, role: string): Promise<void> {
  if (EMAIL_ELIGIBLE_ROLES.has(role)) return;
  await setUserEmail(userid, null);
}

/**
 * Give a staff account its study address, <slug>@<domain>, choosing the first
 * free of slug, slug-2, slug-3, ... Idempotent: an account that already holds
 * an address on the study domain keeps it.
 */
export async function provisionStudyAddress(userid: number | string): Promise<{ user: UserRow; address: string }> {
  const user = await loadEligible(userid);
  const domain = studyEmailDomain();
  const current = (user.email ?? '').toLowerCase();
  if (current.endsWith(`@${domain}`)) return { user, address: current };

  const slug = studyAddressSlug(user.username);
  // One query for every address already on this slug, then the first free
  // suffix; a lost race on the write (someone provisioned the same slug in
  // between) just re-reads and tries again.
  for (let attempt = 0; attempt < 3; attempt++) {
    const taken = new Set((await listEmailsWithPrefix(slug, domain)).map((e) => e.toLowerCase()));
    let candidate = `${slug}@${domain}`;
    for (let n = 2; taken.has(candidate); n++) candidate = `${slug}-${n}@${domain}`;
    try {
      const updated = await setUserEmail(user.userid, candidate);
      log.info({ userid: user.userid, address: candidate }, 'study email address provisioned');
      return { user: updated, address: candidate };
    } catch (err) {
      if (err instanceof Error && err.message === 'Email already in use') continue;
      throw err;
    }
  }
  throw new EmailAccountError('Could not find a free study address for this account', 409);
}
