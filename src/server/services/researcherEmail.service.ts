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
import { getUserById, setUserEmail, findUserByEmail, type UserRow } from '../db/index.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('researcherEmail');

/** The study's mail domain; override for another deployment. */
export function studyEmailDomain(): string {
  const configured = (process.env.STUDY_EMAIL_DOMAIN ?? '').trim().toLowerCase();
  return configured || 'byuisresearch.com';
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

const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function isValidEmailAddress(value: string): boolean {
  return value.length <= 254 && EMAIL_SHAPE.test(value);
}

/**
 * The local part derived from a username: lower-cased, an email-shaped
 * username reduced to its local part, anything outside [a-z0-9.-] collapsed
 * to a single hyphen, trimmed of leading/trailing dots and hyphens, capped at
 * 40 characters. Never empty.
 */
export function studyAddressSlug(username: string): string {
  const base = username.includes('@') ? username.slice(0, username.indexOf('@')) : username;
  const slug = base
    .toLowerCase()
    .replace(/[^a-z0-9.-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[.-]+|[.-]+$/g, '')
    .slice(0, 40)
    .replace(/[.-]+$/g, '');
  return slug || 'user';
}

async function loadEligible(userid: number | string): Promise<UserRow> {
  const user = await getUserById(userid);
  if (!user) throw new EmailAccountError('User not found', 404);
  if (!EMAIL_ELIGIBLE_ROLES.has(user.role)) {
    throw new EmailAccountError('Participants are anonymous and cannot have an email address', 403);
  }
  return user;
}

/** Set (or clear, with null) a staff account's address. */
export async function setAccountEmail(userid: number | string, email: string | null): Promise<UserRow> {
  const user = await loadEligible(userid);
  if (email === null) return setUserEmail(user.userid, null);
  const normalized = email.trim().toLowerCase();
  if (!isValidEmailAddress(normalized)) throw new EmailAccountError('Invalid email address', 400);
  const holder = await findUserByEmail(normalized);
  if (holder && holder.userid !== user.userid) throw new EmailAccountError('Email already in use', 409);
  return setUserEmail(user.userid, normalized);
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
  for (let n = 1; n <= 20; n++) {
    const candidate = `${n === 1 ? slug : `${slug}-${n}`}@${domain}`;
    const holder = await findUserByEmail(candidate);
    if (holder && holder.userid !== user.userid) continue;
    try {
      const updated = await setUserEmail(user.userid, candidate);
      log.info({ userid: user.userid, address: candidate }, 'study email address provisioned');
      return { user: updated, address: candidate };
    } catch (err) {
      // Lost a race to the same address; try the next suffix.
      if (err instanceof Error && err.message === 'Email already in use') continue;
      throw err;
    }
  }
  throw new EmailAccountError('Could not find a free study address for this account', 409);
}
