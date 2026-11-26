// Pool admin client (ai-therapist-396) over a mocked SDK client: no network,
// no pool. These pin the calls the module makes and how it reads AWS's
// refusals; whether a real pool answers the same way is still unproven.
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';

vi.mock('./cognito.service.js', () => ({
  REGION: 'us-west-1',
  USER_POOL_ID: 'us-west-1_TestPool1',
}));

const admin = await import('./cognitoAdmin.service.js');

const POOL = 'us-west-1_TestPool1';

type Handler = (input: Record<string, unknown>) => unknown;

/** Calls made, in order, as "CommandName" plus the command's input. */
let calls: { name: string; input: Record<string, unknown> }[] = [];
let handlers: Record<string, Handler> = {};

function awsError(name: string, message = 'boom'): Error {
  return Object.assign(new Error(message), { name, $metadata: { requestId: 'req-1' } });
}

function names(): string[] {
  return calls.map((c) => c.name);
}

beforeEach(() => {
  calls = [];
  handlers = {};
  admin._setClient({
    send: async (command: unknown) => {
      const c = command as { constructor: { name: string }; input: Record<string, unknown> };
      const name = c.constructor.name.replace(/Command$/, '');
      calls.push({ name, input: c.input });
      const handler = handlers[name];
      return handler ? handler(c.input) : {};
    },
  });
});

afterAll(() => admin._setClient(null));

describe('createUser', () => {
  it('creates with the invitation suppressed, sets a permanent password, adds the one role group', async () => {
    handlers.AdminCreateUser = () => ({
      User: { Username: 'p_one', Attributes: [{ Name: 'sub', Value: 'sub-123' }] },
    });
    const out = await admin.createUser('p_one', 'a long passphrase', 'participant');
    expect(out).toEqual({ sub: 'sub-123' });
    expect(names()).toEqual(['AdminCreateUser', 'AdminSetUserPassword', 'AdminAddUserToGroup']);
    // No email, no temporary password, nothing sent.
    expect(calls[0].input).toEqual({ UserPoolId: POOL, Username: 'p_one', MessageAction: 'SUPPRESS' });
    expect(calls[1].input).toEqual({
      UserPoolId: POOL,
      Username: 'p_one',
      Password: 'a long passphrase',
      Permanent: true,
    });
    expect(calls[2].input).toEqual({ UserPoolId: POOL, Username: 'p_one', GroupName: 'participant' });
  });

  it('reads the subject with AdminGetUser when the create answer has none', async () => {
    handlers.AdminGetUser = () => ({ UserAttributes: [{ Name: 'sub', Value: 'sub-456' }] });
    const out = await admin.createUser('p_two', 'a long passphrase', 'therapist');
    expect(out).toEqual({ sub: 'sub-456' });
    expect(names()).toEqual(['AdminCreateUser', 'AdminSetUserPassword', 'AdminAddUserToGroup', 'AdminGetUser']);
  });

  it('still succeeds, without a subject, when the subject cannot be read', async () => {
    handlers.AdminGetUser = () => {
      throw awsError('InternalErrorException');
    };
    await expect(admin.createUser('p_two', 'a long passphrase', 'therapist')).resolves.toEqual({ sub: null });
    expect(names()).not.toContain('AdminDeleteUser');
  });

  it('maps a username the pool already has, and does not touch that user', async () => {
    handlers.AdminCreateUser = () => {
      throw awsError('UsernameExistsException', 'User account already exists');
    };
    await expect(admin.createUser('taken', 'a long passphrase', 'participant')).rejects.toMatchObject({
      name: 'CognitoAdminError',
      code: 'username_taken',
      awsName: 'UsernameExistsException',
      requestId: 'req-1',
    });
    expect(names()).toEqual(['AdminCreateUser']);
  });

  it('deletes the half-created user when the password cannot be set', async () => {
    handlers.AdminSetUserPassword = () => {
      throw awsError('InternalErrorException');
    };
    await expect(admin.createUser('half', 'a long passphrase', 'participant')).rejects.toMatchObject({
      code: 'failed',
      operation: 'AdminSetUserPassword',
    });
    expect(names()).toEqual(['AdminCreateUser', 'AdminSetUserPassword', 'AdminDeleteUser']);
    expect(calls[2].input).toEqual({ UserPoolId: POOL, Username: 'half' });
  });

  it('deletes the half-created user when the role group cannot be added', async () => {
    handlers.AdminAddUserToGroup = () => {
      throw awsError('ResourceNotFoundException', 'Group not found.');
    };
    await expect(admin.createUser('half', 'a long passphrase', 'participant')).rejects.toMatchObject({
      code: 'failed',
      operation: 'AdminAddUserToGroup',
    });
    expect(names()).toEqual(['AdminCreateUser', 'AdminSetUserPassword', 'AdminAddUserToGroup', 'AdminDeleteUser']);
  });

  it('reports the original failure when the cleanup delete fails too', async () => {
    handlers.AdminSetUserPassword = () => {
      throw awsError('InvalidPasswordException');
    };
    handlers.AdminDeleteUser = () => {
      throw awsError('TooManyRequestsException');
    };
    await expect(admin.createUser('half', 'a long passphrase', 'participant')).rejects.toMatchObject({
      code: 'password_rejected',
    });
    expect(names()).toContain('AdminDeleteUser');
  });

  it('refuses a role with no group before calling the pool', async () => {
    await expect(admin.createUser('x', 'a long passphrase', 'superuser')).rejects.toMatchObject({ code: 'failed' });
    expect(calls).toEqual([]);
  });
});

