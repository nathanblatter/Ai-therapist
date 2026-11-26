// Account lifecycle with the sign-in provider in the loop (auth-service-33 for
// Squawk, ai-therapist-396 for Cognito). Every flow that creates, re-passwords,
// re-roles or deletes a user goes through here so the provider's copy of the
// account never drifts from the local row. With no provider configured (local
// dev, tests, CI) these are thin wrappers over the db module.
//
// One provider is mirrored to, never both: Cognito when its variables are set,
// otherwise Squawk when its are (the login page makes the same choice).
//
// Ordering: the local row is written first and the provider call second; a
// provider failure on creation rolls the local row back so the person can
// retry, while a failure on update/delete is logged and surfaced (the local
// change stands, and the next login re-syncs the role from the provider).
//
// The two providers find an account differently. Squawk accounts are found by
// users.squawk_user_id. Pool accounts are found by username: a pool user and
// its row share one, and the row's cognito_sub is only filled in at creation
// or on the first sign-in.
import {
  createUser,
  updateUser,
  deleteUser,
  getUserById,
  setSquawkUserId,
  setCognitoSub,
  type CreateUserOptions,
  type UserRow,
} from '../db/index.js';
import * as squawk from './squawk.service.js';
import * as cognito from './cognito.service.js';
import * as cognitoAdmin from './cognitoAdmin.service.js';
import { clearEmailIfIneligible } from './researcherEmail.service.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('accounts');

export class AccountSyncError extends Error {
  constructor(
    message: string,
    public readonly cause?: unknown,
    /** Set when the provider refused the password itself (the person can fix
     *  that by choosing another); routes answer 400 instead of 502. */
    public readonly code?: 'password_rejected',
  ) {
    super(message);
    this.name = 'AccountSyncError';
  }
}

export const PASSWORD_REJECTED_MESSAGE = 'The sign-in service did not accept this password. Choose a different one.';

/** Which provider account changes are mirrored to. Cognito wins when both are
 *  configured; they are never both written. */
function provider(): 'cognito' | 'squawk' | null {
  if (cognito.enabled()) return 'cognito';
  if (squawk.enabled()) return 'squawk';
  return null;
}

function isPoolError(err: unknown, code: cognitoAdmin.CognitoAdminErrorCode): boolean {
  return err instanceof cognitoAdmin.CognitoAdminError && err.code === code;
}

/** Create the pool user for a row that was just inserted. Any failure removes
 *  the row again (cognitoAdmin.createUser has already removed a half-made pool
 *  user), so the same username can be tried again. */
async function registerInPool(user: UserRow, username: string, password: string, role: string): Promise<UserRow> {
  let sub: string | null;
  try {
    ({ sub } = await cognitoAdmin.createUser(username, password, role));
  } catch (err) {
    log.error({ err, username }, 'Cognito account creation failed; rolling back the local row');
    await deleteUser(user.userid).catch((e: unknown) =>
      log.error({ err: e, userid: user.userid }, 'local rollback failed'),
    );
    if (isPoolError(err, 'username_taken')) throw new Error('Username already exists');
    if (isPoolError(err, 'password_rejected')) {
      throw new AccountSyncError(PASSWORD_REJECTED_MESSAGE, err, 'password_rejected');
    }
    throw new AccountSyncError('Sign-in service rejected the new account', err);
  }
  if (!sub) return user;
  try {
    await setCognitoSub(user.userid, sub);
  } catch (err) {
    // Both accounts exist and match by username; the first sign-in records
    // the link. Undoing a finished account over it would be worse.
    log.warn({ err, userid: user.userid }, 'could not record the pool subject; the first sign-in will');
    return user;
  }
  return { ...user, cognito_sub: sub };
}

/** Create the local row and, when a provider is on, the matching password
 *  account there (same username, same password; the role as its Squawk role
 *  or its Cognito role group). */
export async function registerAccount(
  username: string,
  password: string,
  role: string,
  options?: CreateUserOptions,
): Promise<UserRow> {
  const user = options
    ? await createUser(username, password, role, options)
    : await createUser(username, password, role);
  const via = provider();
  if (via === null) return user;
  if (via === 'cognito') return registerInPool(user, username, password, role);
  try {
    const remote = await squawk.createPasswordUser(username, password, role);
    await setSquawkUserId(user.userid, remote.id);
    return { ...user, squawk_user_id: remote.id };
  } catch (err) {
    log.error({ err, username }, 'Squawk account creation failed; rolling back the local row');
    await deleteUser(user.userid).catch((e: unknown) =>
      log.error({ err: e, userid: user.userid }, 'local rollback failed'),
    );
    if (err instanceof squawk.SquawkError && err.code === 'identity_taken') {
      throw new Error('Username already exists');
    }
    throw new AccountSyncError('Sign-in service rejected the new account', err);
  }
}

