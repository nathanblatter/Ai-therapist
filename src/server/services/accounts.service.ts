// Account lifecycle with Squawk in the loop (auth-service-33). Every flow that
// creates, re-passwords, re-roles or deletes a user goes through here so the
// Squawk copy of the account never drifts from the local row. With Squawk
// disabled (local dev, tests) these are thin wrappers over the db module.
//
// Ordering: the local row is written first and the Squawk call second; a
// Squawk failure on creation rolls the local row back so the person can
// retry, while a failure on update/delete is logged and surfaced (the local
// change stands, and the next login re-syncs the role from Squawk).
import {
  createUser,
  updateUser,
  deleteUser,
  getUserById,
  setSquawkUserId,
  type CreateUserOptions,
  type UserRow,
} from '../db/index.js';
import * as squawk from './squawk.service.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('accounts');

export class AccountSyncError extends Error {
  constructor(
    message: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'AccountSyncError';
  }
}

/** Create the local row and, when Squawk is on, the matching password account
 *  there (same username, same password, the role as its Squawk role). */
export async function registerAccount(
  username: string,
  password: string,
  role: string,
  options?: CreateUserOptions,
): Promise<UserRow> {
  const user = options
    ? await createUser(username, password, role, options)
    : await createUser(username, password, role);
  if (!squawk.enabled()) return user;
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

/** Update the local row, then mirror password and role changes to Squawk.
 *  Usernames cannot change once an account lives in Squawk (they are its
 *  identity): refused up front rather than left to drift. */
export async function updateAccount(userid: number | string, updates: AccountUpdates): Promise<UserRow> {
  const current = squawk.enabled() ? await getUserById(userid) : null;
  const linked = current?.squawk_user_id ?? null;
  if (linked && updates.username !== undefined && updates.username !== current?.username) {
    throw new Error('Username cannot be changed');
  }
  const updated = await updateUser(userid, updates as Record<string, string>);
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

/** Delete locally, then in Squawk (its refresh tokens stop working). */
export async function removeAccount(userid: number | string): Promise<UserRow> {
  const current = squawk.enabled() ? await getUserById(userid) : null;
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