describe('setPassword', () => {
  it('sets a permanent password', async () => {
    await admin.setPassword('p_one', 'another passphrase');
    expect(calls).toEqual([
      {
        name: 'AdminSetUserPassword',
        input: { UserPoolId: POOL, Username: 'p_one', Password: 'another passphrase', Permanent: true },
      },
    ]);
  });

  it.each(['InvalidPasswordException', 'PasswordHistoryPolicyViolationException', 'InvalidParameterException'])(
    'reads %s as a rejected password and keeps the AWS message out of the error',
    async (awsName) => {
      handlers.AdminSetUserPassword = () => {
        throw awsError(awsName, "Value 'hunter2 hunter2' at 'password' failed to satisfy constraint");
      };
      const err = await admin.setPassword('p_one', 'hunter2 hunter2').catch((e: unknown) => e);
      expect(err).toMatchObject({ code: 'password_rejected', awsName, detail: '' });
      expect(String((err as Error).message)).not.toContain('hunter2');
    },
  );

  it('maps a user the pool does not have', async () => {
    handlers.AdminSetUserPassword = () => {
      throw awsError('UserNotFoundException');
    };
    await expect(admin.setPassword('ghost', 'another passphrase')).rejects.toMatchObject({ code: 'user_not_found' });
  });
});

describe('setRole', () => {
  it('adds the new role group, then removes the old one', async () => {
    handlers.AdminListGroupsForUser = () => ({ Groups: [{ GroupName: 'participant' }] });
    await admin.setRole('p_one', 'therapist');
    expect(names()).toEqual(['AdminListGroupsForUser', 'AdminAddUserToGroup', 'AdminRemoveUserFromGroup']);
    expect(calls[1].input).toEqual({ UserPoolId: POOL, Username: 'p_one', GroupName: 'therapist' });
    expect(calls[2].input).toEqual({ UserPoolId: POOL, Username: 'p_one', GroupName: 'participant' });
  });

  it('leaves exactly one role group when the user was in several, and leaves other groups alone', async () => {
    handlers.AdminListGroupsForUser = () => ({
      Groups: [{ GroupName: 'participant' }, { GroupName: 'researcher' }, { GroupName: 'beta-testers' }],
    });
    await admin.setRole('p_one', 'researcher');
    const removed = calls.filter((c) => c.name === 'AdminRemoveUserFromGroup').map((c) => c.input.GroupName);
    expect(removed).toEqual(['participant']);
    expect(names()).not.toContain('AdminAddUserToGroup');
  });

  it('adds the group for a user who has none', async () => {
    await admin.setRole('p_one', 'participant');
    expect(names()).toEqual(['AdminListGroupsForUser', 'AdminAddUserToGroup']);
  });

  it('follows the group listing across pages', async () => {
    handlers.AdminListGroupsForUser = (input) =>
      input.NextToken
        ? { Groups: [{ GroupName: 'demo' }] }
        : { Groups: [{ GroupName: 'participant' }], NextToken: 't2' };
    await admin.setRole('p_one', 'therapist');
    const removed = calls.filter((c) => c.name === 'AdminRemoveUserFromGroup').map((c) => c.input.GroupName);
    expect(removed).toEqual(['participant', 'demo']);
  });

  it('surfaces a failed removal after the new group was added', async () => {
    handlers.AdminListGroupsForUser = () => ({ Groups: [{ GroupName: 'participant' }] });
    handlers.AdminRemoveUserFromGroup = () => {
      throw awsError('TooManyRequestsException');
    };
    await expect(admin.setRole('p_one', 'therapist')).rejects.toMatchObject({
      code: 'failed',
      operation: 'AdminRemoveUserFromGroup',
    });
  });

  it('refuses a role with no group before calling the pool', async () => {
    await expect(admin.setRole('p_one', 'superuser')).rejects.toMatchObject({ code: 'failed' });
    expect(calls).toEqual([]);
  });
});

describe('deleteUser and getUserSub', () => {
  it('deletes by username', async () => {
    await admin.deleteUser('p_one');
    expect(calls).toEqual([{ name: 'AdminDeleteUser', input: { UserPoolId: POOL, Username: 'p_one' } }]);
  });

  it('maps a delete of a user the pool does not have', async () => {
    handlers.AdminDeleteUser = () => {
      throw awsError('UserNotFoundException', 'User does not exist.');
    };
    await expect(admin.deleteUser('ghost')).rejects.toMatchObject({
      code: 'user_not_found',
      detail: 'User does not exist.',
    });
  });

  it('reads the subject, and answers null for a user the pool does not have', async () => {
    handlers.AdminGetUser = (input) => {
      if (input.Username === 'ghost') throw awsError('UserNotFoundException');
      return { UserAttributes: [{ Name: 'sub', Value: 'sub-789' }] };
    };
    await expect(admin.getUserSub('p_one')).resolves.toBe('sub-789');
    await expect(admin.getUserSub('ghost')).resolves.toBeNull();
  });

  it('passes other lookup failures on', async () => {
    handlers.AdminGetUser = () => {
      throw awsError('NotAuthorizedException');
    };
    await expect(admin.getUserSub('p_one')).rejects.toMatchObject({ code: 'failed' });
  });
});
