// Deep link from a crisis page to a participant's profile (the URL hash).
//
// /admin#participant=<user id> is what a page carries when its session was
// never stored (a chat start that failed after its check-in was screened,
// ai-therapist-373): there is no session to open, so the link opens the
// participant. Sessions keep /admin#session=<id> (AdminApp).

/** The participant (users.userid) in a deep-link hash, or null. */
export function participantFromHash(hash: string): number | null {
  const match = /[#&]participant=(\d+)(?:&|$)/.exec(hash);
  if (!match) return null;
  const id = Number(match[1]);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}