export interface AccountUpdates {
  username?: string;
  password?: string;
  role?: string;
}

/** Update the local row, then mirror password and role changes to the pool.
 *  A pool user's username can never change, so a rename is refused while the
 *  pool is the provider. An account the pool does not have (one that existed
 *  before the pool and was never moved, a demo or seeded account) cannot be
 *  mirrored: that is surfaced, not hidden, because the password just set will
 *  not sign anyone in. */
async function updateInPool(userid: number | string, updates: AccountUpdates): Promise<UserRow> {
  const current = await getUserById(userid);
  if (current && updates.username !== undefined && updates.username !== current.username) {
    throw new Error('Username cannot be changed');
  }
  const updated = await updateUser(userid, updates as Record<string, string>);
  if (updates.role !== undefined) await clearEmailIfIneligible(userid, updates.role);
  if (updates.password === undefined && updates.role === undefined) return updated;
  const username = current?.username ?? updated.username;
  try {
    if (updates.password !== undefined) await cognitoAdmin.setPassword(username, updates.password);
    if (updates.role !== undefined) await cognitoAdmin.setRole(username, updates.role);
  } catch (err) {
    log.error({ err, userid }, 'Cognito account update failed; the local change stands');
    if (isPoolError(err, 'password_rejected')) {
      throw new AccountSyncError(PASSWORD_REJECTED_MESSAGE, err, 'password_rejected');
    }
    if (isPoolError(err, 'user_not_found')) {
      throw new AccountSyncError('This account does not exist in the sign-in service', err);
    }
    throw new AccountSyncError('Sign-in service rejected the change', err);
  }
  return updated;
}

/** Update the local row, then mirror password and role changes to the
 *  provider. Usernames cannot change once an account lives in Squawk (they
 *  are its identity): refused up front rather than left to drift. */
export async function updateAccount(userid: number | string, updates: AccountUpdates): Promise<UserRow> {
  const via = provider();
  if (via === 'cognito') return updateInPool(userid, updates);
  const current = via === 'squawk' ? await getUserById(userid) : null;
  const linked = current?.squawk_user_id ?? null;
  if (linked && updates.username !== undefined && updates.username !== current?.username) {
    throw new Error('Username cannot be changed');
  }
  const updated = await updateUser(userid, updates as Record<string, string>);
  // Leaving the staff roles drops the account's email (participants are
  // anonymous; ai-therapist-283).
  if (updates.role !== undefined) await clearEmailIfIneligible(userid, updates.role);
  if (!linked) return updated;
  try {
    if (updates.password !== undefined) await squawk.setPassword(linked, updates.password);
    if (updates.role !== undefined) await squawk.setRole(linked, updates.role);
  } catch (err) {
    log.error({ err, userid }, 'Squawk account update failed');
    throw new AccountSyncError('Sign-in service rejected the change', err);
  }
  return updated;
}

/** Delete locally, then in the pool. A pool user that could not be deleted is
 *  surfaced: it would keep its password and block the username from being
 *  registered again. An account the pool never had is not an error. */
async function removeFromPool(userid: number | string): Promise<UserRow> {
  const deleted = await deleteUser(userid);
  try {
    await cognitoAdmin.deleteUser(deleted.username);
  } catch (err) {
    if (isPoolError(err, 'user_not_found')) return deleted;
    log.error({ err, userid, username: deleted.username }, 'Cognito account deletion failed; the local row is gone');
    throw new AccountSyncError(
      'The account was deleted here, but its sign-in could not be removed from the sign-in service',
      err,
    );
  }
  return deleted;
}

/** Delete locally, then at the provider (in Squawk its refresh tokens stop
 *  working). */
export async function removeAccount(userid: number | string): Promise<UserRow> {
  const via = provider();
  if (via === 'cognito') return removeFromPool(userid);
  const current = via === 'squawk' ? await getUserById(userid) : null;
  const deleted = await deleteUser(userid);
  if (current?.squawk_user_id) {
    try {
      await squawk.deleteUser(current.squawk_user_id);
    } catch (err) {
      if (!(err instanceof squawk.SquawkError && err.status === 404)) {
        log.error(
          { err, userid, squawkUserId: current.squawk_user_id },
          'Squawk account deletion failed; the local row is gone',
        );
      }
    }
  }
  return deleted;
}
