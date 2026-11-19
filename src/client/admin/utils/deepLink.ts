// Deep link from a crisis page to a participant's profile (the URL hash).
//
// /admin#participant=<user id> is what a page carries when its session was
// never stored (a chat start that failed after its check-in was screened,
// ai-therapist-373): there is no session to open, so the link opens the
// participant. Sessions keep /admin#session=<id> (AdminApp).
//
// What the link opens is decided here, without React, so it can be tested in
// the node test environment (the admin client has no component test setup;
// ai-therapist-374). AdminApp only wires it to its state.

/** The participant (users.userid) in a deep-link hash, or null. */
export function participantFromHash(hash: string): number | null {
  const match = /[#&]participant=(\d+)(?:&|$)/.exec(hash);
  if (!match) return null;
  const id = Number(match[1]);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

/**
 * The session id in a `#session=` hash, or null. Stricter than AdminApp's own
 * read of a direct link: only the characters session ids are made of
 * (`chat_<ms>_<base36>`, `grok_<uuid>`, `sbx-<org>-<n>-<n>`), at most 128.
 * Used where a hash is carried across sign-in (pendingDeepLink.ts).
 */
export function sessionFromHash(hash: string): string | null {
  const match = /[#&]session=([A-Za-z0-9_-]{1,128})(?:&|$)/.exec(hash);
  return match ? match[1] : null;
}

/**
 * On load: open the participant a `#participant=` link names, then drop the
 * hash (keeping path and query) so a reload does not reopen it. A hash with no
 * valid participant id opens nothing and is left as it is. Returns the id
 * opened, or null. `open` is AdminApp's openParticipantProfile: the profile
 * view, whose data comes from the staff-only /admin/api/users/:id/* routes.
 */
export function openParticipantDeepLink(
  location: { hash: string; pathname: string; search: string },
  open: (userId: number) => void,
  replaceUrl: (url: string) => void,
): number | null {
  const participant = participantFromHash(location.hash);
  if (participant === null) return null;
  open(participant);
  replaceUrl(location.pathname + location.search);
  return participant;
}

/**
 * The profile header a participant id opens with before the profile loads:
 * the id, the username when the viewer's caseload lists it, otherwise a label
 * built from the id alone. Nothing else is known or shown until the
 * staff-authenticated profile request answers.
 */
export function participantProfileSummary(
  userId: number,
  knownUsernames: ReadonlyMap<number, string>,
): { userid: number; username: string; role: 'participant' } {
  return { userid: userId, username: knownUsernames.get(userId) ?? `client #${userId}`, role: 'participant' };
}
