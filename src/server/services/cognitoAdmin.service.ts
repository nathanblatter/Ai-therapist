// Admin client for the study's Cognito user pool (ai-therapist-396): the calls
// accounts.service.ts makes to keep a pool account in step with its local
// `users` row. Sign-in and token verification live in cognito.service.ts; this
// module only creates, re-passwords, re-roles, deletes and looks up pool users.
//
//  * Pool users are addressed by USERNAME, which is the local username (the
//    pool is created with case-sensitive usernames, like the app's).
//  * A user is created with the invitation suppressed and a permanent password
//    set straight away: participants have no email, so nothing is ever sent
//    and no email attribute is written.
//  * A user sits in exactly one role group (the group is named after the app
//    role; cognito.service.ts refuses a sign-in with none or more than one).
//  * Credentials come from the AWS SDK's default chain (an instance or
//    container role, or AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY in the
//    environment), as the crisis SMS client does. The identity needs
//    scripts/cognito/iam-app-policy.json and nothing more: every action used
//    here is listed there.
//
// Status: written against the SDK's types and exercised over a mocked client
// only. Nothing here has run against a real pool.
import {
  CognitoIdentityProviderClient,
  AdminCreateUserCommand,
  AdminSetUserPasswordCommand,
  AdminAddUserToGroupCommand,
  AdminRemoveUserFromGroupCommand,
  AdminListGroupsForUserCommand,
  AdminDeleteUserCommand,
  AdminGetUserCommand,
  type AttributeType,
} from '@aws-sdk/client-cognito-identity-provider';
import { USER_ROLES } from '../../shared/roles.js';
import { createLogger } from '../utils/logger.js';
import * as cognito from './cognito.service.js';

const log = createLogger('cognitoAdmin');

const REQUEST_TIMEOUT_MS = 10_000;
const CONNECTION_TIMEOUT_MS = 5_000;

export type CognitoAdminErrorCode = 'username_taken' | 'user_not_found' | 'password_rejected' | 'failed';

/** A refused or failed pool call. Carries the AWS exception name and, except
 *  for password calls, its message. Never the request: a password must not
 *  reach a log line through this error. */
export class CognitoAdminError extends Error {
  constructor(
    public readonly code: CognitoAdminErrorCode,
    public readonly operation: string,
    public readonly awsName: string,
    public readonly detail = '',
    public readonly requestId = '',
  ) {
    super(`cognito ${operation} ${awsName}${detail ? `: ${detail}` : ''}`);
    this.name = 'CognitoAdminError';
  }
}

/** The one method of the SDK client this module uses; tests swap it. */
interface Sender {
  send(command: unknown): Promise<unknown>;
}

let client: Sender | null = null;

function getClient(): Sender {
  if (!client) {
    client = new CognitoIdentityProviderClient({
      region: cognito.REGION,
      // One retry at most: an account form is waiting on the answer.
      maxAttempts: 2,
      requestHandler: { requestTimeout: REQUEST_TIMEOUT_MS, connectionTimeout: CONNECTION_TIMEOUT_MS },
    }) as unknown as Sender;
  }
  return client;
}

/** Test seam: replace (or with null, reset) the SDK client. */
export function _setClient(c: Sender | null): void {
  client = c;
}

interface AwsErrorShape {
  name?: unknown;
  message?: unknown;
  $metadata?: { requestId?: unknown };
}

interface CallOptions {
  /** The call carries a password: keep AWS's message out of the error (a
   *  validation message can quote the rejected value), and read a parameter
   *  rejection as a rejected password. */
  password?: boolean;
}

async function call<T>(operation: string, command: unknown, options: CallOptions = {}): Promise<T> {
  try {
    return (await getClient().send(command)) as T;
  } catch (err) {
    const e = (err ?? {}) as AwsErrorShape;
    const awsName = typeof e.name === 'string' && e.name ? e.name : 'UnknownError';
    const requestId = typeof e.$metadata?.requestId === 'string' ? e.$metadata.requestId : '';
    const detail = !options.password && typeof e.message === 'string' ? e.message : '';
    let code: CognitoAdminErrorCode = 'failed';
    if (awsName === 'UsernameExistsException') code = 'username_taken';
    else if (awsName === 'UserNotFoundException') code = 'user_not_found';
    else if (awsName === 'InvalidPasswordException' || awsName === 'PasswordHistoryPolicyViolationException') {
      code = 'password_rejected';
    } else if (options.password && awsName === 'InvalidParameterException') {
      code = 'password_rejected';
    }
    throw new CognitoAdminError(code, operation, awsName, detail, requestId);
  }
}

