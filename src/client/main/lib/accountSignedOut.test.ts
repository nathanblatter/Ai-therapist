// The participant page's "you have been signed out" notice: what it says for
// each reason the server sends, and that a notice is never lost between the
// socket that hears it and the app that shows it.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  _resetAccountSignedOutForTests,
  onAccountSignedOut,
  toAccountSignedOutNotice,
  watchAccountSignedOut,
} from './accountSignedOut';
import {
  ACCOUNT_CHANGED_END_REASON,
  ACCOUNT_SIGNED_OUT_EVENT,
  accountSignedOutMessage,
  canSignInAgain,
} from '../../../shared/accountSignedOut';

/** A socket that records its listeners and lets the test fire them. */
function fakeSocket() {
  const listeners = new Map<string, (data: unknown) => void>();
  return {
    on: vi.fn((event: string, listener: (data: unknown) => void) => {
      listeners.set(event, listener);
    }),
    fire: (event: string, data: unknown) => listeners.get(event)?.(data),
  };
}

beforeEach(() => _resetAccountSignedOutForTests());

describe('the wording', () => {
  it('names what happened for each reason, and never shows a code', () => {
    expect(accountSignedOutMessage('role_changed')).toMatch(/changed your account.*signed out.*sign in again/i);
    expect(accountSignedOutMessage('account_deleted')).toMatch(/removed this account.*signed out/i);
    expect(accountSignedOutMessage('authenticator_reset')).toMatch(/authenticator app.*sign in again/i);
    for (const reason of ['role_changed', 'account_deleted', 'authenticator_reset', 'something_new', undefined]) {
      expect(accountSignedOutMessage(reason)).not.toMatch(/_/);
    }
  });

  it('an unknown or missing reason gets the general wording', () => {
    expect(accountSignedOutMessage('something_new')).toBe(accountSignedOutMessage(undefined));
    expect(accountSignedOutMessage(null)).toMatch(/signed out/);
    // An inherited property name is not a reason.
    expect(accountSignedOutMessage('toString')).toBe(accountSignedOutMessage(undefined));
  });

  it('a deleted account is not invited to sign in again', () => {
    expect(canSignInAgain('account_deleted')).toBe(false);
    expect(canSignInAgain('role_changed')).toBe(true);
    expect(accountSignedOutMessage('account_deleted')).not.toMatch(/sign in again/i);
  });

  it('the session end reason is the documented one', () => {
    expect(ACCOUNT_CHANGED_END_REASON).toBe('account_changed');
  });
});

describe('toAccountSignedOutNotice', () => {
  it('chooses the wording from the reason and ignores any text the event carried', () => {
    expect(toAccountSignedOutNotice({ reason: 'role_changed', message: '<b>anything</b>' })).toEqual({
      reason: 'role_changed',
      message: accountSignedOutMessage('role_changed'),
      canSignIn: true,
    });
  });

  it('copes with an empty or malformed event', () => {
    for (const data of [undefined, null, 'x', 7, {}, { reason: 7 }]) {
      expect(toAccountSignedOutNotice(data)).toEqual({
        reason: null,
        message: accountSignedOutMessage(undefined),
        canSignIn: true,
      });
    }
  });
});

describe('from a socket to the app', () => {
  it('delivers the notice to the registered handler', () => {
    const socket = fakeSocket();
    const handler = vi.fn();
    watchAccountSignedOut(socket);
    onAccountSignedOut(handler);
    expect(socket.on).toHaveBeenCalledWith(ACCOUNT_SIGNED_OUT_EVENT, expect.any(Function));
    socket.fire(ACCOUNT_SIGNED_OUT_EVENT, { reason: 'account_deleted' });
    expect(handler).toHaveBeenCalledExactlyOnceWith({
      reason: 'account_deleted',
      message: accountSignedOutMessage('account_deleted'),
      canSignIn: false,
    });
  });

  it('keeps a notice that arrives before the app is listening, and delivers it once', () => {
    const socket = fakeSocket();
    watchAccountSignedOut(socket);
    socket.fire(ACCOUNT_SIGNED_OUT_EVENT, { reason: 'role_changed' });
    socket.fire(ACCOUNT_SIGNED_OUT_EVENT, { reason: 'account_deleted' });
    const handler = vi.fn();
    onAccountSignedOut(handler);
    expect(handler).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ reason: 'role_changed' }));
    const later = vi.fn();
    onAccountSignedOut(later);
    expect(later).not.toHaveBeenCalled();
  });

  it('an unregistered handler hears nothing more', () => {
    const socket = fakeSocket();
    watchAccountSignedOut(socket);
    const handler = vi.fn();
    const off = onAccountSignedOut(handler);
    off();
    socket.fire(ACCOUNT_SIGNED_OUT_EVENT, { reason: 'role_changed' });
    expect(handler).not.toHaveBeenCalled();
  });
});
