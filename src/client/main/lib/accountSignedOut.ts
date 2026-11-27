// "You have been signed out" for the participant page.
//
// When a researcher changes an account's role or deletes it, the server ends
// that account's sign-in, ends a therapy session it is in the middle of, and
// closes its sockets (accounts.service endSessions). Just before the close it
// sends one event saying why. Every socket this page opens listens for it
// here, and the app shows the reason and a way back to sign-in instead of a
// screen that has silently stopped working.
//
// The socket is not reliable through the tunnel (see participantSocket.ts), so
// this is the explanation when it arrives, not a guarantee that it does.
import { ACCOUNT_SIGNED_OUT_EVENT, accountSignedOutMessage, canSignInAgain } from '../../../shared/accountSignedOut';

export interface AccountSignedOutNotice {
  /** The server's reason code, when it sent a recognisable one. */
  reason: string | null;
  /** Plain words for the person. */
  message: string;
  /** False for a deleted account: there is nothing to sign in to. */
  canSignIn: boolean;
}

type Handler = (notice: AccountSignedOutNotice) => void;

let handler: Handler | null = null;
// A notice that arrived before the app registered (the sockets are created
// independently of the component that shows it).
let undelivered: AccountSignedOutNotice | null = null;

/** The notice for whatever the server sent. The wording is chosen here from
 *  the reason code, so the page never renders a string it was handed. */
export function toAccountSignedOutNotice(data: unknown): AccountSignedOutNotice {
  const raw = data && typeof data === 'object' ? (data as { reason?: unknown }).reason : undefined;
  const reason = typeof raw === 'string' ? raw : null;
  return { reason, message: accountSignedOutMessage(reason), canSignIn: canSignInAgain(reason) };
}

function deliver(notice: AccountSignedOutNotice): void {
  if (handler) handler(notice);
  else undelivered = undelivered ?? notice;
}

/** The one thing needed of a socket here: a way to listen. */
export interface NoticeSource {
  on(event: string, listener: (data: unknown) => void): unknown;
}

/** Listen on one of the page's sockets for the server's sign-out notice. */
export function watchAccountSignedOut(socket: NoticeSource): void {
  socket.on(ACCOUNT_SIGNED_OUT_EVENT, (data: unknown) => deliver(toAccountSignedOutNotice(data)));
}

/** Register the app's handler (one at a time). A notice that already arrived
 *  is delivered at once. Returns the function that unregisters it. */
export function onAccountSignedOut(next: Handler): () => void {
  handler = next;
  if (undelivered) {
    const notice = undelivered;
    undelivered = null;
    next(notice);
  }
  return () => {
    if (handler === next) handler = null;
  };
}

/** Test hook. */
export function _resetAccountSignedOutForTests(): void {
  handler = null;
  undelivered = null;
}