function assertRole(role: string): void {
  if (!(USER_ROLES as readonly string[]).includes(role)) {
    throw new CognitoAdminError('failed', 'role', 'UnknownRole', `no role group is named "${role}"`);
  }
}

function subFrom(attributes: AttributeType[] | undefined): string | null {
  const sub = attributes?.find((a) => a.Name === 'sub')?.Value;
  return sub ? sub : null;
}

function target(username: string): { UserPoolId: string; Username: string } {
  return { UserPoolId: cognito.USER_POOL_ID, Username: username };
}

/** The pool subject of a username, or null when the pool has no such user. */
export async function getUserSub(username: string): Promise<string | null> {
  try {
    const out = await call<{ UserAttributes?: AttributeType[] }>(
      'AdminGetUser',
      new AdminGetUserCommand(target(username)),
    );
    return subFrom(out.UserAttributes);
  } catch (err) {
    if (err instanceof CognitoAdminError && err.code === 'user_not_found') return null;
    throw err;
  }
}

/** Set a permanent password (the user is never asked to change it at the
 *  next sign-in). Throws `password_rejected` when the pool will not take it. */
export async function setPassword(username: string, password: string): Promise<void> {
  await call(
    'AdminSetUserPassword',
    new AdminSetUserPasswordCommand({ ...target(username), Password: password, Permanent: true }),
    { password: true },
  );
}

async function listGroups(username: string): Promise<string[]> {
  const names: string[] = [];
  let nextToken: string | undefined;
  do {
    const out = await call<{ Groups?: { GroupName?: string }[]; NextToken?: string }>(
      'AdminListGroupsForUser',
      new AdminListGroupsForUserCommand({ ...target(username), NextToken: nextToken }),
    );
    for (const g of out.Groups ?? []) if (g.GroupName) names.push(g.GroupName);
    nextToken = out.NextToken || undefined;
  } while (nextToken);
  return names;
}

/** Put the user in the role's group and take them out of every other role
 *  group. Groups that are not app roles are left alone. The new group is
 *  added before the old one is removed: if the second step fails the account
 *  is in two role groups and sign-in refuses it (never the old role alone
 *  with the change reported as made). Running it again finishes the job. */
export async function setRole(username: string, role: string): Promise<void> {
  assertRole(role);
  const current = await listGroups(username);
  if (!current.includes(role)) {
    await call('AdminAddUserToGroup', new AdminAddUserToGroupCommand({ ...target(username), GroupName: role }));
  }
  for (const group of current) {
    if (group === role || !(USER_ROLES as readonly string[]).includes(group)) continue;
    await call(
      'AdminRemoveUserFromGroup',
      new AdminRemoveUserFromGroupCommand({ ...target(username), GroupName: group }),
    );
  }
}

/** Delete the pool user. Throws `user_not_found` when there is none. */
export async function deleteUser(username: string): Promise<void> {
  await call('AdminDeleteUser', new AdminDeleteUserCommand(target(username)));
}

/** Create a pool user that can sign in at once: no invitation, a permanent
 *  password, one role group. Returns the user's subject (null if the pool did
 *  not report one; the first sign-in links the row by username anyway).
 *
 *  A user that was created but could not be given its password or its group
 *  is deleted again, so no account with a temporary password or without a
 *  role is left in the pool. `username_taken` means the pool already had the
 *  username: that user is someone else's and is not touched. */
export async function createUser(username: string, password: string, role: string): Promise<{ sub: string | null }> {
  assertRole(role);
  const created = await call<{ User?: { Attributes?: AttributeType[] } }>(
    'AdminCreateUser',
    new AdminCreateUserCommand({ ...target(username), MessageAction: 'SUPPRESS' }),
  );
  try {
    await setPassword(username, password);
    await call('AdminAddUserToGroup', new AdminAddUserToGroupCommand({ ...target(username), GroupName: role }));
  } catch (err) {
    try {
      await deleteUser(username);
    } catch (cleanupErr) {
      if (!(cleanupErr instanceof CognitoAdminError && cleanupErr.code === 'user_not_found')) {
        log.error(
          { err: cleanupErr, username },
          'could not delete a half-created pool user; it has no usable sign-in and must be removed by hand',
        );
      }
    }
    throw err;
  }
  let sub = subFrom(created.User?.Attributes);
  if (!sub) {
    // The account is complete; only the link is missing, and the first
    // sign-in makes it. Not worth failing the creation over.
    sub = await getUserSub(username).catch((err: unknown) => {
      log.warn({ err, username }, 'could not read the subject of a new pool user');
      return null;
    });
  }
  return { sub };
}
