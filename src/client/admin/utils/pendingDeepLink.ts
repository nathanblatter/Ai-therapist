// Carry a crisis page's admin deep link across sign-in.
//
// A page links to /admin#session=<id> or /admin#participant=<id>. Signed out,
// the server sends that page load to /login (signedOutPageToLogin in
// src/server/middleware/auth.ts) and the browser keeps the hash on /login. The
// hash never reaches the server, and the Squawk flow leaves the app for
// Squawk's authorize endpoint, so the sign-in page keeps it in this tab's
// sessionStorage and the admin page puts it back once, before AdminApp reads it.
//
// Only the two exact forms the pages send are carried, rebuilt from what the
// deepLink.ts parsers extract (never the raw string), and only ever restored
// as the hash of the admin page the browser is already on: there is no URL,
// path or origin in what is stored, so nothing here can redirect anywhere.
import { participantFromHash, sessionFromHash } from './deepLink';

export const PENDING_DEEP_LINK_KEY = 'admin.pendingDeepLink';
/** Long enough for a sign-in (Squawk round trip, a passkey prompt), short
 *  enough that a link from an old page does not open hours later. */
export const PENDING_DEEP_LINK_TTL_MS = 15 * 60 * 1000;
/** Far above any real link (`#session=` + 128 is 137 characters). */
export const MAX_DEEP_LINK_HASH_LENGTH = 160;

const SESSION_FORM = /^#session=[^&#]+$/;
const PARTICIPANT_FORM = /^#participant=[^&#]+$/;

type StorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

/** The canonical `#session=<id>` / `#participant=<id>` for a hash that is
 *  exactly one of those forms with a valid id, or null. */
export function canonicalDeepLink(hash: unknown): string | null {
  if (typeof hash !== 'string' || hash.length > MAX_DEEP_LINK_HASH_LENGTH) return null;
  if (SESSION_FORM.test(hash)) {
    const session = sessionFromHash(hash);
    return session === null ? null : `#session=${session}`;
  }
  if (PARTICIPANT_FORM.test(hash)) {
    const participant = participantFromHash(hash);
    return participant === null ? null : `#participant=${participant}`;
  }
  return null;
}

/**
 * Sign-in page, on load: remember a valid deep-link hash. Anything else is
 * ignored and leaves a stored link alone (Squawk returns to /login without a
 * hash). Returns what was stored, or null.
 */
export function savePendingDeepLink(storage: StorageLike, hash: string, now: number): string | null {
  const link = canonicalDeepLink(hash);
  if (link === null) return null;
  try {
    storage.setItem(PENDING_DEEP_LINK_KEY, JSON.stringify({ hash: link, savedAt: now }));
  } catch {
    return null;
  }
  return link;
}

/**
 * Admin page, before AdminApp renders: take the stored link (always removing
 * it, so it is used at most once) and, if it is still valid and fresh and the
 * page has no hash of its own, put it on the current URL. Returns the hash
 * restored, or null.
 */
export function restorePendingDeepLink(
  storage: StorageLike,
  location: { pathname: string; search: string; hash: string },
  now: number,
  replaceUrl: (url: string) => void,
): string | null {
  let raw: string | null = null;
  try {
    raw = storage.getItem(PENDING_DEEP_LINK_KEY);
    storage.removeItem(PENDING_DEEP_LINK_KEY);
  } catch {
    return null;
  }
  if (raw === null || location.pathname !== '/admin' || location.hash !== '') return null;
  let stored: unknown;
  try {
    stored = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof stored !== 'object' || stored === null) return null;
  const { hash, savedAt } = stored as { hash?: unknown; savedAt?: unknown };
  const link = canonicalDeepLink(hash);
  if (link === null || typeof savedAt !== 'number') return null;
  // Written this way round so a NaN age (never produced by JSON) is refused too.
  const age = now - savedAt;
  if (!(age >= 0 && age <= PENDING_DEEP_LINK_TTL_MS)) return null;
  replaceUrl(location.pathname + location.search + link);
  return link;
}
